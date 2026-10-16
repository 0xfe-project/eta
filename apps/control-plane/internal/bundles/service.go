package bundles

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/akarachen/axp/packages/service-go/pg"
)

// Service is what a bundle runs besides agents' images: a Nomad job in
// AXP's namespace, shared by every agent that loads it
// (docs/architecture/bundles.md#服务). The controller runs it.
type Service struct {
	// The job, as HCL. A built-in bundle's is service/job.nomad.hcl.
	Jobspec string `json:"jobspec" maxLength:"200000" doc:"Its Nomad job (HCL): a service job with a service named after the bundle (provider nomad), which agents reach through the runtime gateway."`
	// What the service speaks, checked against its /.well-known/axp-service.
	Protocol string `json:"protocol,omitempty" maxLength:"100" doc:"What it speaks (name/major version), checked against its /.well-known/axp-service."`
	// What it may call through the runtime gateway with its token: llm (the
	// models' /v1) and other bundles, by name.
	Uses []string `json:"uses,omitempty" maxItems:"20" doc:"What it may call through the runtime gateway with its token: llm, or other bundles by name."`
	// A PostgreSQL database of its own.
	Database bool `json:"database,omitempty" doc:"Give it a PostgreSQL database of its own (DATABASE_URL)."`
}

// JobspecFile is a built-in bundle's job, in its service/ directory.
const JobspecFile = "job.nomad.hcl"

// ServiceStatus is a service's state as the controller last saw it
// (internal/bundlesvc), in the table bundle_service.
type ServiceStatus struct {
	State   string `json:"state" enum:"deploying,ready,incompatible,error" doc:"deploying (not ready yet), ready, incompatible (speaks another protocol) or error."`
	Message string `json:"message,omitempty"`
	// What the service reports at /.well-known/axp-service.
	Version string `json:"version,omitempty"`
	// The revision of the service this is about (internal/bundlesvc).
	Revision string `json:"-"`
}

// ServiceStatuses is every bundle's service's status, by bundle.
func ServiceStatuses(ctx context.Context, db pg.DB) (map[string]ServiceStatus, error) {
	rows, err := pg.All[struct {
		Bundle string `db:"bundle"`
		ServiceStatus
	}](ctx, db, "SELECT bundle, state, message, version, revision FROM bundle_service")
	if err != nil {
		return nil, err
	}
	out := map[string]ServiceStatus{}
	for _, r := range rows {
		out[r.Bundle] = r.ServiceStatus
	}
	return out, nil
}

// readService reads a built-in bundle's service/job.nomad.hcl.
func readService(s *Service, dir string) error {
	data, err := os.ReadFile(filepath.Join(dir, "service", JobspecFile))
	if errors.Is(err, fs.ErrNotExist) {
		return errors.New("no service/" + JobspecFile)
	}
	s.Jobspec = string(data)
	return err
}
