package control

import (
	"context"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/snapshots"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// LeaseSeconds is a runtime's lease; it heartbeats four times per lease.
const LeaseSeconds = 30

// Protocol is the runtime side of the internal API: how a runtime instance
// reports its state, its thread and its events, and gets where to upload its
// snapshot.
type Protocol struct {
	DB        *pgxpool.Pool
	Chat      *chat.Service
	Snapshots snapshots.Store
	Secret    []byte
}

func fenced() error { return apierr.New(409, "STALE_GENERATION", "运行实例已失效。") }

// Authenticate is the instance the token belongs to; it fails for a token
// that does not match, and fences an instance that was replaced.
func (p *Protocol) Authenticate(ctx context.Context, instanceID, token string) (*chat.RuntimeRecord, error) {
	var instance *chat.RuntimeRecord
	if id, ok := pg.ParseID(instanceID); ok {
		var err error
		if instance, err = pg.One[chat.RuntimeRecord](ctx, p.DB, "SELECT * FROM runtime_instance WHERE id = $1", id); err != nil {
			return nil, err
		}
	}
	if instance == nil || !auth.Matches(token, auth.RuntimeToken(p.Secret, instance.ID, instance.Generation)) {
		return nil, apierr.New(403, "INVALID_RUNTIME_TOKEN", "运行实例令牌无效。")
	}
	var generation int64
	if err := p.DB.QueryRow(ctx, "SELECT generation FROM agent WHERE id = $1", instance.AgentID).Scan(&generation); err != nil {
		return nil, err
	}
	if instance.EndedAt != nil || instance.Generation != generation {
		return nil, fenced()
	}
	return instance, nil
}

var runtimeStatuses = map[string]bool{"starting": true, "ready": true, "busy": true, "recovery_failed": true, "error": true}

// Heartbeat is what the protocol reads of a runtime's heartbeat.
type Heartbeat struct {
	Status    string
	ErrorCode *string
}

type Lease struct {
	LeaseExpiresAt string `json:"lease_expires_at" format:"date-time"`
	Generation     int64  `json:"generation"`
}

func (p *Protocol) inConversation(ctx context.Context, instance *chat.RuntimeRecord, fn func(pgx.Tx) error) error {
	return pg.InTx(ctx, p.DB, func(tx pgx.Tx) error {
		var conversationID string
		if err := tx.QueryRow(ctx, "SELECT conversation_id FROM agent WHERE id = $1", instance.AgentID).Scan(&conversationID); err != nil {
			return err
		}
		if err := chat.LockConversation(ctx, tx, conversationID); err != nil {
			return err
		}
		return fn(tx)
	})
}

// Heartbeat extends the instance's lease and takes in its status.
func (p *Protocol) Heartbeat(ctx context.Context, instance *chat.RuntimeRecord, body Heartbeat) (*Lease, error) {
	now := pg.Now()
	lease := now.Add(LeaseSeconds * time.Second)
	status := body.Status
	if !runtimeStatuses[status] {
		status = "starting"
	}
	if status == chat.RuntimeReady || status == chat.RuntimeBusy {
		// Nearly every heartbeat only renews: the runtime stays ready or
		// busy, its agent already is. Those leave the conversation lock to
		// the writes that need it (event imports of every agent queue on
		// it). The UPDATE's own row lock and conditions fence it: a runtime
		// ended, failed or replaced meanwhile matches none and takes the
		// locked path below.
		renewed, err := p.DB.Exec(ctx, `UPDATE runtime_instance r SET last_heartbeat_at = $2, lease_expires_at = $3, status = $4
			FROM agent a WHERE r.id = $1 AND a.id = r.agent_id AND a.generation = r.generation
			AND r.ended_at IS NULL AND r.ready_at IS NOT NULL AND r.status IN ('ready', 'busy')
			AND a.status IN ('ready', 'busy')`, instance.ID, now, lease, status)
		if err != nil {
			return nil, err
		}
		if renewed.RowsAffected() == 1 {
			return &Lease{LeaseExpiresAt: lease.Format(time.RFC3339Nano), Generation: instance.Generation}, nil
		}
	}
	err := p.inConversation(ctx, instance, func(tx pgx.Tx) error {
		current, err := pg.One[chat.RuntimeRecord](ctx, tx, "SELECT * FROM runtime_instance WHERE id = $1", instance.ID)
		if err != nil {
			return err
		}
		if current.EndedAt != nil {
			return fenced()
		}
		switch status {
		case "recovery_failed", "error":
			if current.Status != chat.RuntimeFailed {
				code := "RUNTIME_FAILED"
				if body.ErrorCode != nil && *body.ErrorCode != "" {
					code = *body.ErrorCode
				}
				if err := p.Chat.MarkRuntimeFailed(ctx, tx, current, code); err != nil {
					return err
				}
			}
		case "ready", "busy":
			if current.ReadyAt == nil {
				current.ReadyAt = &now
			}
			current.Status = chat.RuntimeReady
			if status == "busy" {
				current.Status = chat.RuntimeBusy
			}
			agent, err := pg.One[chat.AgentRecord](ctx, tx, "SELECT * FROM agent WHERE id = $1", current.AgentID)
			if err != nil {
				return err
			}
			if agent.Status != chat.AgentReady && agent.Status != chat.AgentBusy {
				if _, err := tx.Exec(ctx, `UPDATE agent SET status = 'ready', last_error_code = NULL, updated_at = $2
					WHERE id = $1`, agent.ID, now); err != nil {
					return err
				}
				if err := chat.RefreshAgentStatus(ctx, tx, agent.ID); err != nil {
					return err
				}
			}
		}
		if status == "starting" && current.ReadyAt == nil {
			// Reporting "starting" is no progress: one that never comes up
			// times out StartTimeout after it was created.
			if deadline := current.CreatedAt.Add(StartTimeout); deadline.Before(lease) {
				lease = deadline
			}
		}
		_, err = tx.Exec(ctx, `UPDATE runtime_instance SET last_heartbeat_at = $2, lease_expires_at = $3, status = $4,
			error_code = $5, ready_at = $6 WHERE id = $1`, current.ID, now, lease, current.Status, current.ErrorCode, current.ReadyAt)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &Lease{LeaseExpiresAt: lease.Format(time.RFC3339Nano), Generation: instance.Generation}, nil
}

type Session struct {
	ThreadID       string
	Resumed        bool
	SDKVersion     *string
	RuntimeVersion *string
}

func clip(s *string, n int) string {
	if s == nil {
		return ""
	}
	r := []rune(*s)
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}

// RegisterSession records the agent's thread; a runtime never silently
// swaps it.
func (p *Protocol) RegisterSession(ctx context.Context, instance *chat.RuntimeRecord, body Session) error {
	return pg.InTx(ctx, p.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO agent_session (agent_id, status, sdk_version, runtime_version)
			VALUES ($1, 'new', '', '') ON CONFLICT (agent_id) DO NOTHING`, instance.AgentID); err != nil {
			return err
		}
		session, err := pg.One[chat.SessionRecord](ctx, tx, "SELECT * FROM agent_session WHERE agent_id = $1 FOR UPDATE", instance.AgentID)
		if err != nil {
			return err
		}
		if session.ThreadID != nil && *session.ThreadID != "" && *session.ThreadID != body.ThreadID {
			return apierr.New(409, "THREAD_MISMATCH", "会话与记录不一致。")
		}
		var resumedAt *time.Time
		if body.Resumed {
			now := pg.Now()
			resumedAt = &now
		}
		_, err = tx.Exec(ctx, `UPDATE agent_session SET thread_id = $2, status = 'ready', sdk_version = $3,
			runtime_version = $4, last_resume_at = $5, last_error = NULL WHERE agent_id = $1`,
			instance.AgentID, body.ThreadID, clip(body.SDKVersion, 50), clip(body.RuntimeVersion, 100), resumedAt)
		return err
	})
}

// PostEvents imports a batch of the instance's events.
func (p *Protocol) PostEvents(ctx context.Context, instance *chat.RuntimeRecord, events []chat.RuntimeEvent) (int64, error) {
	var acked int64
	err := pg.InTx(ctx, p.DB, func(tx pgx.Tx) error {
		var err error
		acked, err = p.Chat.ImportEvents(ctx, tx, instance.ID, events)
		return err
	})
	return acked, err
}

// UploadURL is where the instance uploads its agent's next snapshot; only
// its own agent's.
func (p *Protocol) UploadURL(ctx context.Context, instance *chat.RuntimeRecord) (string, error) {
	return p.Snapshots.UploadURL(ctx, instance.AgentID)
}

// AgentFor answers the runtime gateway: which agent holds the runtime key
// "<instance id>.<token>".
func (p *Protocol) AgentFor(ctx context.Context, key string) (string, error) {
	instanceID, token, _ := strings.Cut(key, ".")
	instance, err := p.Authenticate(ctx, instanceID, token)
	if err != nil {
		return "", err
	}
	return instance.AgentID, nil
}
