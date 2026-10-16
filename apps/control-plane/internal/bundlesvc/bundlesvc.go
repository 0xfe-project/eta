// Package bundlesvc runs bundles' services (docs/architecture/bundles.md#服务):
// for each bundle that has one, its jobspec as the Nomad job bundle-<name>
// in AXP's namespace (next to AXP's own jobs, which no bundle's name can
// take), with what AXP gives the service in its environment. The
// controller reconciles them every few seconds and records how each is in
// the table bundle_service; a bundle that goes takes its job with it, but
// not its volumes or its database.
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
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"github.com/akarachen/axp/apps/control-plane/internal/container"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/hashicorp/nomad/api"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// On jobs: which bundle's, and the revision (jobspec, images and
	// environment) it was registered from.
	bundleMeta   = "axp.bundle"
	revisionMeta = "axp.revision"
)

// Status is a service's state as the controller last saw it.
type Status = bundles.ServiceStatus

// Reconciler keeps the bundles' services as the catalog says.
type Reconciler struct {
	Client    *api.Client
	Namespace string
	Bundles   *bundles.Catalog
	DB        *pgxpool.Pool
	// The control plane's database, whose server bundles' databases are on,
	// and the host as services reach it (their database's address).
	DatabaseURL string
	Host        string
	Secret      []byte
	// Where the service reaches AXP (the runtime gateway); where users
	// reach AXP (empty when they reach it only at the browser's address).
	GatewayURL, PublicURL string
	// The control plane's own DSN (empty: nothing is sent), whose project
	// services report to through the runtime gateway's /sentry.
	SentryDSN string
	// The tag of AXP's own images (named axp-*), in Docker.
	ImageTag string
	HTTP     *http.Client
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
	q := r.query(ctx)
	q.Params = map[string]string{"meta": "true"}
	jobs, _, err := r.Client.Jobs().List(q)
	if err != nil {
		return errors.Join(append(errs, err)...)
	}
	for _, job := range jobs {
		if name := job.Meta[bundleMeta]; name != "" && !desired[name] && !job.Stop {
			slog.InfoContext(ctx, "Removing a bundle's service", "bundle", name)
			_, _, err := r.Client.Jobs().Deregister(job.ID, true, r.write(ctx))
			errs = append(errs, err)
		}
	}
	names := make([]string, 0, len(desired))
	for name := range desired {
		names = append(names, name)
	}
	_, err = r.DB.Exec(ctx, "DELETE FROM bundle_service WHERE NOT (bundle = ANY($1))", names)
	return errors.Join(append(errs, err)...)
}

func (r *Reconciler) query(ctx context.Context) *api.QueryOptions {
	return (&api.QueryOptions{Namespace: r.Namespace}).WithContext(ctx)
}

func (r *Reconciler) write(ctx context.Context) *api.WriteOptions {
	return (&api.WriteOptions{Namespace: r.Namespace}).WithContext(ctx)
}

// sync registers one bundle's job when its revision changed, and records
// how it is.
func (r *Reconciler) sync(ctx context.Context, b bundles.Bundle, config map[string]string) error {
	env, err := r.environment(ctx, b, config)
	if err != nil {
		return err
	}
	h := sha256.New()
	fmt.Fprintf(h, "%s\n%s\n", b.Service.Jobspec, r.ImageTag)
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(h, "%s=%s\n", k, env[k])
	}
	revision := hex.EncodeToString(h.Sum(nil))[:16]
	last, err := pg.One[Status](ctx, r.DB, "SELECT state, message, version, revision FROM bundle_service WHERE bundle = $1", b.Name)
	if err != nil {
		return err
	}
	job, _, err := r.Client.Jobs().Info(jobID(b.Name), r.query(ctx))
	if err != nil && !container.NotFound(err) {
		return err
	}
	var status Status
	if job == nil || job.Meta[revisionMeta] != revision || *job.Stop {
		status, err = r.register(ctx, b, env, revision)
	} else {
		status, err = r.observe(ctx, b, job, last, revision)
	}
	if err != nil {
		status = Status{State: "error", Message: err.Error()}
	}
	status.Revision = revision
	return r.record(ctx, b.Name, last, status)
}

// register parses the bundle's jobspec, makes it the bundle's, and runs it.
func (r *Reconciler) register(ctx context.Context, b bundles.Bundle, env map[string]string, revision string) (Status, error) {
	job, err := r.Client.Jobs().ParseHCLOpts(&api.JobsParseRequest{JobHCL: b.Service.Jobspec, Canonicalize: true})
	if err != nil {
		return Status{}, fmt.Errorf("the jobspec: %w", err)
	}
	if err := r.prepare(job, b.Name, env, revision); err != nil {
		return Status{}, err
	}
	for _, tg := range job.TaskGroups {
		for _, v := range tg.Volumes {
			if v.Type == "host" {
				if err := container.EnsureVolume(ctx, r.Client, r.Namespace, v.Source); err != nil {
					return Status{}, err
				}
			}
		}
	}
	slog.InfoContext(ctx, "Running a bundle's service", "bundle", b.Name, "revision", revision)
	if _, _, err := r.Client.Jobs().Register(job, r.write(ctx)); err != nil {
		return Status{}, err
	}
	return Status{State: "deploying", Message: "scheduling"}, nil
}

func jobID(bundle string) string { return "bundle-" + bundle }

