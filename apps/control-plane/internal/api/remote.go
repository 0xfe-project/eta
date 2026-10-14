package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/github"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

// /remote: what remote computers call, the one path outside the edge's
// access control (Cloudflare Access bypasses it). Every endpoint
// authenticates itself: the install command's one-time code, or the
// computer's token (Authorization: Bearer) for its CLI.

type RemoteBearer struct {
	Authorization string `header:"Authorization" doc:"Bearer <the computer's token>"`
	Dir           string `header:"X-Working-Dir" maxLength:"4096" doc:"The CLI's working directory: whose session on the computer it speaks for (the assignee's or an assisting agent's)."`
}

func (b RemoteBearer) computer(ctx context.Context, d *Deps) (*tasks.RemoteComputer, error) {
	token, _ := strings.CutPrefix(b.Authorization, "Bearer ")
	c, err := tasks.Authenticate(ctx, d.DB, token)
	if err != nil {
		return nil, err
	}
	// Escaped by the CLI, for paths that are not ASCII.
	if dir, err := url.PathUnescape(b.Dir); err == nil {
		c.Dir = dir
	}
	return c, nil
}

type EnrollIn struct {
	Code string `json:"code" minLength:"1" maxLength:"100"`
	tasks.Report
}

// Reported is what setup learns from reporting: where the relay is now,
// and the agenvo version to install (the latest when empty).
type Reported struct {
	RelayURL         string `json:"relay_url,omitempty"`
	ConnectorVersion string `json:"connector_version,omitempty"`
}

type CurrentTask struct {
	TaskID string `json:"task_id"`
}

type StatusIn struct {
	Status string `json:"status" enum:"in_progress,in_review,blocked"`
}

type RemoteTaskPath struct {
	RemoteBearer
	TaskID string `path:"task_id"`
}

// GitCredentials are the GitHub App's installation token, for git and gh,
// or, asked for as the user, the token of the user who authorized the App
// (User names them).
type GitCredentials struct {
	Token     string           `json:"token"`
	ExpiresAt int64            `json:"expires_at"`
	Identity  *github.Identity `json:"identity,omitempty"`
	User      string           `json:"user,omitempty"`
}

// forgeError is the GitHub App's refusal (not connected, GitHub's error)
// as the API's.
func forgeError(err error) error {
	if e, ok := errors.AsType[*github.Error](err); ok {
		return apierr.Upstream("FORGE_ERROR", e.Message)
	}
	return err
}

func remoteOp(id, method, path, summary string, status int) huma.Operation {
	return huma.Operation{
		OperationID: id, Method: method, Path: path, Summary: summary, DefaultStatus: status,
		Tags: []string{"remote"}, Errors: []int{400, 401, 403, 404, 409, 422, 424, 503},
	}
}

