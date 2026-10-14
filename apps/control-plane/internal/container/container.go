// Package container runs agents' runtimes on Kubernetes: one long-lived
// Pod per agent, from an image built for it, with its state on a volume
// (PVC) of its own, all in the agents' namespace. Images are built by
// BuildKit and kept in the cluster's registry, which the node pulls from.
// Only the controller drives this.
package container

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/utils/ptr"
)

const (
	agentLabel       = "axp.dev/agent"
	configAnnotation = "axp.dev/config"
	memory           = "2Gi"
	cpus             = "1"
	stopSeconds      = 10
	// The runtime's control API (apps/agent-runtime/src/server.ts).
	controlPort = 8080
	// The volume's mount point, the runtime's AXP_HOME.
	home = "/agent"
	// An image build may download a lot (a bundle's script installs tools).
	buildTimeout = 30 * time.Minute
	// A failed build keeps this much of its output.
	buildOutput = 4000
)

// Spec is an agent's runtime.
type Spec struct {
	AgentID string
	Image   string
	Env     map[string]string
	// What the runtime was created from; a different one replaces it.
	Config string
}

// Runtime is an agent's runtime as it is.
type Runtime struct {
	AgentID string
	Config  string
	// Running or Starting (pulling, starting again after a crash).
	State string
	// The control API, while running.
	URL string
}

const (
	Running  = "running"
	Starting = "starting"
)

// Driver runs agents' runtimes and builds their images.
type Driver interface {
	// List is the agents' runtimes.
	List(ctx context.Context) ([]Runtime, error)
	// Run replaces the agent's runtime (its volume stays) with a new one.
	Run(ctx context.Context, spec Spec) error
	// Remove stops and removes the agent's runtime; its volume stays.
	Remove(ctx context.Context, agentID string) error
	// Base is the digest of the image agents' images are built on, and its
	// name.
	Base(ctx context.Context) (id, ref string, err error)
	// ImageTag is the agent image with this content hash.
	ImageTag(hash string) string
	HasImage(ctx context.Context, tag string) (bool, error)
	// Build builds dir (with its Dockerfile) as tag; a failure returns the
	// end of the build's output.
	Build(ctx context.Context, dir, tag string) (failure string, err error)
	// Prune removes agent images except keep.
	Prune(ctx context.Context, keep []string) error
}

// Kubernetes runs agents as Pods in Namespace and builds their images with
// the BuildKit daemon at BuildKit (buildctl's --addr) into Registry.
type Kubernetes struct {
	Client    kubernetes.Interface
	Namespace string
	Registry  string
	BuildKit  string
	// The runtime image agents' images are built on, in Registry.
	BaseImage string
	HTTP      *http.Client
}

func podName(agentID string) string { return "agent-" + agentID }

func (k *Kubernetes) List(ctx context.Context) ([]Runtime, error) {
	pods, err := k.Client.CoreV1().Pods(k.Namespace).List(ctx, metav1.ListOptions{LabelSelector: agentLabel})
	if err != nil {
		return nil, err
	}
	var out []Runtime
	for _, pod := range pods.Items {
		// A Pod that ended (evicted) or is going is as good as none: the
		// next Run replaces it.
		if pod.DeletionTimestamp != nil || pod.Status.Phase == corev1.PodFailed || pod.Status.Phase == corev1.PodSucceeded {
			continue
		}
		r := Runtime{AgentID: pod.Labels[agentLabel], Config: pod.Annotations[configAnnotation], State: Starting}
		for _, s := range pod.Status.ContainerStatuses {
			if s.State.Running != nil && pod.Status.PodIP != "" {
				r.State = Running
				r.URL = fmt.Sprintf("http://%s:%d", pod.Status.PodIP, controlPort)
			}
		}
		out = append(out, r)
	}
	return out, nil
}

