package tasks

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/jsontime"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

// Remote computers. The install command's one-time code enrolls a computer
// (`axp setup`) and gives it a token for its CLI under /remote. Setup
// installs an agenvo connector per runtime (Paseo, Herdr) as the
// connector's own service and pairs it with the relay under the label
// axp:<computer id>:<runtime>; the user approves the pairing here after
// comparing the fingerprint setup printed. Whether a computer is online is
// the relay's view of its connectors.

const (
	// EnrollFor is how long an install command works.
	EnrollFor = 24 * time.Hour
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
	CLIPath         *string    `db:"cli_path"`
	CreatedAt       time.Time  `db:"created_at"`
}

type computerRuntimeRow struct {
	ComputerID string    `db:"computer_id"`
	Kind       string    `db:"kind"`
	Providers  []string  `db:"providers"`
	DeviceID   *string   `db:"device_id"`
	UpdatedAt  time.Time `db:"updated_at"`
}

// PairingLabel is the relay label setup pairs a computer's runtime under.
func PairingLabel(computerID, kind string) string { return "axp:" + computerID + ":" + kind }

type ComputerRuntime struct {
	Kind      string   `json:"kind" enum:"paseo,herdr"`
	Providers []string `json:"providers"`
	// waiting: setup has not paired it yet; pairing: approve it here;
	// needs_approval: the runtime changed and waits for approval again.
	State string `json:"state" enum:"waiting,pairing,needs_approval,online,offline"`
	// The fingerprints to compare with setup's output before approving: one
	// per pairing waiting under this runtime's label. More than one means
	// someone else asked too (setup run again, or another device using the
	// label); only the one setup printed is to be approved.
	Fingerprints []string `json:"fingerprints"`
}

type Computer struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Enrolled bool    `json:"enrolled"`
	Online   bool    `json:"online"`
	Hostname *string `json:"hostname" nullable:"true"`
	OS       *string `json:"os" nullable:"true"`
	Arch     *string `json:"arch" nullable:"true"`
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
	RelayURL        *string `json:"relay_url" nullable:"true"`
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

func (s *Service) relayState(ctx context.Context) (*relay.State, error) {
	if s.Relay == nil {
		return nil, relayUnavailable()
	}
	state, err := s.Relay.State(ctx)
	if err != nil {
		slog.WarnContext(ctx, "Relay state unavailable", "error", err)
	}
	return state, err
}

