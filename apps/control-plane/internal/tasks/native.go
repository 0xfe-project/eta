package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/relay"
)

// A remote agent through the relay, in each runtime's native terms. Native
// ids survive connector restarts, unlike the relay's opaque references, so
// they are what a session keeps.
//
// Where it works is the user's own Paseo and Herdr state: an existing
// workspace, or a worktree the runtime creates itself (Paseo's
// workspaces.create, Herdr's worktree.create). AXP only archives or removes
// what it opened, when the task is done.

// Each connector setup configures has one instance, named after its kind.
func instanceFor(runtime string) string { return runtime }

// native is a session's native agent and what AXP opened for it.
type native struct {
	// Paseo
	AgentID          string `json:"agent_id,omitempty"`
	CreatedWorkspace bool   `json:"created_workspace,omitempty"`
	// Herdr
	Session         string `json:"session,omitempty"`
	Name            string `json:"name,omitempty"`
	TabID           string `json:"tab_id,omitempty"`
	PaneID          string `json:"pane_id,omitempty"`
	CreatedWorktree bool   `json:"created_worktree,omitempty"`
	// Both
	WorkspaceID string `json:"workspace_id,omitempty"`
}

// agentState is a native agent as observed now.
type agentState struct {
	// idle, working, blocked, error or gone.
	Activity string
	// The last user input it received, when the runtime knows (Paseo).
	LastInput time.Time
	// When it last finished a turn, when the runtime knows (Paseo).
	FinishedAt time.Time
	Error      string
}

// LogEntry is one item of a remote agent's transcript.
type LogEntry struct {
	Kind string `json:"kind" enum:"user,assistant,tool,reasoning,terminal,image,other"`
	// An image's file name on the remote computer.
	Text    string `json:"text"`
	Tool    string `json:"tool,omitempty"`
	Command string `json:"command,omitempty"`
	Status  string `json:"status,omitempty"`
	At      string `json:"at,omitempty"`
}

// errUnknown is a write whose outcome the relay could not confirm.
var errUnknown = errors.New("relay could not confirm the outcome")

// unknownOutcome is errUnknown with what the runtime said about it: Paseo
// reports a failed workspace creation as unknown too, with the reason. It is
// still unknown, never a rejection, so nothing is repeated on it.
type unknownOutcome struct{ fault *relay.Fault }

func (e unknownOutcome) Error() string {
	if e.fault == nil || e.fault.Message == "" {
		return errUnknown.Error()
	}
	return e.fault.Message + "（结果未能确认，AXP 不会自动重试）"
}

func (e unknownOutcome) Is(target error) bool { return target == errUnknown }

// unknownNative is the runtime's own error in an unconfirmed outcome, for
// logs.
func unknownNative(err error) string {
	var u unknownOutcome
	if !errors.As(err, &u) || u.fault == nil {
		return ""
	}
	return u.fault.Code + ": " + string(u.fault.Native)
}

type agents struct {
	relay relay.Relay
}

// target is where a call goes: a computer's device and runtime.
type target struct {
	DeviceID string
	Runtime  string
}

func (a agents) call(ctx context.Context, t target, method string, params any, out any) error {
	outcome, err := a.relay.Call(ctx, t.DeviceID, instanceFor(t.Runtime), method, params)
	if err != nil {
		var fault *relay.Fault
		if errors.As(err, &fault) && fault.Code == "unsupported_method" {
			return fmt.Errorf("这台电脑的 agenvo connector 不支持 %s，需要更新：%s", method, updateHint)
		}
		return err
	}
	if outcome.Execution == "unknown" {
		return unknownOutcome{outcome.Error}
	}
	if out != nil && len(outcome.Result) > 0 {
		return json.Unmarshal(outcome.Result, out)
	}
	return nil
}

// updateHint is how a computer gets the connectors AXP serves.
const updateHint = "在 AXP 的 设置 → 远程电脑 中点这台电脑的「更新」，按提示在那台电脑上运行命令"

func (s *sessionRow) target() target { return target{s.DeviceID, s.Runtime} }

func notFound(err error) bool {
	var fault *relay.Fault
	return errors.As(err, &fault) && fault.Code == "not_found"
}

