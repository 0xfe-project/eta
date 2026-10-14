package container

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
)

func TestRunListRemove(t *testing.T) {
	ctx := context.Background()
	client := fake.NewClientset()
	k := &Kubernetes{Client: client, Namespace: "test-agents"}
	agent := uuid.NewString()
	if err := k.Run(ctx, Spec{AgentID: agent, Image: "r/axp-agent:1", Env: map[string]string{"A": "1"}, Config: "c1"}); err != nil {
		t.Fatal(err)
	}
	pod, err := client.CoreV1().Pods("test-agents").Get(ctx, "agent-"+agent, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if *pod.Spec.AutomountServiceAccountToken || pod.Spec.Containers[0].Env[0].Value != "1" ||
		pod.Spec.Volumes[0].PersistentVolumeClaim.ClaimName != "agent-"+agent {
		t.Fatalf("pod %+v", pod.Spec)
	}
	list, err := k.List(ctx)
	if err != nil || len(list) != 1 || list[0].Config != "c1" || list[0].State != Starting || list[0].URL != "" {
		t.Fatalf("listed %+v %v", list, err)
	}
	pod.Status = corev1.PodStatus{Phase: corev1.PodRunning, PodIP: "10.42.0.9",
		ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}}
	if _, err := client.CoreV1().Pods("test-agents").UpdateStatus(ctx, pod, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if list, _ = k.List(ctx); list[0].State != Running || list[0].URL != "http://10.42.0.9:8080" {
		t.Fatalf("running %+v", list)
	}
	// Run again replaces it; the volume stays.
	if err := k.Run(ctx, Spec{AgentID: agent, Image: "r/axp-agent:2", Config: "c2"}); err != nil {
		t.Fatal(err)
	}
	if list, _ = k.List(ctx); len(list) != 1 || list[0].Config != "c2" {
		t.Fatalf("replaced %+v", list)
	}
	if err := k.Remove(ctx, agent); err != nil {
		t.Fatal(err)
	}
	if list, _ = k.List(ctx); len(list) != 0 {
		t.Fatalf("still there: %+v", list)
	}
	if _, err := client.CoreV1().PersistentVolumeClaims("test-agents").Get(ctx, "agent-"+agent, metav1.GetOptions{}); err != nil {
		t.Fatalf("volume: %v", err)
	}
}

// A registry with tags in axp-agent; DELETE removes a manifest.
func fakeRegistry(t *testing.T, tags map[string]string) (*httptest.Server, *sync.Mutex) {
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch path := r.URL.Path; {
		case path == "/v2/axp-agent/tags/list":
			var list []string
			for tag := range tags {
				list = append(list, `"`+tag+`"`)
			}
			_, _ = w.Write([]byte(`{"tags":[` + strings.Join(list, ",") + `]}`))
		case strings.HasPrefix(path, "/v2/axp-agent/manifests/") && r.Method == http.MethodHead:
			digest, ok := tags[strings.TrimPrefix(path, "/v2/axp-agent/manifests/")]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Docker-Content-Digest", digest)
		case strings.HasPrefix(path, "/v2/axp-agent/manifests/") && r.Method == http.MethodDelete:
			for tag, digest := range tags {
				if digest == strings.TrimPrefix(path, "/v2/axp-agent/manifests/") {
					delete(tags, tag)
				}
			}
			w.WriteHeader(http.StatusAccepted)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &mu
}

func TestImagesInTheRegistry(t *testing.T) {
	ctx := context.Background()
	tags := map[string]string{"old": "sha256:o", "kept": "sha256:k", "alias": "sha256:k"}
	srv, mu := fakeRegistry(t, tags)
	k := &Kubernetes{Registry: strings.TrimPrefix(srv.URL, "http://")}
	if ok, err := k.HasImage(ctx, k.ImageTag("kept")); err != nil || !ok {
		t.Fatalf("kept: %v %v", ok, err)
	}
	if ok, err := k.HasImage(ctx, k.ImageTag("missing")); err != nil || ok {
		t.Fatalf("missing: %v %v", ok, err)
	}
	if err := k.Prune(ctx, []string{k.ImageTag("kept")}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if _, ok := tags["old"]; ok || len(tags) != 2 {
		t.Fatalf("after prune: %v", tags)
	}
}

// Against a cluster (scripts/dev.sh's): AXP_TEST_KUBERNETES=1 go test ./internal/container/
func TestBuildAndRunInTheCluster(t *testing.T) {
	if os.Getenv("AXP_TEST_KUBERNETES") == "" {
		t.Skip("AXP_TEST_KUBERNETES is not set")
	}
	ctx := context.Background()
	config, err := KubeConfig()
	if err != nil {
		t.Fatal(err)
	}
	client := kubernetes.NewForConfigOrDie(config)
	namespace := "axp-test-" + uuid.NewString()[:8]
	if _, err := client.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: namespace}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = client.CoreV1().Namespaces().Delete(context.Background(), namespace, metav1.DeleteOptions{})
	})
	k := &Kubernetes{Client: client, Namespace: namespace, Registry: "10.43.100.11:5000", BuildKit: "tcp://10.43.100.12:1234"}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM busybox:1.37\nCMD [\"sleep\", \"600\"]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tag := k.ImageTag("test-" + uuid.NewString()[:8])
	if failure, err := k.Build(ctx, dir, tag); err != nil {
		t.Fatalf("build: %v\n%s", err, failure)
	}
	t.Cleanup(func() { _ = k.Prune(context.Background(), nil) })
	if ok, err := k.HasImage(ctx, tag); err != nil || !ok {
		t.Fatalf("image %v %v", ok, err)
	}
	agent := uuid.NewString()
	if err := k.Run(ctx, Spec{AgentID: agent, Image: tag, Config: "c1"}); err != nil {
		t.Fatal(err)
	}
	for {
		list, err := k.List(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(list) == 1 && list[0].State == Running {
			break
		}
		if ctx.Err() != nil {
			t.Fatal(ctx.Err())
		}
	}
	if err := k.Remove(ctx, agent); err != nil {
		t.Fatal(err)
	}
}