// remote mounts /remote on public's router, with its own OpenAPI document.
func remote(public *httpapi.API, d *Deps) {
	r := public.Router
	api := public.Sub(httpapi.Config{Title: "AXP Remote Computers", Version: "1", Prefix: "/remote", Docs: true})
	s := d.Tasks

	r.Get("/remote/install.sh", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
		_, _ = fmt.Fprintf(w, installScript, publicURL(d, req))
	})
	r.Get("/remote/dl/{name}", func(w http.ResponseWriter, req *http.Request) {
		name := chi.URLParam(req, "name")
		if !downloadable.MatchString(name) {
			httpapi.WriteError(w, req, apierr.NotFound())
			return
		}
		for dir := range strings.SplitSeq(d.RemoteDist, ":") {
			path := filepath.Join(dir, name)
			if dir != "" && fileExists(path) {
				w.Header().Set("Content-Type", "application/octet-stream")
				http.ServeFile(w, req, path)
				return
			}
		}
		httpapi.WriteError(w, req, apierr.NotFound())
	})

	huma.Register(api, remoteOp("enroll", http.MethodPost, "/remote/v1/enroll", "Trade an install code for the computer's token", 200),
		func(ctx context.Context, in *struct{ Body EnrollIn }) (*httpapi.Body[tasks.Enrolled], error) {
			e, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*tasks.Enrolled, error) { return s.Enroll(ctx, tx, in.Body.Code, in.Body.Report) })
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[tasks.Enrolled]{Body: *e}, nil
		})

	huma.Register(api, remoteOp("report", http.MethodPost, "/remote/v1/report",
		"What setup finds on the computer: its runtimes and their providers; answers with the relay's address and the connector version to install", 200),
		func(ctx context.Context, in *struct {
			RemoteBearer
			Body tasks.Report
		}) (*httpapi.Body[Reported], error) {
			if err := remoteWrite(ctx, d, in.RemoteBearer, func(tx pgx.Tx, c *tasks.RemoteComputer) error {
				return s.Report(ctx, tx, c, in.Body)
			}); err != nil {
				return nil, err
			}
			out := Reported{}
			if s.Relay != nil {
				out.RelayURL, out.ConnectorVersion = s.Relay.BaseURL(), s.ConnectorVersion(ctx)
			}
			return &httpapi.Body[Reported]{Body: out}, nil
		})

	huma.Register(api, remoteOp("currentTask", http.MethodGet, "/remote/v1/current-task",
		"The task whose place a directory is in", 200),
		func(ctx context.Context, in *struct {
			RemoteBearer
			Dir string `query:"dir" minLength:"1" maxLength:"4096"`
		}) (*httpapi.Body[CurrentTask], error) {
			c, err := in.computer(ctx, d)
			if err != nil {
				return nil, err
			}
			id, err := s.CurrentTask(ctx, d.DB, c, in.Dir)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[CurrentTask]{Body: CurrentTask{id}}, nil
		})

	huma.Register(api, remoteOp("remoteGetTask", http.MethodGet, "/remote/v1/tasks/{task_id}", "A task the computer works on", 200),
		func(ctx context.Context, in *RemoteTaskPath) (*httpapi.Body[tasks.TaskDetail], error) {
			c, err := in.computer(ctx, d)
			if err != nil {
				return nil, err
			}
			t, err := s.RemoteTask(ctx, d.DB, c, in.TaskID)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[tasks.TaskDetail]{Body: *t}, nil
		})

	// write is a CLI write on a task the computer works on.
	write := func(id, path, summary string, register func(op huma.Operation)) {
		register(remoteOp(id, http.MethodPost, "/remote/v1/tasks/{task_id}/"+path, summary, 204))
	}
	write("remoteComment", "comments", "Comment as the remote agent", func(o huma.Operation) {
		huma.Register(api, o, func(ctx context.Context, in *struct {
			RemoteTaskPath
			Body CommentIn
		}) (*struct{}, error) {
			return nil, remoteWrite(ctx, d, in.RemoteBearer, func(tx pgx.Tx, c *tasks.RemoteComputer) error {
				return s.RemoteComment(ctx, tx, c, in.TaskID, in.Body.Body)
			})
		})
	})
	write("remoteAssist", "assists", "Ask another agent on the computer to assist, as the web and the tasks tool do", func(o huma.Operation) {
		huma.Register(api, o, func(ctx context.Context, in *struct {
			RemoteTaskPath
			Body tasks.AssistInput
		}) (*struct{}, error) {
			return nil, remoteWrite(ctx, d, in.RemoteBearer, func(tx pgx.Tx, c *tasks.RemoteComputer) error {
				_, err := s.RemoteAssist(ctx, tx, c, in.TaskID, in.Body)
				return err
			})
		})
	})
	write("remoteReview", "review", "Report an assisting agent's structured verdict on its request", func(o huma.Operation) {
		huma.Register(api, o, func(ctx context.Context, in *struct {
			RemoteTaskPath
			Body tasks.ReviewInput
		}) (*struct{}, error) {
			return nil, remoteWrite(ctx, d, in.RemoteBearer, func(tx pgx.Tx, c *tasks.RemoteComputer) error {
				return s.ReportReview(ctx, tx, c, in.TaskID, in.Body)
			})
		})
	})
	write("remoteStatus", "status", "Set the task's status as the remote agent", func(o huma.Operation) {
		huma.Register(api, o, func(ctx context.Context, in *struct {
			RemoteTaskPath
			Body StatusIn
		}) (*struct{}, error) {
			return nil, remoteWrite(ctx, d, in.RemoteBearer, func(tx pgx.Tx, c *tasks.RemoteComputer) error {
				return s.RemoteStatus(ctx, tx, c, in.TaskID, in.Body.Status)
			})
		})
	})
	write("remoteDeliverable", "deliverables", "Record a deliverable (a pull request, a branch)", func(o huma.Operation) {
		huma.Register(api, o, func(ctx context.Context, in *struct {
			RemoteTaskPath
			Body tasks.Deliverable
		}) (*struct{}, error) {
			return nil, remoteWrite(ctx, d, in.RemoteBearer, func(tx pgx.Tx, c *tasks.RemoteComputer) error {
				return s.RecordDeliverable(ctx, tx, c, in.TaskID, in.Body)
			})
		})
	})

	// An artifact for a task the computer works on: a ZIP as the body,
	// title, task and artifact (for a new version) in the query.
	r.Post("/remote/v1/artifacts", remoteUpload(d))

	huma.Register(api, remoteOp("gitCredentials", http.MethodGet, "/remote/v1/git/credentials",
		"The token for git and gh: the user's once they authorized the GitHub App, else the App's", 200),
		func(ctx context.Context, in *struct {
			RemoteBearer
		}) (*httpapi.Body[GitCredentials], error) {
			if _, err := in.computer(ctx, d); err != nil {
				return nil, err
			}
			creds, err := d.GitHub.Credentials(ctx)
			if err != nil {
				return nil, forgeError(err)
			}
			return &httpapi.Body[GitCredentials]{Body: GitCredentials(*creds)}, nil
		})
}