func (k *Kubernetes) Run(ctx context.Context, spec Spec) error {
	if err := k.Remove(ctx, spec.AgentID); err != nil {
		return err
	}
	name := podName(spec.AgentID)
	labels := map[string]string{agentLabel: spec.AgentID}
	_, err := k.Client.CoreV1().PersistentVolumeClaims(k.Namespace).Create(ctx, &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels},
		Spec: corev1.PersistentVolumeClaimSpec{
			// deploy/k3s/infra/storage.yaml: kept when the claim goes.
			StorageClassName: ptr.To("axp"),
			AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("10Gi")},
			},
		},
	}, metav1.CreateOptions{})
	if err != nil && !apierrors.IsAlreadyExists(err) {
		return err
	}
	env := make([]corev1.EnvVar, 0, len(spec.Env))
	for k, v := range spec.Env {
		env = append(env, corev1.EnvVar{Name: k, Value: v})
	}
	sort.Slice(env, func(i, j int) bool { return env[i].Name < env[j].Name })
	limits := corev1.ResourceList{corev1.ResourceMemory: resource.MustParse(memory), corev1.ResourceCPU: resource.MustParse(cpus)}
	_, err = k.Client.CoreV1().Pods(k.Namespace).Create(ctx, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels, Annotations: map[string]string{configAnnotation: spec.Config}},
		Spec: corev1.PodSpec{
			// The runtime exits when it cannot go on; the kubelet starts it
			// again, waiting longer each time it fails.
			RestartPolicy: corev1.RestartPolicyAlways,
			// Agents run code: no Kubernetes credentials, no other services'
			// addresses.
			AutomountServiceAccountToken:  ptr.To(false),
			EnableServiceLinks:            ptr.To(false),
			TerminationGracePeriodSeconds: ptr.To[int64](stopSeconds),
			Containers: []corev1.Container{{
				Name:            "runtime",
				Image:           spec.Image,
				ImagePullPolicy: corev1.PullIfNotPresent,
				Env:             env,
				Resources:       corev1.ResourceRequirements{Limits: limits},
				VolumeMounts:    []corev1.VolumeMount{{Name: "home", MountPath: home}},
			}},
			Volumes: []corev1.Volume{{Name: "home", VolumeSource: corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: name},
			}}},
		},
	}, metav1.CreateOptions{})
	return err
}

// Remove deletes the agent's Pod and waits until it is gone, giving the
// runtime time to send its last events.
func (k *Kubernetes) Remove(ctx context.Context, agentID string) error {
	pods := k.Client.CoreV1().Pods(k.Namespace)
	err := pods.Delete(ctx, podName(agentID), metav1.DeleteOptions{GracePeriodSeconds: ptr.To[int64](stopSeconds)})
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, (stopSeconds+30)*time.Second)
	defer cancel()
	for {
		if _, err := pods.Get(ctx, podName(agentID), metav1.GetOptions{}); apierrors.IsNotFound(err) {
			return nil
		} else if ctx.Err() != nil {
			return fmt.Errorf("the runtime of agent %s did not stop: %w", agentID, ctx.Err())
		}
		select {
		case <-ctx.Done():
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func (k *Kubernetes) Base(ctx context.Context) (string, string, error) {
	digest, err := k.digest(ctx, k.BaseImage)
	if err == nil && digest == "" {
		err = errors.New("not in the registry")
	}
	if err != nil {
		return "", "", fmt.Errorf("the runtime image %s: %w", k.BaseImage, err)
	}
	return digest, k.BaseImage, nil
}

func (k *Kubernetes) ImageTag(hash string) string { return k.Registry + "/axp-agent:" + hash }

func (k *Kubernetes) HasImage(ctx context.Context, tag string) (bool, error) {
	digest, err := k.digest(ctx, tag)
	return digest != "", err
}

func (k *Kubernetes) Build(ctx context.Context, dir, tag string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, buildTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "buildctl", "--addr", k.BuildKit, "build", "--progress=plain",
		"--frontend", "dockerfile.v0", "--local", "context="+dir, "--local", "dockerfile="+dir,
		"--output", "type=image,name="+tag+",push=true,registry.insecure=true")
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Run(); err != nil {
		tail := output.String()
		if r := []rune(tail); len(r) > buildOutput {
			tail = "…" + string(r[len(r)-buildOutput:])
		}
		return strings.TrimSpace(tail), err
	}
	return "", nil
}

// Prune deletes the agent images in the registry that keep does not name;
// the registry frees their layers when it collects garbage (deploy/k3s).
// Nodes drop images no Pod uses by themselves.
func (k *Kubernetes) Prune(ctx context.Context, keep []string) error {
	tags, err := k.tags(ctx, "axp-agent")
	if err != nil {
		return err
	}
	kept := map[string]bool{}
	for _, tag := range keep {
		if digest, err := k.digest(ctx, tag); err == nil && digest != "" {
			kept[digest] = true
		}
	}
	for _, tag := range tags {
		digest, err := k.digest(ctx, k.ImageTag(tag))
		if err != nil {
			return err
		}
		if digest == "" || kept[digest] {
			continue
		}
		if err := k.registry(ctx, http.MethodDelete, "/v2/axp-agent/manifests/"+digest, nil); err != nil {
			return err
		}
		kept[digest] = true // deleted, with every tag on it
	}
	return nil
}

// KubeConfig is the cluster this runs in, or else the one KUBECONFIG (or
// ~/.kube/config) names, as in development.
func KubeConfig() (*rest.Config, error) {
	if c, err := rest.InClusterConfig(); err == nil {
		return c, nil
	}
	return clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		clientcmd.NewDefaultClientConfigLoadingRules(), &clientcmd.ConfigOverrides{}).ClientConfig()
}
