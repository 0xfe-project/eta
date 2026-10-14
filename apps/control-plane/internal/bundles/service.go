package bundles

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"

	"github.com/akarachen/axp/packages/service-go/apierr"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
)

// Service is what a bundle runs besides agents' images: Kubernetes objects
// in the bundles' namespace, shared by every agent that loads it
// (docs/architecture/bundles.md#服务). The controller applies them.
type Service struct {
	// The objects, as YAML documents. A built-in bundle's are the files in
	// its service/ directory.
	Manifests string `json:"manifests" maxLength:"200000" doc:"Its Kubernetes objects, as YAML documents: a Service named after the bundle (port named http) and what serves it."`
	// What the service speaks, checked against its /.well-known/axp-service.
	Protocol string `json:"protocol,omitempty" maxLength:"100" doc:"What it speaks (name/major version), checked against its /.well-known/axp-service."`
	// What it may call through the runtime gateway with its token: llm (the
	// models' /v1) and other bundles, by name.
	Uses []string `json:"uses,omitempty" maxItems:"20" doc:"What it may call through the runtime gateway with its token: llm, or other bundles by name."`
	// A PostgreSQL database of its own.
	Database bool `json:"database,omitempty" doc:"Give it a PostgreSQL database of its own (DATABASE_URL)."`
}

// ServiceStatus is a service's state as the controller last saw it
// (internal/bundlesvc).
type ServiceStatus struct {
	State   string `json:"state" enum:"applying,ready,incompatible,error" doc:"applying (not ready yet), ready, incompatible (speaks another protocol) or error."`
	Message string `json:"message,omitempty"`
	// What the service reports at /.well-known/axp-service.
	Version string `json:"version,omitempty"`
	// The revision of the service this is about (internal/bundlesvc).
	Revision string `json:"-"`
}

// Kinds a service may have, all in the bundles' namespace.
var Kinds = []string{
	"ConfigMap", "CronJob", "Deployment", "Job", "PersistentVolumeClaim", "Secret", "Service", "ServiceAccount", "StatefulSet",
}

// Objects parses the manifests, refusing kinds outside Kinds and objects
// that name another namespace.
func (s *Service) Objects() ([]*unstructured.Unstructured, error) {
	decoder := utilyaml.NewYAMLOrJSONDecoder(bytes.NewReader([]byte(s.Manifests)), 4096)
	var out []*unstructured.Unstructured
	for {
		var obj map[string]any
		if err := decoder.Decode(&obj); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return nil, err
		}
		if len(obj) == 0 {
			continue
		}
		u := &unstructured.Unstructured{Object: obj}
		switch {
		case !slices.Contains(Kinds, u.GetKind()):
			return nil, fmt.Errorf("%s %q: kind not allowed (only %v)", u.GetKind(), u.GetName(), Kinds)
		case u.GetName() == "":
			return nil, fmt.Errorf("a %s without a name", u.GetKind())
		case u.GetNamespace() != "":
			return nil, fmt.Errorf("%s %q: names a namespace", u.GetKind(), u.GetName())
		}
		out = append(out, u)
	}
	return out, nil
}

func checkService(s *Service) error {
	if s == nil {
		return nil
	}
	if _, err := s.Objects(); err != nil {
		return apierr.New(422, "INVALID_SERVICE", "服务的清单无效："+err.Error())
	}
	return nil
}

// readService reads a built-in bundle's service/ directory.
func readService(s *Service, dir string) error {
	files, err := filepath.Glob(filepath.Join(dir, "service", "*.yaml"))
	if err != nil {
		return err
	}
	sort.Strings(files)
	var all bytes.Buffer
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		all.WriteString("---\n")
		all.Write(data)
	}
	s.Manifests = all.String()
	_, err = s.Objects()
	return err
}
