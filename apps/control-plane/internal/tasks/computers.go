package tasks

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/apierr"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/jsontime"
	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/jackc/pgx/v5"
)

// Remote computers. A computer is one `axp` daemon: the install command's
// one-time code enrolls it and gives it a token, which it and the CLI on that
// computer use under /remote. The daemon runs an agenvo connector per runtime
// (Paseo, Herdr); each pairs with the relay as its own device, which the user
// approves here after comparing the fingerprint the daemon printed.

const (
	// EnrollFor is how long an install command works.
	EnrollFor = 24 * time.Hour
	// A daemon heartbeats every few seconds; one silent for longer is offline.
	onlineWithin = 30 * time.Second
	// MaxActiveRuns is how many runs a computer works on at once.
	MaxActiveRuns = 4
)

var Runtimes = []string{"paseo", "herdr"}

type computerRow struct {
	ID              string     `db:"id"`
	Name            string     `db:"name"`
	EnrollCodeHash  *string    `db:"enroll_code_hash"`
	EnrollExpiresAt *time.Time `db:"enroll_expires_at"`
	TokenHash       *string    `db:"token_hash"`
	Hostname        *string    `db:"hostname"`
	OS              *string    `db:"os"`
	Arch            *string    `db:"arch"`
	WorkspaceRoot   *string    `db:"workspace_root"`
	CLIPath         *string    `db:"cli_path"`
	LastSeenAt      *time.Time `db:"last_seen_at"`
	CreatedAt       time.Time  `db:"created_at"`
}

func (c *computerRow) online() bool {
	return c.LastSeenAt != nil && time.Since(*c.LastSeenAt) < onlineWithin
}

type computerRuntimeRow struct {
	ComputerID         string    `db:"computer_id"`
	Kind               string    `db:"kind"`
	Providers          []string  `db:"providers"`
	PairingCode        *string   `db:"pairing_code"`
	PairingFingerprint *string   `db:"pairing_fingerprint"`
	DeviceID           *string   `db:"device_id"`
	Error              *string   `db:"error"`
	UpdatedAt          time.Time `db:"updated_at"`
}

type ComputerRuntime struct {
	Kind      string   `json:"kind" enum:"paseo,herdr"`
	Providers []string `json:"providers"`
	// pairing: waiting for the user to approve the device; needs_approval:
	// the device changed its runtime and waits for approval again.
	State string `json:"state" enum:"pairing,needs_approval,online,offline,error"`
	// The fingerprint to compare with the daemon's terminal before approving.
	Fingerprint *string `json:"fingerprint" nullable:"true"`
	Error       *string `json:"error" nullable:"true"`
}

type Computer struct {
	ID            string         `json:"id"`
	Name          string         `json:"name"`
	Enrolled      bool           `json:"enrolled"`
	Online        bool           `json:"online"`
	Hostname      *string        `json:"hostname" nullable:"true"`
	OS            *string        `json:"os" nullable:"true"`
	Arch          *string        `json:"arch" nullable:"true"`
	WorkspaceRoot *string        `json:"workspace_root" nullable:"true"`
	LastSeenAt    *jsontime.Time `json:"last_seen_at" nullable:"true"`
	// Until it enrolls: when the install command stops working.
	EnrollExpiresAt *jsontime.Time    `json:"enroll_expires_at" nullable:"true"`
	Runtimes        []ComputerRuntime `json:"runtimes"`
	ActiveRuns      int64             `json:"active_runs"`
	CreatedAt       jsontime.Time     `json:"created_at"`
}

type Computers struct {
	Computers []Computer `json:"computers"`
	// Whether a relay is set up; without one nothing can be added.
	RelayConfigured bool    `json:"relay_configured"`
	RelayOrigin     *string `json:"relay_origin" nullable:"true"`
	// The relay could not be asked for its devices' state.
	RelayError *string `json:"relay_error" nullable:"true"`
}

func secret(prefix string) string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return prefix + base64.RawURLEncoding.EncodeToString(b)
}

