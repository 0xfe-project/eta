package llm

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

// Usage reads subscription limits of every enabled connection whose
// connector can report them, concurrently.
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
			u, err := j.reader.Usage(ctx, j.auth.Metadata)
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