// ListComputers is every computer with its runtimes' state on the relay.
func (s *Service) ListComputers(ctx context.Context, db pg.DB) (*Computers, error) {
	out := &Computers{Computers: []Computer{}, RelayConfigured: s.Relay != nil}
	var state *relay.State
	if s.Relay != nil {
		base := s.Relay.BaseURL()
		out.RelayURL = &base
		var err error
		if state, err = s.relayState(ctx); err != nil {
			message := err.Error()
			out.RelayError = &message
		}
	}
	rows, err := pg.All[computerRow](ctx, db, "SELECT * FROM computer ORDER BY created_at")
	if err != nil {
		return nil, err
	}
	runtimes, err := pg.All[computerRuntimeRow](ctx, db, "SELECT * FROM computer_runtime ORDER BY kind")
	if err != nil {
		return nil, err
	}
	active, err := pg.All[struct {
		ComputerID string `db:"computer_id"`
		N          int64  `db:"n"`
	}](ctx, db, `SELECT computer_id, count(*) AS n FROM task_run WHERE status IN ('starting', 'running')
		AND computer_id IS NOT NULL GROUP BY computer_id`)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		c := Computer{
			ID: r.ID, Name: r.Name, Enrolled: r.TokenHash != nil, Hostname: r.Hostname, OS: r.OS, Arch: r.Arch,
			Runtimes: []ComputerRuntime{}, CreatedAt: jsontime.From(r.CreatedAt),
		}
		if r.TokenHash == nil {
			c.EnrollExpiresAt = jsontime.Ptr(r.EnrollExpiresAt)
		}
		for _, rt := range runtimes {
			if rt.ComputerID == r.ID {
				public := runtimeState(rt, state)
				c.Runtimes = append(c.Runtimes, public)
				c.Online = c.Online || public.State == "online"
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

func runtimeState(rt *computerRuntimeRow, state *relay.State) ComputerRuntime {
	out := ComputerRuntime{Kind: rt.Kind, Providers: rt.Providers, State: "offline", Fingerprints: []string{}}
	if out.Providers == nil {
		out.Providers = []string{}
	}
	if state == nil {
		return out
	}
	if rt.DeviceID == nil {
		out.State = "waiting"
		for _, p := range state.Pairings {
			if p.Label == PairingLabel(rt.ComputerID, rt.Kind) {
				out.State, out.Fingerprints = "pairing", append(out.Fingerprints, p.Digest)
			}
		}
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
				out.State, out.Fingerprints = "needs_approval", []string{inst.Fingerprint}
				return out
			}
			if d.Online && inst.Available {
				out.State = "online"
			}
		}
	}
	return out
}

// fingerprintMismatch: what was asked to be approved is not what the user
// compared (another pairing came in, or the page is stale).
func fingerprintMismatch() error {
	return apierr.New(409, "FINGERPRINT_MISMATCH", "指纹与等待批准的配对不一致，请刷新后重新核对。")
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
	now := pg.Now()
	id := pg.NewID()
	expires := now.Add(EnrollFor)
	if _, err := tx.Exec(ctx, `INSERT INTO computer (id, name, enroll_code_hash, enroll_expires_at, created_at)
		VALUES ($1, $2, $3, $4, $5)`, id, name, digest(code), expires, now); err != nil {
		return nil, err
	}
	return &Enrollment{Code: code, Computer: Computer{
		ID: id, Name: name, Runtimes: []ComputerRuntime{}, CreatedAt: jsontime.From(now), EnrollExpiresAt: jsontime.Ptr(&expires),
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
	expires := pg.Now().Add(EnrollFor)
	if _, err := tx.Exec(ctx, "UPDATE computer SET enroll_code_hash = $2, enroll_expires_at = $3 WHERE id = $1",
		r.ID, digest(code), expires); err != nil {
		return nil, err
	}
	return &Enrollment{Code: code, Computer: Computer{
		ID: r.ID, Name: r.Name, Runtimes: []ComputerRuntime{}, CreatedAt: jsontime.From(r.CreatedAt), EnrollExpiresAt: jsontime.Ptr(&expires),
	}}, nil
}

func computer(ctx context.Context, db pg.DB, id string) (*computerRow, error) {
	parsed, ok := pg.ParseID(id)
	if !ok {
		return nil, apierr.NotFound()
	}
	r, err := pg.One[computerRow](ctx, db, "SELECT * FROM computer WHERE id = $1", parsed)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, apierr.NotFound()
	}
	return r, nil
}

func relayUnreachable(err error) error {
	return apierr.Upstream("RELAY_UNAVAILABLE", "无法连接中继："+err.Error())
}

// Approve approves a computer's runtime on the relay: its pending pairing,
// or its changed runtime, only when its fingerprint is the one the user
// compared with setup's output.
func (s *Service) Approve(ctx context.Context, db pg.DB, id, kind, fingerprint string) error {
	if s.Relay == nil {
		return relayUnavailable()
	}
	r, err := computer(ctx, db, id)
	if err != nil {
		return err
	}
	rt, err := pg.One[computerRuntimeRow](ctx, db, "SELECT * FROM computer_runtime WHERE computer_id = $1 AND kind = $2", r.ID, kind)
	if err != nil {
		return err
	}
	if rt == nil {
		return apierr.NotFound()
	}
	state, err := s.Relay.State(ctx)
	if err != nil {
		return relayUnreachable(err)
	}
	if rt.DeviceID == nil {
		asked := false
		for _, p := range state.Pairings {
			if p.Label != PairingLabel(r.ID, kind) {
				continue
			}
			asked = true
			if p.Digest != fingerprint {
				continue
			}
			deviceID, err := s.Relay.ApprovePairing(ctx, p.Code, p.Digest)
			if err != nil {
				return apierr.Upstream("RELAY_REJECTED", "中继没有接受这次配对："+err.Error())
			}
			_, err = db.Exec(ctx, `UPDATE computer_runtime SET device_id = $3, updated_at = $4
				WHERE computer_id = $1 AND kind = $2`, r.ID, kind, deviceID, pg.Now())
			return err
		}
		if asked {
			return fingerprintMismatch()
		}
		return apierr.New(409, "NOTHING_TO_APPROVE", "这台电脑还没有发起配对。")
	}
	for _, d := range state.Devices {
		if d.ID != *rt.DeviceID {
			continue
		}
		for _, inst := range d.Instances {
			if inst.InstanceID == instanceFor(kind) && !inst.Approved {
				if inst.Fingerprint != fingerprint {
					return fingerprintMismatch()
				}
				if err := s.Relay.ApproveInstance(ctx, d.ID, inst.InstanceID, inst.Fingerprint); err != nil {
					return apierr.Upstream("RELAY_REJECTED", "中继没有接受批准："+err.Error())
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
	runtimes, err := pg.All[computerRuntimeRow](ctx, tx, "SELECT * FROM computer_runtime WHERE computer_id = $1", r.ID)
	if err != nil {
		return err
	}
	for _, rt := range runtimes {
		if rt.DeviceID != nil && s.Relay != nil {
			if err := s.Relay.RevokeDevice(ctx, *rt.DeviceID); err != nil {
				return apierr.Upstream("RELAY_UNAVAILABLE", "无法在中继上撤销这台电脑："+err.Error())
			}
		}
	}
	tasks, err := pg.All[taskRow](ctx, tx, taskSelect+" WHERE t.computer_id = $1 FOR UPDATE OF t", r.ID)
	if err != nil {
		return err
	}
	for _, t := range tasks {
		if _, err := s.Update(ctx, tx, t.ID, Changes{Assignee: &AssigneeInput{Kind: "none"}}, System); err != nil {
			return err
		}
	}
	reason := "电脑已移除。"
	runs, err := pg.All[runRow](ctx, tx, `SELECT * FROM task_run WHERE computer_id = $1
		AND status IN ('queued', 'starting', 'running') FOR UPDATE`, r.ID)
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
func (s *Service) AssigneeOptions(ctx context.Context, db pg.DB) ([]AssigneeOption, error) {
	rows, err := pg.All[struct {
		computerRuntimeRow
		Name string `db:"name"`
	}](ctx, db, `SELECT r.*, c.name FROM computer_runtime r JOIN computer c ON c.id = r.computer_id
		WHERE r.device_id IS NOT NULL ORDER BY c.name, r.kind`)
	if err != nil {
		return nil, err
	}
	var state *relay.State
	if s.Relay != nil && len(rows) > 0 {
		state, _ = s.relayState(ctx)
	}
	out := []AssigneeOption{}
	for _, r := range rows {
		online := runtimeState(&r.computerRuntimeRow, state).State == "online"
		for _, p := range r.Providers {
			out = append(out, AssigneeOption{ComputerID: r.ComputerID, ComputerName: r.Name, Runtime: r.Kind, Provider: p, Online: online})
		}
	}
	return out, nil
}

// Places is where on a computer's runtime an agent can work, read from
// the runtime now.
func (s *Service) Places(ctx context.Context, db pg.DB, id, kind string) (*Places, error) {
	if s.Relay == nil {
		return nil, relayUnavailable()
	}
	r, err := computer(ctx, db, id)
	if err != nil {
		return nil, err
	}
	var deviceID *string
	if err := db.QueryRow(ctx, "SELECT device_id FROM computer_runtime WHERE computer_id = $1 AND kind = $2",
		r.ID, kind).Scan(&deviceID); err != nil && err != pgx.ErrNoRows {
		return nil, err
	}
	if deviceID == nil {
		return nil, apierr.New(409, "RUNTIME_NOT_PAIRED", "这台电脑的 "+kind+" 还没有配对。")
	}
	places, err := agents{s.Relay}.places(ctx, target{*deviceID, kind})
	if err != nil {
		return nil, apierr.Upstream("REMOTE_UNAVAILABLE", "读取远程电脑上的工作区失败："+err.Error())
	}
	return places, nil
}

// --- the CLI (/remote) ----------------------------------------------------------------------

// RemoteComputer is an enrolled computer, as its token proves.
type RemoteComputer struct {
	ID   string
	Name string
}

func unauthenticated() error {
	return apierr.New(401, "UNAUTHENTICATED", "这台电脑的凭据无效，请重新接入。")
}

// Authenticate is the computer holding token.
func Authenticate(ctx context.Context, db pg.DB, token string) (*RemoteComputer, error) {
	if token == "" {
		return nil, unauthenticated()
	}
	r, err := pg.One[computerRow](ctx, db, "SELECT * FROM computer WHERE token_hash = $1", digest(token))
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, unauthenticated()
	}
	return &RemoteComputer{ID: r.ID, Name: r.Name}, nil
}

type RuntimeReport struct {
	Kind      string   `json:"kind" enum:"paseo,herdr"`
	Providers []string `json:"providers" maxItems:"16"`
}

// Report is what setup tells AXP about the computer.
type Report struct {
	Hostname string          `json:"hostname" maxLength:"255"`
	OS       string          `json:"os" maxLength:"32"`
	Arch     string          `json:"arch" maxLength:"32"`
	CLI      string          `json:"cli,omitempty" maxLength:"1024" doc:"The axp binary's path."`
	Runtimes []RuntimeReport `json:"runtimes" maxItems:"4"`
}

type Enrolled struct {
	ComputerID string `json:"computer_id"`
	Name       string `json:"name"`
	Token      string `json:"token"`
	RelayURL   string `json:"relay_url"`
}

// Enroll trades an install code for the computer's token.
func (s *Service) Enroll(ctx context.Context, tx pgx.Tx, code string, in Report) (*Enrolled, error) {
	if s.Relay == nil {
		return nil, relayUnavailable()
	}
	r, err := pg.One[computerRow](ctx, tx, "SELECT * FROM computer WHERE enroll_code_hash = $1 FOR UPDATE", digest(code))
	if err != nil {
		return nil, err
	}
	if r == nil || r.EnrollExpiresAt == nil || time.Now().After(*r.EnrollExpiresAt) {
		return nil, apierr.New(401, "ENROLL_CODE_INVALID", "安装命令无效或已过期，请在 AXP 中重新生成。")
	}
	token := secret("axpc_")
	if _, err := tx.Exec(ctx, `UPDATE computer SET token_hash = $2, enroll_code_hash = NULL, enroll_expires_at = NULL
		WHERE id = $1`, r.ID, digest(token)); err != nil {
		return nil, err
	}
	if err := s.Report(ctx, tx, &RemoteComputer{ID: r.ID, Name: r.Name}, in); err != nil {
		return nil, err
	}
	return &Enrolled{ComputerID: r.ID, Name: r.Name, Token: token, RelayURL: s.Relay.BaseURL()}, nil
}

// Report records the computer and its runtimes as setup found them. A
// runtime setup no longer finds keeps its pairing (its connector may still
// run).
func (s *Service) Report(ctx context.Context, tx pgx.Tx, c *RemoteComputer, in Report) error {
	if _, err := tx.Exec(ctx, `UPDATE computer SET hostname = $2, os = $3, arch = $4, cli_path = NULLIF($5, '')
		WHERE id = $1`, c.ID, in.Hostname, in.OS, in.Arch, in.CLI); err != nil {
		return err
	}
	for _, rt := range in.Runtimes {
		if !slices.Contains(Runtimes, rt.Kind) {
			continue
		}
		providers := rt.Providers
		if providers == nil {
			providers = []string{}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO computer_runtime (computer_id, kind, providers, updated_at) VALUES ($1, $2, $3, $4)
			ON CONFLICT (computer_id, kind) DO UPDATE SET providers = $3, updated_at = $4`,
			c.ID, rt.Kind, providers, pg.Now()); err != nil {
			return err
		}
	}
	return nil
}

// CurrentTask is the task whose open session works in dir (or a directory
// above it) on this computer.
func (s *Service) CurrentTask(ctx context.Context, db pg.DB, c *RemoteComputer, dir string) (string, error) {
	sessions, err := pg.All[sessionRow](ctx, db, `SELECT * FROM task_session WHERE computer_id = $1 AND closed_at IS NULL
		AND workspace <> '' ORDER BY length(workspace) DESC`, c.ID)
	if err != nil {
		return "", err
	}
	dir = filepath.Clean(dir)
	for _, s := range sessions {
		root := filepath.Clean(s.Workspace)
		if dir == root || strings.HasPrefix(dir, root+string(filepath.Separator)) {
			return s.TaskID, nil
		}
	}
	return "", apierr.New(404, "NO_TASK_HERE", "这个目录不是任何进行中任务的工作位置；用 --task 指定任务。")
}

// remoteTask is a task the computer works on.
func remoteTask(ctx context.Context, db pg.DB, c *RemoteComputer, ref string, lock bool) (*taskRow, error) {
	r, err := find(ctx, db, ref, lock)
	if err != nil {
		return nil, err
	}
	mine, err := pg.Exists(ctx, db, "SELECT 1 FROM task_run WHERE task_id = $1 AND computer_id = $2", r.ID, c.ID)
	if err != nil {
		return nil, err
	}
	if !mine && (r.ComputerID == nil || *r.ComputerID != c.ID) {
		return nil, apierr.New(403, "NOT_ASSIGNED", "这个任务没有指派给这台电脑。")
	}
	return r, nil
}

// activeRun is the computer's current run on the task, if any.
func activeRun(ctx context.Context, db pg.DB, c *RemoteComputer, taskID string) (*string, error) {
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

func (s *Service) RemoteTask(ctx context.Context, db pg.DB, c *RemoteComputer, ref string) (*TaskDetail, error) {
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

func (s *Service) remoteData(ctx context.Context, db pg.DB, c *RemoteComputer, r *taskRow) map[string]any {
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
