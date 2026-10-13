package tasks

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/packages/service-go/pg"
)

// What an agent did on a remote computer through the agenvo plugin, for its
// transcript: each workspace or worktree its execute script created or
// opened, read from the script's own native calls (relay.Record), never from
// its code or what it returned. Other calls are left to the tool's line.

// Operation is one native call that made or opened a place to work.
type Operation struct {
	Action string `json:"action"`
	// completed: it is there. accepted: the runtime took it but had not
	// made it yet. failed: it was refused. unknown: it may or may not have
	// happened.
	Status   string `json:"status"`
	Runtime  string `json:"runtime"`
	Computer string `json:"computer,omitempty"`
	ID       string `json:"id,omitempty"`
	Name     string `json:"name,omitempty"`
	Project  string `json:"project,omitempty"`
	Path     string `json:"path,omitempty"`
	Branch   string `json:"branch,omitempty"`
	Base     string `json:"base,omitempty"`
	Error    string `json:"error,omitempty"`
}

// OperationsMeta is the _meta key of a tool result's operations.
const OperationsMeta = "axp/operations"

// operationMethods are the native methods operations are read from, each
// with its runtime (Herdr's carry no prefix).
var operationMethods = map[string]string{
	"paseo.workspaces.create": "paseo",
	"workspace.create":        "herdr",
	"worktree.create":         "herdr",
	"worktree.open":           "herdr",
}

// maxOperations is how many a tool call shows.
const maxOperations = 20

// AgenvoMCP is one request to the relay's MCP endpoint, for the agenvo
// plugin; an execute call's answer carries the operations its script did.
func (s *Service) AgenvoMCP(ctx context.Context, db pg.DB, body []byte, header http.Header) (*relay.Answer, error) {
	methods := make([]string, 0, len(operationMethods))
	for m := range operationMethods {
		methods = append(methods, m)
	}
	body, recording := relay.Record(body, methods)
	answer, err := s.Relay.MCP(ctx, body, header)
	if err != nil || recording == nil || answer.Status >= 300 {
		return answer, err
	}
	answer.Body = recording.Restore(answer.Header.Get("Content-Type"), answer.Body, func(calls []relay.ScriptCall) map[string]any {
		ops := operations(calls, computerRuntimes(ctx, db, calls))
		if len(ops) == 0 {
			return nil
		}
		return map[string]any{OperationsMeta: ops}
	})
	return answer, nil
}

type computerRuntime struct{ computer, kind string }

// computerRuntimes are the AXP computers and runtimes the calls' devices
// are, where they are any.
func computerRuntimes(ctx context.Context, db pg.DB, calls []relay.ScriptCall) map[string]computerRuntime {
	var devices []string
	for _, c := range calls {
		if _, ok := operationMethods[c.Method]; ok && c.DeviceID != "" {
			devices = append(devices, c.DeviceID)
		}
	}
	out := map[string]computerRuntime{}
	if len(devices) == 0 || db == nil {
		return out
	}
	rows, err := pg.All[struct {
		DeviceID string `db:"device_id"`
		Kind     string `db:"kind"`
		Name     string `db:"name"`
	}](ctx, db, `SELECT r.device_id, r.kind, c.name FROM computer_runtime r JOIN computer c ON c.id = r.computer_id
		WHERE r.device_id = ANY($1)`, devices)
	if err != nil {
		slog.WarnContext(ctx, "agenvo operations: reading computers failed", "error", err)
		return out
	}
	for _, r := range rows {
		out[r.DeviceID] = computerRuntime{r.Name, r.Kind}
	}
	return out
}

// operations are the calls that made or opened a place, as far as they show.
func operations(calls []relay.ScriptCall, devices map[string]computerRuntime) []Operation {
	ops := []Operation{}
	for _, c := range calls {
		runtime, ok := operationMethods[c.Method]
		if !ok {
			continue
		}
		device := devices[c.DeviceID]
		// A Herdr method on anything but Herdr is not one.
		if runtime == "herdr" && device.kind != "herdr" && (device.kind != "" || c.InstanceID != "herdr") {
			continue
		}
		op := Operation{Runtime: runtime, Computer: device.computer}
		if runtime == "paseo" {
			paseoOperation(&op, c)
		} else {
			herdrOperation(&op, c)
		}
		op.Status, op.Error = operationStatus(c, op)
		ops = append(ops, clip(op))
		if len(ops) == maxOperations {
			break
		}
	}
	return ops
}