// nativeCode is the runtime's own error code in a rejected call.
func nativeCode(err error) string {
	var fault *relay.Fault
	if !errors.As(err, &fault) || len(fault.Native) == 0 {
		return ""
	}
	var native struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(fault.Native, &native)
	return native.Code
}

// --- places ------------------------------------------------------------------------------

// PlaceProject is a repository a new worktree can branch off.
type PlaceProject struct {
	ID      string  `json:"id" doc:"Paseo's project id, or the Herdr workspace whose repository it is."`
	Name    string  `json:"name"`
	Path    string  `json:"path"`
	Session *string `json:"session,omitempty" doc:"Herdr's session."`
}

// PlaceWorkspace is an existing workspace an agent can work in.
type PlaceWorkspace struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Project string `json:"project,omitempty"`
	// Paseo's id of its project.
	ProjectID string  `json:"-"`
	Kind      string  `json:"kind" enum:"worktree,checkout,directory"`
	Branch    *string `json:"branch,omitempty"`
	Dirty     *bool   `json:"dirty,omitempty"`
	Session   *string `json:"session,omitempty" doc:"Herdr's session."`
}

// Places is where on a computer's runtime an agent can work.
type Places struct {
	Runtime    string           `json:"runtime" enum:"paseo,herdr"`
	Projects   []PlaceProject   `json:"projects"`
	Workspaces []PlaceWorkspace `json:"workspaces"`
}

func (a agents) places(ctx context.Context, t target) (*Places, error) {
	out := &Places{Runtime: t.Runtime, Projects: []PlaceProject{}, Workspaces: []PlaceWorkspace{}}
	switch t.Runtime {
	case "paseo":
		type project struct {
			ProjectID          string `json:"projectId"`
			ProjectDisplayName string `json:"projectDisplayName"`
			ProjectRootPath    string `json:"projectRootPath"`
			ProjectKind        string `json:"projectKind"`
		}
		var list struct {
			Entries []struct {
				project
				ID                 string `json:"id"`
				Name               string `json:"name"`
				WorkspaceDirectory string `json:"workspaceDirectory"`
				WorkspaceKind      string `json:"workspaceKind"`
				GitRuntime         *struct {
					CurrentBranch *string `json:"currentBranch"`
					IsDirty       *bool   `json:"isDirty"`
				} `json:"gitRuntime"`
			} `json:"entries"`
			EmptyProjects []project `json:"emptyProjects"`
		}
		if err := a.call(ctx, t, "paseo.workspaces.list", map[string]any{}, &list); err != nil {
			return nil, err
		}
		seen := map[string]bool{}
		add := func(p project) {
			if !seen[p.ProjectID] && p.ProjectKind == "git" {
				seen[p.ProjectID] = true
				out.Projects = append(out.Projects, PlaceProject{ID: p.ProjectID, Name: p.ProjectDisplayName, Path: p.ProjectRootPath})
			}
		}
		for _, e := range list.Entries {
			add(e.project)
			dir := e.WorkspaceDirectory
			if dir == "" {
				dir = e.ProjectRootPath
			}
			w := PlaceWorkspace{ID: e.ID, Name: e.Name, Path: dir, Project: e.ProjectDisplayName, ProjectID: e.ProjectID, Kind: "directory"}
			switch e.WorkspaceKind {
			case "worktree":
				w.Kind = "worktree"
			case "local_checkout", "checkout":
				w.Kind = "checkout"
			}
			if e.GitRuntime != nil {
				w.Branch, w.Dirty = e.GitRuntime.CurrentBranch, e.GitRuntime.IsDirty
			}
			out.Workspaces = append(out.Workspaces, w)
		}
		for _, p := range list.EmptyProjects {
			add(p)
		}
	case "herdr":
		sessions, err := a.herdrSessions(ctx, t)
		if err != nil {
			return nil, err
		}
		for _, sess := range sessions {
			var workspaces struct {
				Result struct {
					Workspaces []struct {
						ID    string `json:"workspace_id"`
						Label string `json:"label"`
					} `json:"workspaces"`
				} `json:"result"`
			}
			if err := a.call(ctx, t, "workspace.list", sess.ref(), &workspaces); err != nil {
				return nil, err
			}
			// Workspaces carry no directory; their panes do.
			var panes struct {
				Result struct {
					Panes []struct {
						WorkspaceID string `json:"workspace_id"`
						Cwd         string `json:"cwd"`
					} `json:"panes"`
				} `json:"result"`
			}
			if err := a.call(ctx, t, "pane.list", sess.ref(), &panes); err != nil {
				return nil, err
			}
			dirs := map[string]string{}
			for _, p := range panes.Result.Panes {
				if dirs[p.WorkspaceID] == "" {
					dirs[p.WorkspaceID] = p.Cwd
				}
			}
			name := sess.Name
			for _, w := range workspaces.Result.Workspaces {
				out.Workspaces = append(out.Workspaces, PlaceWorkspace{
					ID: w.ID, Name: w.Label, Path: dirs[w.ID], Kind: "directory", Session: &name,
				})
				// A workspace's repository is what a new worktree branches off.
				out.Projects = append(out.Projects, PlaceProject{ID: w.ID, Name: w.Label, Path: dirs[w.ID], Session: &name})
			}
		}
	default:
		return nil, fmt.Errorf("unknown runtime %q", t.Runtime)
	}
	sort.SliceStable(out.Projects, func(i, j int) bool { return out.Projects[i].Name < out.Projects[j].Name })
	return out, nil
}