func remoteWrite(ctx context.Context, d *Deps, b RemoteBearer, fn func(pgx.Tx, *tasks.RemoteComputer) error) error {
	c, err := b.computer(ctx, d)
	if err != nil {
		return err
	}
	_, err = pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (struct{}, error) { return struct{}{}, fn(tx, c) })
	return err
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// The axp binaries and the agenvo connectors (agenvo-<kind>-<version>.tgz,
// the relay's version, which setup asks for).
var downloadable = regexp.MustCompile(`^(axp-(linux|darwin)-(amd64|arm64)|agenvo-(paseo|herdr)-[0-9A-Za-z.+-]+\.tgz)$`)

// installScript installs the `axp` binary, which sets up everything else:
// sh -s -- <code> [setup flags]. %[1]s is AXP's address.
const installScript = `#!/bin/sh
# AXP remote computer installer: installs the axp daemon and CLI, which
# then checks this computer's runtimes (Paseo, Herdr), installs the agenvo
# connectors, connects to AXP and registers itself as a user service.
set -eu
AXP_URL='%[1]s'
if [ $# -lt 1 ]; then
	echo "usage: curl -fsSL $AXP_URL/remote/install.sh | sh -s -- <install code>" >&2
	exit 2
fi
case "$(uname -s)" in
Linux) os=linux ;;
Darwin) os=darwin ;;
*) echo "axp: unsupported system $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) echo "axp: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
AXP_HOME="${AXP_HOME:-$HOME/.local/share/axp}"
mkdir -p "$AXP_HOME/bin"
curl -fsSL -o "$AXP_HOME/bin/axp.new" "$AXP_URL/remote/dl/axp-$os-$arch"
chmod +x "$AXP_HOME/bin/axp.new"
mv "$AXP_HOME/bin/axp.new" "$AXP_HOME/bin/axp"
exec "$AXP_HOME/bin/axp" setup --url "$AXP_URL" --code "$@"
`
