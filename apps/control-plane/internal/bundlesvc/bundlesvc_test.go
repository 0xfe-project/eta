package bundlesvc

import (
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func parse(t *testing.T, manifests string) []*unstructured.Unstructured {
	t.Helper()
	objects, err := (&bundles.Service{Manifests: manifests}).Objects()
	if err != nil {
		t.Fatal(err)
	}
	return objects
}

const service = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: memory }
spec:
  template:
    spec:
      initContainers: [{ name: init, image: busybox:1.37 }]
      containers: [{ name: memory, image: axp-memory }, { name: other, image: example.com/axp-x:1 }]
---
apiVersion: v1
kind: Service
metadata: { name: memory }
spec:
  ports: [{ name: http, port: 80, targetPort: 8320 }]
`

func TestPrepareStampsTemplatesAndPointsAtAXPImages(t *testing.T) {
	r := &Reconciler{Registry: "10.43.100.1:5000", ImageTag: "abc"}
	objects := parse(t, service)
	for _, obj := range objects {
		if err := r.prepare(obj, "rev1"); err != nil {
			t.Fatal(err)
		}
	}
	template, _, _ := unstructured.NestedMap(objects[0].Object, "spec", "template")
	if rev, _, _ := unstructured.NestedString(template, "metadata", "annotations", revisionAnnotation); rev != "rev1" {
		t.Fatalf("revision %q", rev)
	}
	containers, _, _ := unstructured.NestedSlice(template, "spec", "containers")
	if got := containers[0].(map[string]any)["image"]; got != "10.43.100.1:5000/axp-memory:abc" {
		t.Fatalf("AXP's image %v", got)
	}
	if got := containers[1].(map[string]any)["image"]; got != "example.com/axp-x:1" {
		t.Fatalf("another registry's image %v", got)
	}
	inits, _, _ := unstructured.NestedSlice(template, "spec", "initContainers")
	if got := inits[0].(map[string]any)["image"]; got != "busybox:1.37" {
		t.Fatalf("init container's image %v", got)
	}
	if port := servicePort(objects, "memory"); port != 80 {
		t.Fatalf("port %d", port)
	}
}

func TestOnlyAllowedObjects(t *testing.T) {
	for _, manifests := range []string{
		"apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata: { name: x }\n",
		"apiVersion: v1\nkind: ConfigMap\nmetadata: { name: x, namespace: kube-system }\n",
		"apiVersion: v1\nkind: ConfigMap\nmetadata: {}\n",
	} {
		if _, err := (&bundles.Service{Manifests: manifests}).Objects(); err == nil {
			t.Errorf("accepted %q", manifests)
		}
	}
}

func TestNotReadyUntilRolledOut(t *testing.T) {
	obj := &unstructured.Unstructured{Object: map[string]any{
		"kind": "Deployment", "metadata": map[string]any{"name": "m", "generation": int64(2)},
		"spec":   map[string]any{"replicas": int64(1)},
		"status": map[string]any{"observedGeneration": int64(1), "updatedReplicas": int64(1), "readyReplicas": int64(1)},
	}}
	if notReady(obj) == "" {
		t.Fatal("ready before observing its generation")
	}
	_ = unstructured.SetNestedField(obj.Object, int64(2), "status", "observedGeneration")
	if msg := notReady(obj); msg != "" {
		t.Fatal(msg)
	}
}