// --- opening ------------------------------------------------------------------------------

var slugUnsafe = regexp.MustCompile(`[^a-z0-9]+`)

// defaultBranch is axp/<number>-<title slug>.
func defaultBranch(number int64, title string) string {
	slug := strings.Trim(slugUnsafe.ReplaceAllString(strings.ToLower(title), "-"), "-")
	if len(slug) > 40 {
		slug = strings.Trim(slug[:40], "-")
	}
	if slug == "" {
		return fmt.Sprintf("axp/%d", number)
	}
	return fmt.Sprintf("axp/%d-%s", number, slug)
}

// opening is what open needs to know about the task.
type opening struct {
	TaskID string
	Number int64
	Title  string
	Place  Place
	// For an assisting agent.
	Assist bool
}

// open opens the run's place (a new worktree, or an existing workspace) and
// starts the native agent there, without a prompt. It returns the agent and
// the directory it works in; on failure, whatever it already opened.
func (a agents) open(ctx context.Context, s *sessionRow, o opening) (native, string, error) {
	t := s.target()
	label, tabLabel := fmt.Sprintf("AXP #%d %s", o.Number, o.Title), fmt.Sprintf("AXP #%d", o.Number)
	if o.Assist {
		label, tabLabel = label+" · 协助", tabLabel+" 协助"
	}
	branch := deref(o.Place.Branch)
	if branch == "" {
		branch = defaultBranch(o.Number, o.Title)
	}
	switch s.Runtime {
	case "paseo":
		n := native{WorkspaceID: deref(o.Place.WorkspaceID)}
		var dir string
		if o.Place.Kind == PlaceKindWorktree {
			source := map[string]any{"kind": "worktree", "projectId": deref(o.Place.From), "action": "branch-off", "branchName": branch}
			if base := deref(o.Place.Base); base != "" {
				source["baseBranch"] = base
			}
			var created struct {
				Workspace struct {
					ID                 string `json:"id"`
					WorkspaceDirectory string `json:"workspaceDirectory"`
				} `json:"workspace"`
				Error *string `json:"error"`
			}
			if err := a.call(ctx, t, "paseo.workspaces.create", map[string]any{"source": source, "title": label}, &created); err != nil {
				return native{}, "", withBaseHint(err, deref(o.Place.Base))
			}
			if created.Workspace.ID == "" {
				return native{}, "", fmt.Errorf("Paseo 没有建出 worktree：%s", deref(created.Error))
			}
			n.WorkspaceID, n.CreatedWorkspace, dir = created.Workspace.ID, true, created.Workspace.WorkspaceDirectory
		} else {
			places, err := a.places(ctx, t)
			if err != nil {
				return native{}, "", err
			}
			for _, w := range places.Workspaces {
				if w.ID == n.WorkspaceID {
					dir = w.Path
				}
			}
			if dir == "" {
				return native{}, "", errors.New("Paseo 里没有这个工作区了")
			}
		}
		var out struct {
			Agent struct {
				ID string `json:"id"`
			} `json:"agent"`
		}
		if err := a.call(ctx, t, "paseo.agents.create", map[string]any{
			"provider": s.Provider, "cwd": dir, "workspaceId": n.WorkspaceID, "title": label,
		}, &out); err != nil {
			return n, dir, err
		}
		if out.Agent.ID == "" {
			return n, dir, errors.New("Paseo returned no agent")
		}
		n.AgentID = out.Agent.ID
		return n, dir, nil
	case "herdr":
		args, ok := fullAccess[s.Provider]
		if !ok {
			return native{}, "", fmt.Errorf("Herdr 里的 %s 不能以完全权限启动", s.Provider)
		}
		sess, err := a.herdrSession(ctx, t, deref(o.Place.Session))
		if err != nil {
			return native{}, "", err
		}
		n := native{Session: sess.Name, Name: herdrName(s.ID), WorkspaceID: deref(o.Place.WorkspaceID)}
		if o.Place.Kind == PlaceKindWorktree {
			params := merge(sess.ref(), map[string]any{"workspaceId": deref(o.Place.From), "branch": branch, "label": label})
			if base := deref(o.Place.Base); base != "" {
				params["base"] = base
			}
			var created struct {
				Result struct {
					Workspace struct {
						ID string `json:"workspace_id"`
					} `json:"workspace"`
				} `json:"result"`
			}
			if err := a.call(ctx, t, "worktree.create", params, &created); err != nil {
				return native{}, "", err
			}
			n.WorkspaceID, n.CreatedWorktree = created.Result.Workspace.ID, true
		}
		// A tab of its own, so the agent never takes over the user's panes;
		// its environment tells `axp` which task it is on.
		var tab struct {
			Result struct {
				Tab struct {
					ID string `json:"tab_id"`
				} `json:"tab"`
				RootPane struct {
					ID  string `json:"pane_id"`
					Cwd string `json:"cwd"`
				} `json:"root_pane"`
			} `json:"result"`
		}
		if err := a.call(ctx, t, "tab.create", merge(sess.ref(), map[string]any{
			"workspaceId": n.WorkspaceID, "label": tabLabel, "env": map[string]string{"AXP_TASK_ID": o.TaskID},
		}), &tab); err != nil {
			return n, "", err
		}
		n.TabID, n.PaneID = tab.Result.Tab.ID, tab.Result.RootPane.ID
		dir := tab.Result.RootPane.Cwd
		if err := a.call(ctx, t, "agent.start", merge(sess.ref(), map[string]any{
			"name": n.Name, "paneId": n.PaneID, "kind": s.Provider, "args": args,
		}), nil); err != nil {
			return n, dir, err
		}
		return n, dir, a.herdrReady(ctx, t, n)
	}
	return native{}, "", fmt.Errorf("unknown runtime %q", s.Runtime)
}

