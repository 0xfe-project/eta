// Package bundlesvc runs bundles' services (docs/architecture/bundles.md#服务):
// for each bundle that has one, a BundleService object in the bundles'
// namespace, and under it what the bundle's manifests say plus a Secret of
// what AXP gives the service. The controller reconciles them every few
// seconds; deleting a BundleService deletes what it owns, except volumes
// and the database.
package bundlesvc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"github.com/jackc/pgx/v5/pgxpool"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/utils/ptr"
)

const (
	group       = "axp.dev"
	bundleLabel = "axp.dev/bundle"
	// On pod templates: a new revision (manifests, configuration, what AXP
	// gives) rolls the service.
	revisionAnnotation = "axp.dev/revision"
	manager            = "axp-controller"
)

// Resource is the BundleService custom resource (deploy/k3s/infra/crd.yaml).
var Resource = schema.GroupVersionResource{Group: group, Version: "v1alpha1", Resource: "bundleservices"}

var resources = map[string]schema.GroupVersionResource{
	"ConfigMap":             {Version: "v1", Resource: "configmaps"},
	"CronJob":               {Group: "batch", Version: "v1", Resource: "cronjobs"},
	"Deployment":            {Group: "apps", Version: "v1", Resource: "deployments"},
	"Job":                   {Group: "batch", Version: "v1", Resource: "jobs"},
	"PersistentVolumeClaim": {Version: "v1", Resource: "persistentvolumeclaims"},
	"Secret":                {Version: "v1", Resource: "secrets"},
	"Service":               {Version: "v1", Resource: "services"},
	"ServiceAccount":        {Version: "v1", Resource: "serviceaccounts"},
	"StatefulSet":           {Group: "apps", Version: "v1", Resource: "statefulsets"},
}

// Status is a service's state as the controller last saw it.
type Status = bundles.ServiceStatus

// Reconciler keeps the bundles' services as the catalog says.
type Reconciler struct {
	Client    dynamic.Interface
	Namespace string
	Bundles   *bundles.Catalog
	DB        *pgxpool.Pool
	// The control plane's database, whose server bundles' databases are on.
	DatabaseURL string
	Secret      []byte
	// Where the service reaches AXP (the runtime gateway) and the
	// OpenTelemetry Collector, which holds the credentials; where users
	// reach AXP (empty when they reach it only at the browser's address).
	GatewayURL, OTLPURL, PublicURL string
	// AXP's own images (named axp-*) come from Registry, at ImageTag.
	Registry, ImageTag string
	HTTP               *http.Client
}

// Run reconciles until ctx ends.
func (r *Reconciler) Run(ctx context.Context, every time.Duration) {
	for {
		if err := r.Sync(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "Reconciling bundles' services failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

// Sync reconciles every bundle's service once.
func (r *Reconciler) Sync(ctx context.Context) error {
	all, err := r.Bundles.All(ctx, r.DB)
	if err != nil {
		return err
	}
	configs, err := bundles.Configs(ctx, r.DB, r.Secret)
	if err != nil {
		return err
	}
	desired := map[string]bool{}
	var errs []error
	for _, b := range all {
		if b.Service != nil {
			desired[b.Name] = true
			errs = append(errs, r.sync(ctx, b, configs[b.Name]))
		}
	}
	list, err := r.Client.Resource(Resource).Namespace(r.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return errors.Join(append(errs, err)...)
	}
	for _, item := range list.Items {
		if !desired[item.GetName()] {
			slog.InfoContext(ctx, "Removing a bundle's service", "bundle", item.GetName())
			errs = append(errs, ignoreNotFound(r.Client.Resource(Resource).Namespace(r.Namespace).Delete(ctx, item.GetName(), metav1.DeleteOptions{})))
		}
	}
	return errors.Join(errs...)
}

// sync applies one bundle's service and records how it is.
func (r *Reconciler) sync(ctx context.Context, b bundles.Bundle, config map[string]string) error {
	s := b.Service
	env, err := r.environment(ctx, b, config)
	if err != nil {
		return err
	}
	h := sha256.New()
	fmt.Fprintf(h, "%s\n%s:%s\n", s.Manifests, r.Registry, r.ImageTag)
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(h, "%s=%s\n", k, env[k])
	}
	revision := hex.EncodeToString(h.Sum(nil))[:16]
	owner, err := r.apply(ctx, Resource, &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": group + "/v1alpha1", "kind": "BundleService",
		"metadata": map[string]any{"name": b.Name},
		"spec": map[string]any{
			"revision": revision, "protocol": s.Protocol, "uses": toAny(s.Uses), "database": s.Database, "manifests": s.Manifests,
		},
	}})
	if err != nil {
		return err
	}
	status, err := r.applyObjects(ctx, b, owner, env, revision)
	if err != nil {
		status = Status{State: "error", Message: err.Error()}
	}
	status.Revision = revision
	return r.record(ctx, owner, status)
}

