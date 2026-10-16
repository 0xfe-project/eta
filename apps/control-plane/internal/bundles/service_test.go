package bundles

import (
	"os"
	"strings"
	"testing"
)

// The production image (deploy/Dockerfile) leaves bundles' services out
// but for their jobspecs, which the control plane reads with the bundles.
func TestTheImageKeepsTheJobspecs(t *testing.T) {
	ignore, err := os.ReadFile("../../../../deploy/Dockerfile.dockerignore")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(ignore), "\n!bundles/*/service/"+JobspecFile+"\n") {
		t.Fatalf("deploy/Dockerfile.dockerignore leaves out bundles/*/service/%s", JobspecFile)
	}
	all, err := (&Catalog{Dir: "../../../../bundles"}).Builtin()
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range all {
		if b.Service != nil && b.Service.Jobspec == "" {
			t.Errorf("%s: empty jobspec", b.Name)
		}
	}
}