// errAssigneePlaceGone is the assignee's workspace no longer in its runtime.
var errAssigneePlaceGone = errors.New("Paseo 里没有主执行者的工作区了")

// assistPlace is where an assisting agent works: a new worktree of the
// repository the assignee works in (its project in Paseo, the workspace its
// worktree branches off in Herdr), on a branch of its own. It only reads.
func (a agents) assistPlace(ctx context.Context, t target, p Place, number int64, runID string) (Place, error) {
	from := deref(p.From)
	if p.Kind == PlaceKindWorkspace {
		from = deref(p.WorkspaceID)
		if t.Runtime == "paseo" {
			places, err := a.places(ctx, t)
			if err != nil {
				return Place{}, err
			}
			from = ""
			for _, w := range places.Workspaces {
				if w.ID == deref(p.WorkspaceID) {
					from = w.ProjectID
				}
			}
			if from == "" {
				return Place{}, errAssigneePlaceGone
			}
		}
	}
	branch := fmt.Sprintf("axp/%d-assist-%s", number, strings.ReplaceAll(runID, "-", "")[:8])
	return Place{Kind: PlaceKindWorktree, From: &from, Branch: &branch, Session: p.Session, Name: p.Name}, nil
}

// withBaseHint says how to fix a base branch Paseo did not find: it
// resolves the base among the refs already in the repository (refs/heads/<base>,
// then refs/remotes/origin/<base>; origin/<base> means only the latter) and
// does not fetch first. A branch only on the remote needs fetching there.
func withBaseHint(err error, base string) error {
	if base == "" || !strings.Contains(err.Error(), "Base branch not found") {
		return err
	}
	name := strings.TrimPrefix(base, "origin/")
	return fmt.Errorf("%w。Paseo 只在那台电脑的仓库里已有的引用中找基准分支（本地分支 %s 或远程跟踪分支 origin/%s），不会先 fetch：在那台电脑的仓库里运行 git fetch origin %s 后重新运行任务", err, name, name, name)
}