// environment is what AXP gives the service, in the Secret axp-<bundle>:
// where AXP and the collector are, a secret of its own, its token when it
// uses AXP, its database, and the bundle's configuration once complete.
func (r *Reconciler) environment(ctx context.Context, b bundles.Bundle, config map[string]string) (map[string]string, error) {
	env := map[string]string{
		"AXP_GATEWAY_URL":             r.GatewayURL,
		"AXP_BUNDLE_SECRET":           auth.BundleSecret(r.Secret, b.Name),
		"OTEL_EXPORTER_OTLP_ENDPOINT": r.OTLPURL,
		"AXP_PUBLIC_URL":              r.PublicURL,
		"AXP_VERSION":                 r.ImageTag,
	}
	if len(b.Service.Uses) > 0 {
		env["AXP_BUNDLE_TOKEN"] = auth.BundleToken(r.Secret, b.Name)
	}
	if b.Service.Database {
		url, err := r.database(ctx, b.Name)
		if err != nil {
			return nil, err
		}
		env["DATABASE_URL"] = url
	}
	for k, v := range config {
		env[k] = v
	}
	return env, nil
}

func (r *Reconciler) applyObjects(ctx context.Context, b bundles.Bundle, owner *unstructured.Unstructured, env map[string]string, revision string) (Status, error) {
	objects, err := b.Service.Objects()
	if err != nil {
		return Status{}, err
	}
	data := map[string]any{}
	for k, v := range env {
		data[k] = v
	}
	secret := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Secret", "metadata": map[string]any{"name": "axp-" + b.Name}, "stringData": data,
	}}
	objects = append(objects, secret)
	ref := metav1.OwnerReference{
		APIVersion: owner.GetAPIVersion(), Kind: owner.GetKind(), Name: owner.GetName(), UID: owner.GetUID(),
		BlockOwnerDeletion: ptr.To(true),
	}
	applied := map[string]bool{}
	var ready []*unstructured.Unstructured
	for _, obj := range objects {
		labels := obj.GetLabels()
		if labels == nil {
			labels = map[string]string{}
		}
		labels[bundleLabel] = b.Name
		obj.SetLabels(labels)
		// Volumes keep their data when the service goes (bundles.md#服务).
		if obj.GetKind() != "PersistentVolumeClaim" {
			obj.SetOwnerReferences([]metav1.OwnerReference{ref})
		}
		if err := r.prepare(obj, revision); err != nil {
			return Status{}, err
		}
		out, err := r.apply(ctx, resources[obj.GetKind()], obj)
		if err != nil {
			return Status{}, fmt.Errorf("%s %s: %w", obj.GetKind(), obj.GetName(), err)
		}
		applied[obj.GetKind()+"/"+obj.GetName()] = true
		if obj.GetKind() == "Deployment" || obj.GetKind() == "StatefulSet" {
			ready = append(ready, out)
		}
	}
	if err := r.prune(ctx, b.Name, applied); err != nil {
		return Status{}, err
	}
	for _, obj := range ready {
		if msg := notReady(obj); msg != "" {
			return Status{State: "applying", Message: msg}, nil
		}
	}
	// What it speaks is asked once a revision is ready.
	if last := statusOf(owner); last.Revision == revision && (last.State == "ready" || last.State == "incompatible") {
		return last, nil
	}
	return r.discover(ctx, b, objects)
}

// prepare points AXP's images (axp-<name>, without a registry) at this
// deployment's, and stamps pod templates with the revision.
func (r *Reconciler) prepare(obj *unstructured.Unstructured, revision string) error {
	path := map[string][]string{
		"Deployment": {"spec", "template"}, "StatefulSet": {"spec", "template"},
		"Job": {"spec", "template"}, "CronJob": {"spec", "jobTemplate", "spec", "template"},
	}[obj.GetKind()]
	if path == nil {
		return nil
	}
	template, ok, err := unstructured.NestedMap(obj.Object, path...)
	if err != nil || !ok {
		return err
	}
	annotations, _, _ := unstructured.NestedStringMap(template, "metadata", "annotations")
	if annotations == nil {
		annotations = map[string]string{}
	}
	annotations[revisionAnnotation] = revision
	if err := unstructured.SetNestedStringMap(template, annotations, "metadata", "annotations"); err != nil {
		return err
	}
	for _, field := range []string{"initContainers", "containers"} {
		containers, _, _ := unstructured.NestedSlice(template, "spec", field)
		for _, c := range containers {
			container, ok := c.(map[string]any)
			if !ok {
				continue
			}
			if image, _ := container["image"].(string); strings.HasPrefix(image, "axp-") && !strings.ContainsAny(image, ":/") {
				container["image"] = r.Registry + "/" + image + ":" + r.ImageTag
			}
		}
		if containers != nil {
			if err := unstructured.SetNestedSlice(template, containers, "spec", field); err != nil {
				return err
			}
		}
	}
	return unstructured.SetNestedMap(obj.Object, template, path...)
}

func (r *Reconciler) apply(ctx context.Context, gvr schema.GroupVersionResource, obj *unstructured.Unstructured) (*unstructured.Unstructured, error) {
	return r.Client.Resource(gvr).Namespace(r.Namespace).Apply(ctx, obj.GetName(), obj, metav1.ApplyOptions{FieldManager: manager, Force: true})
}

