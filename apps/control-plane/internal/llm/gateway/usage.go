package gateway

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

const usageTimeout = 15 * time.Second

// UsageWindow is one subscription rate-limit window. Used is the percent
// already consumed, 0–100.
type UsageWindow struct {
	Kind            string     `json:"kind"` // "5h", "weekly" or "monthly"
	Used            float64    `json:"used"`
	ResetsAt        *time.Time `json:"resets_at,omitempty"`
	DurationSeconds int64      `json:"duration_seconds,omitempty"`
}

// Usage is what the provider reports about one connection's subscription.
// A failed read carries Error instead of failing the whole list.
type Usage struct {
	ID      string        `json:"id"`
	Plan    string        `json:"plan,omitempty"`
	Windows []UsageWindow `json:"windows"`
	Error   string        `json:"error,omitempty"`
}

// UsageReader is implemented by connectors whose provider reports
// subscription limits. metadata is the credential CPA keeps for the account.
type UsageReader interface {
	Usage(ctx context.Context, metadata map[string]any) (Usage, error)
}

// check is the outcome of reading an account's usage: a request to the
// provider with the account's token that costs no quota, so it doubles as
// the account's health check.
type check struct {
	started, done time.Time
	err           *ConnectionError
}

// Usage reads subscription limits of every enabled connection whose
// connector can report them, concurrently, and records each read as the
// account's latest check. A token the provider rejects is refreshed once
// (as CPA does when a request gets a 401) before the check says so.
func (s *Service) Usage(ctx context.Context) []Usage {
	type job struct {
		auth   *coreauth.Auth
		reader UsageReader
	}
	var jobs []job
	for _, a := range s.auths.List() {
		reader, ok := s.byID[s.byProvider[strings.ToLower(a.Provider)]].(UsageReader)
		if !ok || a.Disabled || a.Status == coreauth.StatusDisabled {
			continue
		}
		jobs = append(jobs, job{a, reader})
	}
	out := make([]Usage, len(jobs))
	var wg sync.WaitGroup
	for i, j := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(ctx, usageTimeout)
			defer cancel()
			started := s.now()
			u, err := j.reader.Usage(ctx, j.auth.Metadata)
			if userCode(err) == "AUTH_EXPIRED" {
				if refreshed, rerr := s.auths.ForceRefreshAuth(ctx, j.auth.ID); rerr == nil && refreshed != nil {
					u, err = j.reader.Usage(ctx, refreshed.Metadata)
				}
			}
			s.record(j.auth.ID, check{started: started, done: s.now(), err: checkError(err)})
			u.ID = j.auth.ID
			if u.Windows == nil {
				u.Windows = []UsageWindow{}
			}
			if err != nil {
				u.Error = "暂时无法读取用量。"
				var ue *UserError
				if errors.As(err, &ue) {
					u.Error = ue.Message
				}
			}
			out[i] = u
		}()
	}
	wg.Wait()
	return out
}

func userCode(err error) string {
	var ue *UserError
	if errors.As(err, &ue) {
		return ue.Code
	}
	return ""
}

func checkError(err error) *ConnectionError {
	switch {
	case err == nil:
		return nil
	case userCode(err) == "AUTH_EXPIRED":
		return &ConnectionError{"AUTH_EXPIRED", "上游拒绝了登录令牌，请重新登录。"}
	}
	return &ConnectionError{"CHECK_FAILED", "暂时无法连接上游，未能完成检查；状态保持不变。"}
}

// record keeps the newest check per account: one that started earlier and
// finished later says less than the one already there.
func (s *Service) record(id string, c check) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.checks[id]; ok && old.started.After(c.started) {
		return
	}
	s.checks[id] = c
}

// withCheck adds the account's latest check to its connection. A check
// only reports, except that a login the provider rejected even after a
// refresh needs the user, unless CPA has heard from the account since.
func (s *Service) withCheck(c Connection, a *coreauth.Auth) Connection {
	s.mu.Lock()
	ch, ok := s.checks[a.ID]
	s.mu.Unlock()
	if !ok {
		return c
	}
	c.CheckedAt, c.CheckError = &ch.done, ch.err
	if ch.err != nil && ch.err.Code == "AUTH_EXPIRED" && !a.UpdatedAt.After(ch.done) &&
		(c.State == StateActive || c.State == StateDegraded) {
		c.State, c.Error, c.RetryAt = StateNeedsLogin, &ConnectionError{"AUTH_EXPIRED", "登录已失效，请重新登录。"}, nil
	}
	return c
}

// Status is everything the UI shows about the model services, at once.
type Status struct {
	Connections []Connection `json:"connections"`
	Models      []Model      `json:"models"`
	Usage       []Usage      `json:"usage"`
}

type refreshCall struct {
	done   chan struct{}
	status Status
}

// Refresh checks every account against its provider now and returns the
// result. Concurrent calls share one round of checks, so pressing refresh
// repeatedly sends one request per account; the round outlives a caller
// that gives up, since others may be waiting on it.
func (s *Service) Refresh(ctx context.Context) (Status, error) {
	s.mu.Lock()
	call := s.refreshing
	if call == nil {
		call = &refreshCall{done: make(chan struct{})}
		s.refreshing = call
		go func() {
			usage := s.Usage(context.WithoutCancel(ctx))
			call.status = Status{Connections: nonNil(s.Connections()), Models: nonNil(s.Models()), Usage: nonNil(usage)}
			s.mu.Lock()
			s.refreshing = nil
			s.mu.Unlock()
			close(call.done)
		}()
	}
	s.mu.Unlock()
	select {
	case <-call.done:
		return call.status, nil
	case <-ctx.Done():
		return Status{}, ctx.Err()
	}
}

// WindowKind names a window by its length.
func WindowKind(seconds int64, fallback string) string {
	switch {
	case seconds <= 0:
		return fallback
	case seconds <= 6*3600:
		return "5h"
	case seconds >= 27*24*3600:
		return "monthly"
	default:
		return "weekly"
	}
}