func digest(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// ListComputers is every computer with its runtimes' state on the relay.
func (s *Service) ListComputers(ctx context.Context, db store.DB) (*Computers, error) {
	out := &Computers{Computers: []Computer{}, RelayConfigured: s.Relay != nil}
	var state *relay.State
	if s.Relay != nil {
		origin := s.Relay.Origin()
		out.RelayOrigin = &origin
		var err error
		if state, err = s.Relay.State(ctx); err != nil {
			message := err.Error()
			out.RelayError = &message
			slog.WarnContext(ctx, "Relay state unavailable", "error", err)
		}
	}
	rows, err := chat.All[computerRow](ctx, db, "SELECT * FROM computer ORDER BY created_at")
	if err != nil {
		return nil, err
	}
	runtimes, err := chat.All[computerRuntimeRow](ctx, db, "SELECT * FROM computer_runtime ORDER BY kind")
	if err != nil {
		return nil, err
	}
	active, err := chat.All[struct {
		ComputerID string `db:"computer_id"`
		N          int64  `db:"n"`
	}](ctx, db, `SELECT computer_id, count(*) AS n FROM task_run WHERE status IN ('preparing', 'starting', 'running')
		AND computer_id IS NOT NULL GROUP BY computer_id`)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		c := Computer{
			ID: r.ID, Name: r.Name, Enrolled: r.TokenHash != nil, Online: r.online(), Hostname: r.Hostname, OS: r.OS,
			Arch: r.Arch, WorkspaceRoot: r.WorkspaceRoot, LastSeenAt: jsontime.Ptr(r.LastSeenAt),
			Runtimes: []ComputerRuntime{}, CreatedAt: jsontime.From(r.CreatedAt),
		}
		if r.TokenHash == nil {
			c.EnrollExpiresAt = jsontime.Ptr(r.EnrollExpiresAt)
		}
		for _, rt := range runtimes {
			if rt.ComputerID == r.ID {
				c.Runtimes = append(c.Runtimes, runtimeState(rt, state, r.online()))
			}
		}
		for _, a := range active {
			if a.ComputerID == r.ID {
				c.ActiveRuns = a.N
			}
		}
		out.Computers = append(out.Computers, c)
	}
	return out, nil
}

func runtimeState(rt *computerRuntimeRow, state *relay.State, daemonOnline bool) ComputerRuntime {
	out := ComputerRuntime{Kind: rt.Kind, Providers: rt.Providers, Error: rt.Error, State: "offline"}
	if out.Providers == nil {
		out.Providers = []string{}
	}
	if rt.DeviceID == nil {
		if rt.PairingCode != nil {
			out.State, out.Fingerprint = "pairing", rt.PairingFingerprint
		} else if rt.Error != nil {
			out.State = "error"
		}
		return out
	}
	if state == nil {
		return out
	}
	for _, d := range state.Devices {
		if d.ID != *rt.DeviceID || d.Revoked {
			continue
		}
		for _, inst := range d.Instances {
			if inst.InstanceID != instanceFor(rt.Kind) {
				continue
			}
			if !inst.Approved {
				fingerprint := inst.Fingerprint
				out.State, out.Fingerprint = "needs_approval", &fingerprint
				return out
			}
			if d.Online && inst.Available && daemonOnline {
				out.State = "online"
			}
		}
	}
	return out
}

// Enrollment is a new computer and its one-time install code.
type Enrollment struct {
	Computer Computer `json:"computer"`
	Code     string   `json:"code" doc:"The install command's code; shown once."`
}

func (s *Service) CreateComputer(ctx context.Context, tx pgx.Tx, name string) (*Enrollment, error) {
	if s.Relay == nil {
		return nil, relayUnavailable()
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, invalid("电脑需要一个名字。")
	}
	code := secret("axpe_")
	now := chat.Now()
	r := &computerRow{ID: chat.NewID(), Name: name, CreatedAt: now}
	expires := now.Add(EnrollFor)
	r.EnrollExpiresAt = &expires
	if _, err := tx.Exec(ctx, `INSERT INTO computer (id, name, enroll_code_hash, enroll_expires_at, created_at)
		VALUES ($1, $2, $3, $4, $5)`, r.ID, r.Name, digest(code), expires, now); err != nil {
		return nil, err
	}
	return &Enrollment{Code: code, Computer: Computer{
		ID: r.ID, Name: r.Name, Runtimes: []ComputerRuntime{}, CreatedAt: jsontime.From(now), EnrollExpiresAt: jsontime.Ptr(&expires),
	}}, nil
}