// prune deletes the bundle's objects its manifests no longer have; volumes
// stay.
func (r *Reconciler) prune(ctx context.Context, bundle string, applied map[string]bool) error {
	for kind, gvr := range resources {
		if kind == "PersistentVolumeClaim" {
			continue
		}
		list, err := r.Client.Resource(gvr).Namespace(r.Namespace).List(ctx, metav1.ListOptions{LabelSelector: bundleLabel + "=" + bundle})
		if err != nil {
			return err
		}
		for _, item := range list.Items {
			if !applied[kind+"/"+item.GetName()] {
				if err := ignoreNotFound(r.Client.Resource(gvr).Namespace(r.Namespace).Delete(ctx, item.GetName(), metav1.DeleteOptions{})); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// notReady says why a Deployment or StatefulSet is not ready yet, or "".
func notReady(obj *unstructured.Unstructured) string {
	generation, _, _ := unstructured.NestedInt64(obj.Object, "status", "observedGeneration")
	want, found, _ := unstructured.NestedInt64(obj.Object, "spec", "replicas")
	if !found {
		want = 1
	}
	updated, _, _ := unstructured.NestedInt64(obj.Object, "status", "updatedReplicas")
	ready, _, _ := unstructured.NestedInt64(obj.Object, "status", "readyReplicas")
	if generation < obj.GetGeneration() || updated < want || ready < want {
		return fmt.Sprintf("%s %s: %d/%d ready", obj.GetKind(), obj.GetName(), ready, want)
	}
	return ""
}

// discover asks a ready service what it speaks, when the bundle says what
// it should.
func (r *Reconciler) discover(ctx context.Context, b bundles.Bundle, objects []*unstructured.Unstructured) (Status, error) {
	if b.Service.Protocol == "" {
		return Status{State: "ready"}, nil
	}
	port := servicePort(objects, b.Name)
	if port == 0 {
		return Status{}, fmt.Errorf("no Service %q with a port named http", b.Name)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	url := fmt.Sprintf("http://%s.%s.svc.cluster.local:%d/.well-known/axp-service", b.Name, r.Namespace, port)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Status{}, err
	}
	client := r.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return Status{State: "applying", Message: err.Error()}, nil
	}
	defer resp.Body.Close()
	var info struct {
		Protocol string `json:"protocol"`
		Version  string `json:"version"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&info) != nil {
		return Status{State: "incompatible", Message: "no /.well-known/axp-service"}, nil
	}
	if info.Protocol != b.Service.Protocol {
		return Status{State: "incompatible", Version: info.Version,
			Message: fmt.Sprintf("speaks %s, the bundle needs %s", info.Protocol, b.Service.Protocol)}, nil
	}
	return Status{State: "ready", Version: info.Version}, nil
}

func servicePort(objects []*unstructured.Unstructured, name string) int64 {
	for _, obj := range objects {
		if obj.GetKind() != "Service" || obj.GetName() != name {
			continue
		}
		ports, _, _ := unstructured.NestedSlice(obj.Object, "spec", "ports")
		for _, p := range ports {
			if port, ok := p.(map[string]any); ok && port["name"] == "http" {
				// Numbers decode from YAML as float64 or int64.
				switch n := port["port"].(type) {
				case int64:
					return n
				case float64:
					return int64(n)
				}
			}
		}
	}
	return 0
}

// record writes the status when it changed.
func (r *Reconciler) record(ctx context.Context, owner *unstructured.Unstructured, s Status) error {
	if statusOf(owner) == s {
		return nil
	}
	next := map[string]any{"state": s.State, "message": s.Message, "version": s.Version, "revision": s.Revision}
	if s.State != "applying" {
		slog.InfoContext(ctx, "A bundle's service changed state", "bundle", owner.GetName(), "state", s.State, "message", s.Message)
	}
	owner.Object["status"] = next
	_, err := r.Client.Resource(Resource).Namespace(r.Namespace).UpdateStatus(ctx, owner, metav1.UpdateOptions{FieldManager: manager})
	return err
}

// Statuses is every bundle's service's status, by bundle.
func Statuses(ctx context.Context, client dynamic.Interface, namespace string) (map[string]Status, error) {
	list, err := client.Resource(Resource).Namespace(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := map[string]Status{}
	for _, item := range list.Items {
		out[item.GetName()] = statusOf(&item)
	}
	return out, nil
}

func statusOf(obj *unstructured.Unstructured) Status {
	status, ok, _ := unstructured.NestedStringMap(obj.Object, "status")
	if !ok || status["state"] == "" {
		return Status{State: "applying"}
	}
	return Status{State: status["state"], Message: status["message"], Version: status["version"], Revision: status["revision"]}
}

func toAny(s []string) []any {
	out := []any{}
	for _, v := range s {
		out = append(out, v)
	}
	return out
}

func ignoreNotFound(err error) error {
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}