func paseoOperation(op *Operation, c relay.ScriptCall) {
	var p struct {
		Source struct {
			Kind       string `json:"kind"`
			Path       string `json:"path"`
			ProjectID  string `json:"projectId"`
			RefName    string `json:"refName"`
			BaseBranch string `json:"baseBranch"`
			BranchName string `json:"branchName"`
		} `json:"source"`
		Title string `json:"title"`
	}
	var r struct {
		Workspace *struct {
			ID                 string `json:"id"`
			Name               string `json:"name"`
			ProjectDisplayName string `json:"projectDisplayName"`
			ProjectRootPath    string `json:"projectRootPath"`
			WorkspaceDirectory string `json:"workspaceDirectory"`
			GitRuntime         *struct {
				CurrentBranch *string `json:"currentBranch"`
			} `json:"gitRuntime"`
		} `json:"workspace"`
	}
	_ = json.Unmarshal(c.Params, &p)
	_ = json.Unmarshal(c.Result, &r)
	switch {
	case p.Source.Kind == "worktree":
		op.Action = "create_worktree"
	case p.Source.Kind == "directory" && p.Source.ProjectID == "":
		// A directory of no project Paseo knows yet becomes one.
		op.Action = "add_project"
	default:
		// In a project, or as far as a call without its parameters shows.
		op.Action = "create_workspace"
	}
	op.Name, op.Path = p.Title, p.Source.Path
	op.Branch, op.Base = first(p.Source.BranchName, p.Source.RefName), p.Source.BaseBranch
	if w := r.Workspace; w != nil {
		op.ID, op.Project = w.ID, w.ProjectDisplayName
		op.Name, op.Path = first(w.Name, op.Name), first(w.WorkspaceDirectory, w.ProjectRootPath, op.Path)
		if w.GitRuntime != nil && w.GitRuntime.CurrentBranch != nil {
			op.Branch = first(*w.GitRuntime.CurrentBranch, op.Branch)
		}
	}
}

func herdrOperation(op *Operation, c relay.ScriptCall) {
	var p struct {
		Cwd    string `json:"cwd"`
		Path   string `json:"path"`
		Branch string `json:"branch"`
		Base   string `json:"base"`
		Label  string `json:"label"`
	}
	var r struct {
		Result struct {
			Workspace struct {
				ID       string `json:"workspace_id"`
				Label    string `json:"label"`
				Worktree *struct {
					RepoName string `json:"repo_name"`
				} `json:"worktree"`
			} `json:"workspace"`
			Worktree *struct {
				Branch string `json:"branch"`
				Path   string `json:"path"`
			} `json:"worktree"`
			RootPane *struct {
				Cwd string `json:"cwd"`
			} `json:"root_pane"`
		} `json:"result"`
	}
	_ = json.Unmarshal(c.Params, &p)
	_ = json.Unmarshal(c.Result, &r)
	op.Action = map[string]string{
		"workspace.create": "create_workspace", "worktree.create": "create_worktree", "worktree.open": "open_worktree",
	}[c.Method]
	op.Name, op.Branch, op.Base = p.Label, p.Branch, p.Base
	op.Path = first(p.Path, p.Cwd)
	w := r.Result.Workspace
	op.ID, op.Name = w.ID, first(w.Label, op.Name)
	if w.Worktree != nil {
		op.Project = w.Worktree.RepoName
	}
	if t := r.Result.Worktree; t != nil {
		op.Path, op.Branch = first(t.Path, op.Path), first(t.Branch, op.Branch)
	} else if pane := r.Result.RootPane; pane != nil {
		op.Path = first(pane.Cwd, op.Path)
	}
}

// operationStatus is what became of the call. Accepted is not done: only
// the place it returns is, and Paseo's answer without one says why, or that
// it is still being made. An unconfirmed call is unknown, never failed.
func operationStatus(c relay.ScriptCall, op Operation) (string, string) {
	reason := faultText(c.Error)
	switch c.Execution {
	case "accepted":
		if op.ID != "" {
			return "completed", ""
		}
		var r struct {
			Error     *string `json:"error"`
			ErrorCode string  `json:"errorCode"`
			Creation  *struct {
				Phase          string  `json:"phase"`
				Error          *string `json:"error"`
				OutcomeUnknown bool    `json:"outcomeUnknown"`
			} `json:"creation"`
		}
		_ = json.Unmarshal(c.Result, &r)
		why := first(deref(r.Error), r.ErrorCode)
		if r.Creation != nil {
			why = first(why, deref(r.Creation.Error))
			if r.Creation.OutcomeUnknown {
				return "unknown", oneLine(why)
			}
			if r.Creation.Phase == "failed" {
				return "failed", oneLine(why)
			}
		}
		if why != "" {
			return "failed", oneLine(why)
		}
		return "accepted", ""
	case "rejected", "not_started":
		return "failed", reason
	default:
		// unknown, starting, or not settled when the script ended.
		return "unknown", reason
	}
}

// faultText is a refusal as the runtime put it, else as the relay did.
func faultText(f *relay.Fault) string {
	if f == nil {
		return ""
	}
	var native struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(f.Native, &native)
	code, message := first(native.Code, f.Code), first(native.Message, f.Message)
	if message == "" || message == code {
		return code
	}
	return oneLine(code + ": " + message)
}

// oneLine is s on one line, its lines joined.
func oneLine(s string) string {
	var lines []string
	for line := range strings.SplitSeq(s, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, " · ")
}

func clip(op Operation) Operation {
	cut := func(s string, n int) string {
		if r := []rune(s); len(r) > n {
			return string(r[:n-1]) + "…"
		}
		return s
	}
	op.Computer, op.ID, op.Name, op.Project = cut(op.Computer, 100), cut(op.ID, 256), cut(op.Name, 200), cut(op.Project, 200)
	op.Path, op.Branch, op.Base, op.Error = cut(op.Path, 1000), cut(op.Branch, 256), cut(op.Base, 256), cut(op.Error, 300)
	return op
}

func first(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