// fullAccess is the launch flags, per agent Herdr can start for AXP
// (apps/remote's herdrKinds), for running without permission prompts or a
// sandbox: the full access AXP's agents work with. Herdr passes them on as
// they are.
var fullAccess = map[string][]string{
	"codex":  {"--dangerously-bypass-approvals-and-sandbox"},
	"claude": {"--dangerously-skip-permissions", "--settings", `{"sandbox":{"enabled":false}}`},
	"devin":  {"--permission-mode", "dangerous", "--respect-workspace-trust", "false"},
}

// trustDialog is Claude Code's question before it first works in a
// repository; Claude has no launch flag for it. Answering it is the user's
// full-access choice for AXP's agents, and Claude records the trust itself.
const trustDialog = "Is this a project you created or one you trust"

// herdrReady waits for a started agent to take input. Claude's folder-trust
// question is answered Yes; any other blocking screen fails the start.
func (a agents) herdrReady(ctx context.Context, t target, n native) error {
	answered := false
	for range 30 {
		agent, err := a.herdrAgent(ctx, t, n)
		if err == nil && agent != nil && !agent.LaunchPending {
			return nil
		}
		if err == nil && agent != nil && agent.Status == "blocked" && !answered {
			if screen, err := a.herdrScreen(ctx, t, n); err == nil && strings.Contains(screen, trustDialog) {
				// The dialog's options are No, exit, then Yes.
				if err := a.herdrKeys(ctx, t, n, "down", "enter"); err != nil {
					return err
				}
				answered = true
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return errors.New("Herdr 里的智能体没有启动起来，停在了一个需要确认的界面；看看那台电脑上的 Herdr")
}

func merge(a, b map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// herdrName is the agent's name in Herdr, unique per session.
func herdrName(sessionID string) string {
	return "axp-" + strings.ReplaceAll(sessionID, "-", "")[:12]
}

type herdrSession struct {
	Name string
}

func (h herdrSession) ref() map[string]any {
	return map[string]any{"session": h.Name}
}

func (a agents) herdrSessions(ctx context.Context, t target) ([]herdrSession, error) {
	var out struct {
		Items []struct {
			Session           string `json:"session"`
			BackendGeneration string `json:"backendGeneration"`
			Available         *bool  `json:"available"`
		} `json:"items"`
	}
	if err := a.call(ctx, t, "session.list", map[string]any{}, &out); err != nil {
		return nil, err
	}
	var sessions []herdrSession
	for _, item := range out.Items {
		// Connectors before agenvo 0.2 address sessions by generation.
		if item.BackendGeneration != "" {
			return nil, errors.New("这台电脑的 agenvo connector 需要更新：" + updateHint)
		}
		if item.Available == nil || *item.Available {
			sessions = append(sessions, herdrSession{item.Session})
		}
	}
	return sessions, nil
}

// herdrSession is the named Herdr session (the first running one when name
// is empty).
func (a agents) herdrSession(ctx context.Context, t target, name string) (*herdrSession, error) {
	sessions, err := a.herdrSessions(ctx, t)
	if err != nil {
		return nil, err
	}
	for _, s := range sessions {
		if name == "" || s.Name == name {
			return &s, nil
		}
	}
	return nil, errors.New("Herdr 没有在这台电脑上运行")
}

func (a agents) herdrTarget(ctx context.Context, t target, n native) (map[string]any, error) {
	sess, err := a.herdrSession(ctx, t, n.Session)
	if err != nil {
		return nil, err
	}
	return merge(sess.ref(), map[string]any{"name": n.Name}), nil
}

type herdrAgent struct {
	Status        string `json:"agent_status"`
	LaunchPending bool   `json:"launch_pending"`
}

// herdrAgent is the session's agent as Herdr sees it now.
func (a agents) herdrAgent(ctx context.Context, t target, n native) (*herdrAgent, error) {
	params, err := a.herdrTarget(ctx, t, n)
	if err != nil {
		return nil, err
	}
	var out struct {
		Result struct {
			Agent *herdrAgent `json:"agent"`
		} `json:"result"`
	}
	if err := a.call(ctx, t, "agent.get", params, &out); err != nil {
		return nil, err
	}
	return out.Result.Agent, nil
}

func (a agents) herdrScreen(ctx context.Context, t target, n native) (string, error) {
	sess, err := a.herdrSession(ctx, t, n.Session)
	if err != nil {
		return "", err
	}
	var out struct {
		Output string `json:"output"`
	}
	err = a.call(ctx, t, "pane.read", merge(sess.ref(), map[string]any{"paneId": n.PaneID, "lines": 60, "source": "visible"}), &out)
	return out.Output, err
}

func (a agents) herdrKeys(ctx context.Context, t target, n native, keys ...string) error {
	params, err := a.herdrTarget(ctx, t, n)
	if err != nil {
		return err
	}
	params["keys"] = keys
	return a.call(ctx, t, "agent.send-keys", params, nil)
}

// --- running ------------------------------------------------------------------------------

// send hands the agent input. It returns errUnknown when delivery could not
// be confirmed; the caller checks the native state instead of resending.
func (a agents) send(ctx context.Context, s *sessionRow, n native, text string) error {
	t := s.target()
	switch s.Runtime {
	case "paseo":
		return a.call(ctx, t, "paseo.agents.send", map[string]any{"agentId": n.AgentID, "text": text}, nil)
	case "herdr":
		params, err := a.herdrTarget(ctx, t, n)
		if err != nil {
			return err
		}
		params["text"] = text
		return a.call(ctx, t, "agent.prompt", params, nil)
	}
	return fmt.Errorf("unknown runtime %q", s.Runtime)
}

func (a agents) interrupt(ctx context.Context, s *sessionRow, n native) error {
	switch s.Runtime {
	case "paseo":
		return a.call(ctx, s.target(), "paseo.agents.cancel", map[string]any{"agentId": n.AgentID}, nil)
	case "herdr":
		return a.herdrKeys(ctx, s.target(), n, "esc")
	}
	return fmt.Errorf("unknown runtime %q", s.Runtime)
}

func parseTime(s *string) time.Time {
	if s == nil {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339Nano, *s)
	return t
}

func (a agents) state(ctx context.Context, s *sessionRow, n native) (*agentState, error) {
	switch s.Runtime {
	case "paseo":
		var agent struct {
			Status             string  `json:"status"`
			LastUserMessageAt  *string `json:"lastUserMessageAt"`
			AttentionReason    *string `json:"attentionReason"`
			AttentionTimestamp *string `json:"attentionTimestamp"`
			ArchivedAt         *string `json:"archivedAt"`
			LastError          *string `json:"lastError"`
		}
		if err := a.call(ctx, s.target(), "paseo.agents.get", map[string]any{"agentId": n.AgentID}, &agent); err != nil {
			if notFound(err) {
				return &agentState{Activity: "gone"}, nil
			}
			return nil, err
		}
		if agent.ArchivedAt != nil || agent.Status == "closed" {
			return &agentState{Activity: "gone"}, nil
		}
		st := &agentState{LastInput: parseTime(agent.LastUserMessageAt)}
		if agent.AttentionReason != nil && (*agent.AttentionReason == "finished" || *agent.AttentionReason == "error") {
			st.FinishedAt = parseTime(agent.AttentionTimestamp)
		}
		switch agent.Status {
		case "idle":
			st.Activity = "idle"
		case "error":
			st.Activity, st.Error = "error", "Paseo 报告智能体出错"
			if agent.LastError != nil {
				st.Error = *agent.LastError
			}
		default:
			st.Activity = "working"
		}
		return st, nil
	case "herdr":
		agent, err := a.herdrAgent(ctx, s.target(), n)
		if err != nil {
			if notFound(err) {
				return &agentState{Activity: "gone"}, nil
			}
			return nil, err
		}
		if agent == nil {
			return &agentState{Activity: "gone"}, nil
		}
		switch agent.Status {
		case "idle", "done":
			return &agentState{Activity: "idle"}, nil
		case "blocked":
			return &agentState{Activity: "blocked"}, nil
		}
		return &agentState{Activity: "working"}, nil
	}
	return nil, fmt.Errorf("unknown runtime %q", s.Runtime)
}

// LogPage is part of a run's transcript, oldest first, and where the part
// before it starts.
type LogPage struct {
	Entries []LogEntry
	// Older reads the entries before these; empty at the start.
	Older string
}

// Entries a Paseo transcript page asks for at most. The connector refuses
// any answer over 64 KiB (result_too_large) rather than cut it, and a few
// commands' output reach that: on a refusal, a page asks for half as many.
const logPage = 20

// log is a page of the agent's transcript, oldest first: the latest one, or
// the one before older (a page's Older).
func (a agents) log(ctx context.Context, s *sessionRow, n native, older string) (*LogPage, error) {
	switch s.Runtime {
	case "paseo":
		return a.paseoLog(ctx, s, n, older)
	case "herdr":
		params, err := a.herdrTarget(ctx, s.target(), n)
		if err != nil {
			return nil, err
		}
		var out struct {
			Output string `json:"output"`
		}
		params["source"] = "recent"
		// Wide lines can make the screen too large for the relay.
		for _, lines := range []int{300, 150, 80} {
			params["lines"] = lines
			if err = a.call(ctx, s.target(), "agent.read", params, &out); !tooLarge(err) {
				break
			}
		}
		if err != nil {
			return nil, err
		}
		return &LogPage{Entries: []LogEntry{{Kind: "terminal", Text: out.Output}}}, nil
	}
	return nil, fmt.Errorf("unknown runtime %q", s.Runtime)
}

func tooLarge(err error) bool {
	var fault *relay.Fault
	return errors.As(err, &fault) && fault.Code == "result_too_large"
}

// paseoCursor is a position in Paseo's timeline: entries before seq, in one
// epoch (a timeline rebuilt from the provider starts a new one).
type paseoCursor struct {
	Epoch string `json:"epoch"`
	Seq   int64  `json:"seq"`
}

func (c paseoCursor) String() string { return fmt.Sprintf("%d:%s", c.Seq, c.Epoch) }

func parseCursor(s string) (*paseoCursor, bool) {
	seq, epoch, ok := strings.Cut(s, ":")
	n, err := strconv.ParseInt(seq, 10, 64)
	if !ok || err != nil || n < 0 || epoch == "" {
		return nil, false
	}
	return &paseoCursor{epoch, n}, true
}

type paseoEntry struct {
	Timestamp string `json:"timestamp"`
	Item      struct {
		Type   string `json:"type"`
		Text   string `json:"text"`
		Name   string `json:"name"`
		Status string `json:"status"`
		Detail struct {
			Command string `json:"command"`
			// A string for a shell command; any value for a tool Paseo
			// does not know.
			Output json.RawMessage `json:"output"`
		} `json:"detail"`
	} `json:"item"`
}

// Paseo writes an image a provider shows (a screenshot an agent reads) to a
// temporary file on the remote computer, named after its content's hash, and
// puts it in the timeline as a message linking to it by a local path. The
// same pattern Paseo's own replay recognizes them by.
var paseoImage = regexp.MustCompile(`^!\[[^\]]*\]\([^)]*paseo-attachments(?:-[^/\\)]+)?[/\\]+(?:[^/\\)]+[/\\]+)?([0-9a-f]{64}\.[a-z0-9]+)\)$`)

// outputText is a tool output as text: a string as is, anything else as JSON.
func outputText(raw json.RawMessage) string {
	var s string
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(raw)
}

func (e paseoEntry) entry() LogEntry {
	entry := LogEntry{Text: e.Item.Text, At: e.Timestamp}
	switch e.Item.Type {
	case "user_message":
		entry.Kind = "user"
	case "assistant_message":
		entry.Kind = "assistant"
		// Only on that computer, beyond the relay's reach: AXP says what
		// it is rather than link a path no browser can open.
		if m := paseoImage.FindStringSubmatch(strings.TrimSpace(entry.Text)); m != nil {
			entry.Kind, entry.Text = "image", m[1]
		}
	case "reasoning":
		entry.Kind = "reasoning"
	case "tool_call":
		entry.Kind, entry.Tool, entry.Command, entry.Status, entry.Text = "tool", e.Item.Name, e.Item.Detail.Command, e.Item.Status, outputText(e.Item.Detail.Output)
	default:
		entry.Kind = "other"
		if entry.Text == "" {
			entry.Text = e.Item.Type
		}
	}
	return entry
}

// paseoLog reads the entries before older (or the latest ones), as many as
// the relay can carry in one answer.
func (a agents) paseoLog(ctx context.Context, s *sessionRow, n native, older string) (*LogPage, error) {
	params := map[string]any{"agentId": n.AgentID, "direction": "before"}
	if older != "" {
		cursor, ok := parseCursor(older)
		if !ok {
			return nil, errBadCursor
		}
		params["cursor"] = cursor
	}
	var out struct {
		Entries     []paseoEntry `json:"entries"`
		StartCursor *paseoCursor `json:"startCursor"`
		HasOlder    bool         `json:"hasOlder"`
		StaleCursor bool         `json:"staleCursor"`
		Reset       bool         `json:"reset"`
	}
	var err error
	for limit := logPage; ; limit /= 2 {
		params["limit"] = limit
		// An entry too large on its own stays unread: only Paseo knows
		// where it ends, so there is nothing to step over it with.
		if err = a.call(ctx, s.target(), "paseo.agents.history", params, &out); !tooLarge(err) || limit == 1 {
			break
		}
	}
	if err != nil {
		return nil, err
	}
	// The timeline was rebuilt: a cursor into the old one means nothing.
	if out.StaleCursor || out.Reset {
		return nil, errStaleCursor
	}
	page := &LogPage{Entries: make([]LogEntry, 0, len(out.Entries))}
	for _, e := range out.Entries {
		page.Entries = append(page.Entries, e.entry())
	}
	if out.HasOlder && out.StartCursor != nil && len(out.Entries) > 0 {
		page.Older = out.StartCursor.String()
	}
	return page, nil
}

var (
	errBadCursor   = errors.New("invalid log cursor")
	errStaleCursor = errors.New("the remote agent's timeline was rebuilt")
)

// cleanup archives or removes what AXP opened for a session whose task is
// done, and says what it did. A Herdr worktree with uncommitted changes is
// kept: Herdr refuses to remove it.
func (a agents) cleanup(ctx context.Context, s *sessionRow, n native) (string, error) {
	t := s.target()
	if !n.CreatedWorkspace && !n.CreatedWorktree && n.AgentID == "" && n.TabID == "" {
		return "AXP 没有在远程电脑上留下需要收尾的东西", nil
	}
	switch s.Runtime {
	case "paseo":
		if n.CreatedWorkspace {
			if err := a.call(ctx, t, "paseo.workspaces.archive", map[string]any{"workspaceId": n.WorkspaceID}, nil); err != nil && !notFound(err) {
				return "", err
			}
			return "归档了 AXP 开的 Paseo worktree 工作区，分支保留", nil
		}
		if err := a.call(ctx, t, "paseo.agents.archive", map[string]any{"agentId": n.AgentID}, nil); err != nil && !notFound(err) {
			return "", err
		}
		return "归档了 AXP 开的 Paseo 智能体", nil
	case "herdr":
		sess, err := a.herdrSession(ctx, t, n.Session)
		if err != nil {
			return "", err
		}
		if n.CreatedWorktree {
			err := a.call(ctx, t, "worktree.remove", merge(sess.ref(), map[string]any{"workspaceId": n.WorkspaceID}), nil)
			if strings.HasPrefix(nativeCode(err), "dirty_worktree") {
				return "AXP 开的 Herdr worktree 里有未提交的改动，保留了它", nil
			}
			if err != nil && !notFound(err) {
				return "", err
			}
			return "删除了 AXP 开的 Herdr worktree，分支保留", nil
		}
		if err := a.call(ctx, t, "tab.close", merge(sess.ref(), map[string]any{"tabId": n.TabID}), nil); err != nil && !notFound(err) {
			return "", err
		}
		return "关掉了 AXP 在 Herdr 工作区里开的 tab", nil
	}
	return "", fmt.Errorf("unknown runtime %q", s.Runtime)
}