// RenewEnrollment issues a new install code for a computer that has not
// enrolled yet.
func (s *Service) RenewEnrollment(ctx context.Context, tx pgx.Tx, id string) (*Enrollment, error) {
	r, err := computer(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if r.TokenHash != nil {
		return nil, apierr.New(409, "COMPUTER_ENROLLED", "这台电脑已经接入。")
	}
	code := secret("axpe_")
	expires := chat.Now().Add(EnrollFor)
	if _, err := tx.Exec(ctx, "UPDATE computer SET enroll_code_hash = $2, enroll_expires_at = $3 WHERE id = $1",
		r.ID, digest(code), expires); err != nil {
		return nil, err
	}
	return &Enrollment{Code: code, Computer: Computer{
		ID: r.ID, Name: r.Name, Runtimes: []ComputerRuntime{}, CreatedAt: jsontime.From(r.CreatedAt), EnrollExpiresAt: jsontime.Ptr(&expires),
	}}, nil
}

func computer(ctx context.Context, db store.DB, id string) (*computerRow, error) {
	parsed, ok := chat.ParseID(id)
	if !ok {
		return nil, apierr.NotFound()
	}
	r, err := chat.One[computerRow](ctx, db, "SELECT * FROM computer WHERE id = $1", parsed)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, apierr.NotFound()
	}
	return r, nil
}

// Approve approves a computer's runtime on the relay: its pending pairing,
// or its changed runtime.
func (s *Service) Approve(ctx context.Context, db store.DB, id, kind string) error {
	if s.Relay == nil {
		return relayUnavailable()
	}
	r, err := computer(ctx, db, id)
	if err != nil {
		return err
	}
	rt, err := chat.One[computerRuntimeRow](ctx, db, "SELECT * FROM computer_runtime WHERE computer_id = $1 AND kind = $2", r.ID, kind)
	if err != nil {
		return err
	}
	if rt == nil {
		return apierr.NotFound()
	}
	if rt.DeviceID == nil {
		if rt.PairingCode == nil || rt.PairingFingerprint == nil {
			return apierr.New(409, "NOTHING_TO_APPROVE", "这台电脑还没有发起配对。")
		}
		deviceID, err := s.Relay.ApprovePairing(ctx, *rt.PairingCode, *rt.PairingFingerprint)
		if err != nil {
			return apierr.New(502, "RELAY_REJECTED", "中继没有接受这次配对："+err.Error())
		}
		// The pairing stays until the daemon reports the device: its heartbeats
		// show the same pairing until its connector sees the approval.
		_, err = db.Exec(ctx, `UPDATE computer_runtime SET device_id = $3, error = NULL, updated_at = $4
			WHERE computer_id = $1 AND kind = $2`, r.ID, kind, deviceID, chat.Now())
		return err
	}
	state, err := s.Relay.State(ctx)
	if err != nil {
		return apierr.New(502, "RELAY_UNAVAILABLE", "无法连接中继："+err.Error())
	}
	for _, d := range state.Devices {
		if d.ID != *rt.DeviceID {
			continue
		}
		for _, inst := range d.Instances {
			if inst.InstanceID == instanceFor(kind) && !inst.Approved {
				if err := s.Relay.ApproveInstance(ctx, d.ID, inst.InstanceID, inst.Fingerprint); err != nil {
					return apierr.New(502, "RELAY_REJECTED", "中继没有接受批准："+err.Error())
				}
				return nil
			}
		}
	}
	return apierr.New(409, "NOTHING_TO_APPROVE", "没有需要批准的内容。")
}

// DeleteComputer revokes the computer's devices on the relay and forgets
// it. Its tasks become unassigned; work it already started is not undone.
func (s *Service) DeleteComputer(ctx context.Context, tx pgx.Tx, id string) error {
	r, err := computer(ctx, tx, id)
	if err != nil {
		return err
	}
	runtimes, err := chat.All[computerRuntimeRow](ctx, tx, "SELECT * FROM computer_runtime WHERE computer_id = $1", r.ID)
	if err != nil {
		return err
	}
	for _, rt := range runtimes {
		if rt.DeviceID != nil && s.Relay != nil {
			if err := s.Relay.RevokeDevice(ctx, *rt.DeviceID); err != nil {
				return apierr.New(502, "RELAY_UNAVAILABLE", "无法在中继上撤销这台电脑："+err.Error())
			}
		}
	}
	tasks, err := chat.All[taskRow](ctx, tx, taskSelect+" WHERE t.computer_id = $1 FOR UPDATE OF t", r.ID)
	if err != nil {
		return err
	}
	for _, t := range tasks {
		if _, err := s.Update(ctx, tx, t.ID, Changes{Assignee: &AssigneeInput{Kind: "none"}}, System); err != nil {
			return err
		}
	}
	reason := "电脑已移除。"
	runs, err := chat.All[runRow](ctx, tx, `SELECT * FROM task_run WHERE computer_id = $1
		AND status IN ('queued', 'preparing', 'starting', 'running') FOR UPDATE`, r.ID)
	if err != nil {
		return err
	}
	for _, run := range runs {
		if err := finishRun(ctx, tx, run, RunCancelled, &reason); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, "DELETE FROM computer WHERE id = $1", r.ID)
	return err
}

