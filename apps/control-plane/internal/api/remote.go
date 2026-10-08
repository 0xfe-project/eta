package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/apierr"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

// /remote: what remote computers call, the one path outside the edge's
// access control (Cloudflare Access bypasses it). Every endpoint
// authenticates itself: the install command's one-time code, or the
// computer's token (Authorization: Bearer) for its daemon and its CLI.

type RemoteBearer struct {
	Authorization string `header:"Authorization" doc:"Bearer <the computer's token>"`
}

func (b RemoteBearer) computer(ctx context.Context, d *Deps) (*tasks.RemoteComputer, error) {
	token, _ := strings.CutPrefix(b.Authorization, "Bearer ")
	return tasks.Authenticate(ctx, d.DB, token)
}

type EnrollIn struct {
	Code string `json:"code" minLength:"1" maxLength:"100"`
}

type PreparedIn struct {
	Workspace string `json:"workspace" minLength:"1" maxLength:"1024"`
}

type StatusIn struct {
	Status string `json:"status" enum:"in_progress,in_review,blocked"`
}

type RemoteTaskPath struct {
	RemoteBearer
	TaskID string `path:"task_id"`
}

// GitCredentials are the GitHub App's installation token, for git and gh.
type GitCredentials struct {
	Token     string         `json:"token"`
	ExpiresAt int64          `json:"expires_at"`
	Identity  map[string]any `json:"identity,omitempty"`
}

func remoteOp(id, method, path, summary string, status int) huma.Operation {
	return huma.Operation{
		OperationID: id, Method: method, Path: path, Summary: summary, DefaultStatus: status,
		Tags: []string{"remote"}, Errors: []int{400, 401, 403, 404, 409, 422, 502, 503},
	}
}

// remote mounts /remote on r.
func remote(r chi.Router, d *Deps) {
	api := humachi.New(r, config("AXP Remote Computers", "1", "/remote", true))
	s := d.Tasks

	r.Get("/remote/install.sh", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
		_, _ = fmt.Fprintf(w, installScript, publicURL(d, req))
	})
	r.Get("/remote/dl/{name}", func(w http.ResponseWriter, req *http.Request) {
		name := chi.URLParam(req, "name")
		if !downloadable.MatchString(name) {
			writeJSON(w, newError(req.Context(), 404, ""))
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
		writeJSON(w, newError(req.Context(), 404, ""))
	})

	huma.Register(api, remoteOp("enroll", http.MethodPost, "/remote/v1/enroll", "Trade an install code for the computer's token", 200),
		func(ctx context.Context, in *struct{ Body EnrollIn }) (*body[tasks.Enrolled], error) {
			e, err := inTx(ctx, d, func(tx pgx.Tx) (*tasks.Enrolled, error) { return s.Enroll(ctx, tx, in.Body.Code) })
			if err != nil {
				return nil, err
			}
			return &body[tasks.Enrolled]{*e}, nil
		})

	huma.Register(api, remoteOp("heartbeat", http.MethodPost, "/remote/v1/heartbeat",
		"The daemon's report; the answer lists workspaces to prepare", 200),
		func(ctx context.Context, in *struct {
			RemoteBearer
			Body tasks.Heartbeat
		}) (*body[tasks.HeartbeatReply], error) {
			c, err := in.computer(ctx, d)
			if err != nil {
				return nil, err
			}
			reply, err := inTx(ctx, d, func(tx pgx.Tx) (*tasks.HeartbeatReply, error) { return s.Heartbeat(ctx, tx, c, in.Body) })
			if err != nil {
				return nil, err
			}
			return &body[tasks.HeartbeatReply]{*reply}, nil
		})

	huma.Register(api, remoteOp("prepared", http.MethodPost, "/remote/v1/runs/{run_id}/prepared", "A run's workspace is ready", 204),
		func(ctx context.Context, in *struct {
			RemoteBearer
			RunID string `path:"run_id"`
			Body  PreparedIn
		}) (*struct{}, error) {
			c, err := in.computer(ctx, d)
			if err != nil {
				return nil, err
			}
			_, err = inTx(ctx, d, func(tx pgx.Tx) (struct{}, error) {
				return struct{}{}, s.Prepared(ctx, tx, c, in.RunID, in.Body.Workspace)
			})
			return nil, err
		})

	huma.Register(api, remoteOp("remoteGetTask", http.MethodGet, "/remote/v1/tasks/{task_id}", "A task the computer works on", 200),
		func(ctx context.Context, in *RemoteTaskPath) (*body[tasks.TaskDetail], error) {
			c, err := in.computer(ctx, d)
			if err != nil {
				return nil, err
			}
			t, err := s.RemoteTask(ctx, d.DB, c, in.TaskID)
			if err != nil {
				return nil, err
			}
			return &body[tasks.TaskDetail]{*t}, nil
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
	write("remoteCheckout", "checkouts", "Record a repository checked out for the task", func(o huma.Operation) {
		huma.Register(api, o, func(ctx context.Context, in *struct {
			RemoteTaskPath
			Body tasks.Checkout
		}) (*struct{}, error) {
			return nil, remoteWrite(ctx, d, in.RemoteBearer, func(tx pgx.Tx, c *tasks.RemoteComputer) error {
				return s.RecordCheckout(ctx, tx, c, in.TaskID, in.Body)
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

	huma.Register(api, remoteOp("gitCredentials", http.MethodGet, "/remote/v1/git/credentials",
		"The GitHub App's token for git and gh", 200),
		func(ctx context.Context, in *RemoteBearer) (*body[GitCredentials], error) {
			c, err := in.computer(ctx, d)
			if err != nil {
				return nil, err
			}
			creds, err := forgeCredentials(ctx, d.ForgeURL, "computer-"+c.ID)
			if err != nil {
				return nil, err
			}
			return &body[GitCredentials]{*creds}, nil
		})
}

func remoteWrite(ctx context.Context, d *Deps, b RemoteBearer, fn func(pgx.Tx, *tasks.RemoteComputer) error) error {
	c, err := b.computer(ctx, d)
	if err != nil {
		return err
	}
	_, err = inTx(ctx, d, func(tx pgx.Tx) (struct{}, error) { return struct{}{}, fn(tx, c) })
	return err
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

var downloadable = regexp.MustCompile(`^(axp-(linux|darwin)-(amd64|arm64)|agenvo-(paseo|herdr)\.tgz)$`)

// forgeCredentials asks the forge service for the GitHub App's token, as
// the runtime gateway would for an agent.
func forgeCredentials(ctx context.Context, forgeURL, caller string) (*GitCredentials, error) {
	if forgeURL == "" {
		return nil, apierr.New(503, "FORGE_UNAVAILABLE", "代码托管服务不可用。")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(forgeURL, "/")+"/forge/credentials", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-AXP-Agent-Id", caller)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, apierr.New(503, "FORGE_UNAVAILABLE", "代码托管服务不可用。")
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		if e.Error.Message == "" {
			e.Error.Message = "GitHub 还没有连接。"
		}
		return nil, apierr.New(502, "FORGE_ERROR", e.Error.Message)
	}
	var creds GitCredentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, err
	}
	return &creds, nil
}

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