// prepare makes the parsed job the bundle's: its ID and namespace, its
// revision, AXP's images (axp-<name>, without a tag) at this deployment's,
// and what AXP gives it in every task's environment. The job must have a
// service named after the bundle (Nomad's service discovery), which the
// gateways route to.
func (r *Reconciler) prepare(job *api.Job, name string, env map[string]string, revision string) error {
	if job.Type != nil && *job.Type != api.JobTypeService {
		return fmt.Errorf("the job is a %s job, not a service job", *job.Type)
	}
	id := jobID(name)
	job.ID, job.Name, job.Namespace = &id, &id, &r.Namespace
	job.Type = new(api.JobTypeService)
	if job.Meta == nil {
		job.Meta = map[string]string{}
	}
	job.Meta[bundleMeta], job.Meta[revisionMeta] = name, revision
	found := false
	for _, tg := range job.TaskGroups {
		services := tg.Services
		for _, task := range tg.Tasks {
			services = append(services, task.Services...)
			if image, _ := task.Config["image"].(string); strings.HasPrefix(image, "axp-") && !strings.ContainsAny(image, ":/") {
				task.Config["image"] = image + ":" + r.ImageTag
			}
			if task.Env == nil {
				task.Env = map[string]string{}
			}
			for k, v := range env {
				task.Env[k] = v
			}
		}
		for _, s := range services {
			if s.Name == name && s.Provider == "nomad" {
				found = true
			}
		}
	}
	if !found {
		return fmt.Errorf("no service named %q with provider nomad", name)
	}
	return nil
}

// observe is how the registered job is: deploying until its deployment
// succeeded, then what it speaks (asked once a revision).
func (r *Reconciler) observe(ctx context.Context, b bundles.Bundle, job *api.Job, last *Status, revision string) (Status, error) {
	deployment, _, err := r.Client.Jobs().LatestDeployment(*job.ID, r.query(ctx))
	if err != nil {
		return Status{}, err
	}
	if deployment == nil || deployment.JobVersion != *job.Version {
		return Status{State: "deploying", Message: "scheduling"}, nil
	}
	switch deployment.Status {
	case api.DeploymentStatusSuccessful:
	case api.DeploymentStatusFailed, api.DeploymentStatusCancelled:
		return Status{State: "error", Message: deployment.StatusDescription}, nil
	default:
		return Status{State: "deploying", Message: deployment.StatusDescription}, nil
	}
	if last != nil && last.Revision == revision && (last.State == "ready" || last.State == "incompatible") {
		return *last, nil
	}
	return r.discover(ctx, b)
}

// discover asks the ready service what it speaks, when the bundle says
// what it should, at the address Nomad registered for it.
func (r *Reconciler) discover(ctx context.Context, b bundles.Bundle) (Status, error) {
	if b.Service.Protocol == "" {
		return Status{State: "ready"}, nil
	}
	registrations, _, err := r.Client.Services().Get(b.Name, r.query(ctx))
	if err != nil {
		return Status{}, err
	}
	if len(registrations) == 0 {
		return Status{State: "deploying", Message: "the service is not registered yet"}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	url := fmt.Sprintf("http://%s:%d/.well-known/axp-service", registrations[0].Address, registrations[0].Port)
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
		return Status{State: "deploying", Message: err.Error()}, nil
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

// environment is what AXP gives the service: where AXP is, where to report
// errors and logs, a secret of its own, its token when it uses AXP, its
// database, and the bundle's configuration once complete.
func (r *Reconciler) environment(ctx context.Context, b bundles.Bundle, config map[string]string) (map[string]string, error) {
	env := map[string]string{
		"AXP_GATEWAY_URL":   r.GatewayURL,
		"AXP_BUNDLE_SECRET": auth.BundleSecret(r.Secret, b.Name),
		"AXP_PUBLIC_URL":    r.PublicURL,
		"AXP_VERSION":       r.ImageTag,
	}
	if dsn := gatewayDSN(r.SentryDSN, r.GatewayURL); dsn != "" {
		env["SENTRY_DSN"] = dsn
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

// record writes the status when it changed.
func (r *Reconciler) record(ctx context.Context, bundle string, last *Status, s Status) error {
	if last != nil && *last == s {
		return nil
	}
	if s.State != "deploying" {
		slog.InfoContext(ctx, "A bundle's service changed state", "bundle", bundle, "state", s.State, "message", s.Message)
	}
	_, err := r.DB.Exec(ctx, `INSERT INTO bundle_service (bundle, state, message, version, revision, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (bundle) DO UPDATE SET state = $2, message = $3, version = $4, revision = $5, updated_at = $6`,
		bundle, s.State, s.Message, s.Version, s.Revision, pg.Now())
	return err
}

// gatewayDSN is dsn (http://key@127.0.0.1:24080/1) at the runtime gateway,
// which passes only Sentry's envelopes on
// (http://key@172.26.64.1:24090/sentry/1): services reach nothing else of
// AXP's, and hold no credentials that could.
func gatewayDSN(dsn, gateway string) string {
	d, err := url.Parse(dsn)
	g, gerr := url.Parse(gateway)
	if dsn == "" || err != nil || gerr != nil {
		return ""
	}
	d.Scheme, d.Host, d.Path = g.Scheme, g.Host, "/sentry"+d.Path
	return d.String()
}