// AssigneeOption is a remote agent a task can be assigned to.
type AssigneeOption struct {
	ComputerID   string `json:"computer_id"`
	ComputerName string `json:"computer_name"`
	Runtime      string `json:"runtime"`
	Provider     string `json:"provider"`
	Online       bool   `json:"online"`
}

// AssigneeOptions are the paired runtimes' providers.
func (s *Service) AssigneeOptions(ctx context.Context, db store.DB) ([]AssigneeOption, error) {
	rows, err := chat.All[struct {
		computerRuntimeRow
		Name       string     `db:"name"`
		LastSeenAt *time.Time `db:"last_seen_at"`
	}](ctx, db, `SELECT r.*, c.name, c.last_seen_at FROM computer_runtime r JOIN computer c ON c.id = r.computer_id
		WHERE r.device_id IS NOT NULL ORDER BY c.name, r.kind`)
	if err != nil {
		return nil, err
	}
	out := []AssigneeOption{}
	for _, r := range rows {
		online := r.LastSeenAt != nil && time.Since(*r.LastSeenAt) < onlineWithin
		for _, p := range r.Providers {
			out = append(out, AssigneeOption{ComputerID: r.ComputerID, ComputerName: r.Name, Runtime: r.Kind, Provider: p, Online: online})
		}
	}
	return out, nil
}

// --- the daemon and the CLI (/remote) ---------------------------------------------------------

// RemoteComputer is an enrolled computer, as its token proves.
type RemoteComputer struct {
	ID   string
	Name string
	Root string
}

func unauthenticated() error {
	return apierr.New(401, "UNAUTHENTICATED", "这台电脑的凭据无效，请重新接入。")
}

// Authenticate is the computer holding token.
func Authenticate(ctx context.Context, db store.DB, token string) (*RemoteComputer, error) {
	if token == "" {
		return nil, unauthenticated()
	}
	r, err := chat.One[computerRow](ctx, db, "SELECT * FROM computer WHERE token_hash = $1", digest(token))
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, unauthenticated()
	}
	root := ""
	if r.WorkspaceRoot != nil {
		root = *r.WorkspaceRoot
	}
	return &RemoteComputer{ID: r.ID, Name: r.Name, Root: root}, nil
}

type Enrolled struct {
	ComputerID  string `json:"computer_id"`
	Name        string `json:"name"`
	Token       string `json:"token"`
	RelayOrigin string `json:"relay_origin"`
}

// Enroll trades an install code for the computer's token.
func (s *Service) Enroll(ctx context.Context, tx pgx.Tx, code string) (*Enrolled, error) {
	if s.Relay == nil {
		return nil, relayUnavailable()
	}
	r, err := chat.One[computerRow](ctx, tx, "SELECT * FROM computer WHERE enroll_code_hash = $1 FOR UPDATE", digest(code))
	if err != nil {
		return nil, err
	}
	if r == nil || r.EnrollExpiresAt == nil || time.Now().After(*r.EnrollExpiresAt) {
		return nil, apierr.New(401, "ENROLL_CODE_INVALID", "安装命令无效或已过期，请在 AXP 中重新生成。")
	}
	token := secret("axpc_")
	if _, err := tx.Exec(ctx, `UPDATE computer SET token_hash = $2, enroll_code_hash = NULL, enroll_expires_at = NULL,
		last_seen_at = $3 WHERE id = $1`, r.ID, digest(token), chat.Now()); err != nil {
		return nil, err
	}
	return &Enrolled{ComputerID: r.ID, Name: r.Name, Token: token, RelayOrigin: s.Relay.Origin()}, nil
}

type RuntimeReport struct {
	Kind      string   `json:"kind" enum:"paseo,herdr"`
	Providers []string `json:"providers" maxItems:"16"`
	// A pairing the connector started and waits on.
	Pairing *struct {
		Code        string `json:"code" maxLength:"64"`
		Fingerprint string `json:"fingerprint" maxLength:"128"`
	} `json:"pairing,omitempty"`
	// Set once the connector is paired.
	DeviceID *string `json:"device_id,omitempty" maxLength:"64"`
	Error    *string `json:"error,omitempty" maxLength:"2000"`
}

type Heartbeat struct {
	Hostname      string `json:"hostname" maxLength:"255"`
	OS            string `json:"os" maxLength:"32"`
	Arch          string `json:"arch" maxLength:"32"`
	WorkspaceRoot string `json:"workspace_root" minLength:"1" maxLength:"1024"`
	// The axp binary's path.
	CLI      string          `json:"cli,omitempty" maxLength:"1024"`
	Runtimes []RuntimeReport `json:"runtimes" maxItems:"4"`
}

// Prepare asks the daemon to create a run's workspace: <root>/<task id>.
type Prepare struct {
	RunID  string `json:"run_id"`
	TaskID string `json:"task_id"`
}

type HeartbeatReply struct {
	RelayOrigin string    `json:"relay_origin"`
	Prepare     []Prepare `json:"prepare"`
}

// Heartbeat records what the daemon reports and answers with the
// workspaces it should prepare.
func (s *Service) Heartbeat(ctx context.Context, tx pgx.Tx, c *RemoteComputer, in Heartbeat) (*HeartbeatReply, error) {
	if s.Relay == nil {
		return nil, relayUnavailable()
	}
	now := chat.Now()
	if _, err := tx.Exec(ctx, `UPDATE computer SET hostname = $2, os = $3, arch = $4, workspace_root = $5, last_seen_at = $6,
		cli_path = NULLIF($7, '') WHERE id = $1`, c.ID, in.Hostname, in.OS, in.Arch, in.WorkspaceRoot, now, in.CLI); err != nil {
		return nil, err
	}
	for _, rt := range in.Runtimes {
		if !slices.Contains(Runtimes, rt.Kind) {
			continue
		}
		var code, fingerprint *string
		if rt.Pairing != nil && rt.DeviceID == nil {
			code, fingerprint = &rt.Pairing.Code, &rt.Pairing.Fingerprint
		}
		providers := rt.Providers
		if providers == nil {
			providers = []string{}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO computer_runtime (computer_id, kind, providers, pairing_code, pairing_fingerprint,
			device_id, error, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (computer_id, kind) DO UPDATE SET providers = $3, pairing_code = $4, pairing_fingerprint = $5,
			device_id = COALESCE($6, CASE WHEN $4::text IS NULL OR $4 = computer_runtime.pairing_code
				THEN computer_runtime.device_id END), error = $7, updated_at = $8`,
			c.ID, rt.Kind, providers, code, fingerprint, rt.DeviceID, rt.Error, now); err != nil {
			return nil, err
		}
	}
	prepare, err := chat.All[struct {
		RunID  string `db:"id"`
		TaskID string `db:"task_id"`
	}](ctx, tx, "SELECT id, task_id FROM task_run WHERE computer_id = $1 AND status = 'preparing' ORDER BY created_at", c.ID)
	if err != nil {
		return nil, err
	}
	reply := &HeartbeatReply{RelayOrigin: s.Relay.Origin(), Prepare: []Prepare{}}
	for _, p := range prepare {
		reply.Prepare = append(reply.Prepare, Prepare{RunID: p.RunID, TaskID: p.TaskID})
	}
	return reply, nil
}

// Prepared is the daemon reporting a run's workspace ready.
func (s *Service) Prepared(ctx context.Context, tx pgx.Tx, c *RemoteComputer, runID, workspace string) error {
	id, ok := chat.ParseID(runID)
	if !ok {
		return apierr.NotFound()
	}
	tag, err := tx.Exec(ctx, `UPDATE task_run SET status = 'starting', workspace = $3 WHERE id = $1 AND computer_id = $2
		AND status = 'preparing'`, id, c.ID, workspace)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apierr.New(409, "RUN_NOT_PREPARING", "这次运行不在等待工作区。")
	}
	return nil
}

// remoteTask is a task the computer works on.
func remoteTask(ctx context.Context, db store.DB, c *RemoteComputer, ref string, lock bool) (*taskRow, error) {
	r, err := find(ctx, db, ref, lock)
	if err != nil {
		return nil, err
	}
	mine, err := chat.Exists(ctx, db, "SELECT 1 FROM task_run WHERE task_id = $1 AND computer_id = $2", r.ID, c.ID)
	if err != nil {
		return nil, err
	}
	if !mine && (r.ComputerID == nil || *r.ComputerID != c.ID) {
		return nil, apierr.New(403, "NOT_ASSIGNED", "这个任务没有指派给这台电脑。")
	}
	return r, nil
}

// activeRun is the computer's current run on the task, if any.
func activeRun(ctx context.Context, db store.DB, c *RemoteComputer, taskID string) (*string, error) {
	var id string
	err := db.QueryRow(ctx, `SELECT id FROM task_run WHERE task_id = $1 AND computer_id = $2
		ORDER BY (status = 'running') DESC, created_at DESC LIMIT 1`, taskID, c.ID).Scan(&id)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func (s *Service) RemoteTask(ctx context.Context, db store.DB, c *RemoteComputer, ref string) (*TaskDetail, error) {
	r, err := remoteTask(ctx, db, c, ref, false)
	if err != nil {
		return nil, err
	}
	return detail(ctx, db, r)
}

func (s *Service) RemoteComment(ctx context.Context, tx pgx.Tx, c *RemoteComputer, ref, body string) error {
	r, err := remoteTask(ctx, tx, c, ref, true)
	if err != nil {
		return err
	}
	body = strings.TrimSpace(body)
	if body == "" {
		return invalid("评论不能为空。")
	}
	run, err := activeRun(ctx, tx, c, r.ID)
	if err != nil {
		return err
	}
	return record(ctx, tx, r.ID, run, "comment", Remote, &body, s.remoteData(ctx, tx, c, r))
}

func (s *Service) remoteData(ctx context.Context, db store.DB, c *RemoteComputer, r *taskRow) map[string]any {
	d := map[string]any{"computer_id": c.ID, "computer_name": c.Name}
	var runtime, provider string
	if db.QueryRow(ctx, `SELECT runtime, provider FROM task_run WHERE task_id = $1 AND computer_id = $2
		ORDER BY created_at DESC LIMIT 1`, r.ID, c.ID).Scan(&runtime, &provider) == nil {
		d["runtime"], d["provider"] = runtime, provider
	}
	return d
}

// RemoteStatuses are the statuses a remote agent may set.
var RemoteStatuses = []string{StatusInProgress, StatusInReview, StatusBlocked}

func (s *Service) RemoteStatus(ctx context.Context, tx pgx.Tx, c *RemoteComputer, ref, status string) error {
	if !slices.Contains(RemoteStatuses, status) {
		return invalid("远程智能体只能把任务设为 in_progress、in_review 或 blocked。")
	}
	r, err := remoteTask(ctx, tx, c, ref, true)
	if err != nil {
		return err
	}
	run, err := activeRun(ctx, tx, c, r.ID)
	if err != nil {
		return err
	}
	return setStatus(ctx, tx, r, status, Remote, run, s.remoteData(ctx, tx, c, r))
}

type Checkout struct {
	Repository string `json:"repository" minLength:"1" maxLength:"200"`
	Branch     string `json:"branch" minLength:"1" maxLength:"255"`
	BaseCommit string `json:"base_commit" minLength:"7" maxLength:"64"`
	Path       string `json:"path" maxLength:"1024"`
}

func (s *Service) RecordCheckout(ctx context.Context, tx pgx.Tx, c *RemoteComputer, ref string, in Checkout) error {
	r, err := remoteTask(ctx, tx, c, ref, true)
	if err != nil {
		return err
	}
	run, err := activeRun(ctx, tx, c, r.ID)
	if err != nil {
		return err
	}
	data := s.remoteData(ctx, tx, c, r)
	data["repository"], data["branch"], data["base_commit"], data["path"] = in.Repository, in.Branch, in.BaseCommit, in.Path
	return record(ctx, tx, r.ID, run, "checkout", Remote, nil, data)
}

type Deliverable struct {
	Kind  string `json:"kind" enum:"pull_request,branch,commit,link"`
	URL   string `json:"url" maxLength:"2000"`
	Title string `json:"title,omitempty" maxLength:"500"`
}

func (s *Service) RecordDeliverable(ctx context.Context, tx pgx.Tx, c *RemoteComputer, ref string, in Deliverable) error {
	r, err := remoteTask(ctx, tx, c, ref, true)
	if err != nil {
		return err
	}
	run, err := activeRun(ctx, tx, c, r.ID)
	if err != nil {
		return err
	}
	data := s.remoteData(ctx, tx, c, r)
	data["kind"], data["url"], data["title"] = in.Kind, in.URL, in.Title
	return record(ctx, tx, r.ID, run, "deliverable", Remote, nil, data)
}
