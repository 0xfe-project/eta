package telemetry

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// RepeatEvery is how often a failure that keeps recurring is logged again,
// so a recent time window still shows it.
const RepeatEvery = 10 * time.Minute

// Repeats logs failures that recur on every tick of a loop (a computer that
// stays offline, a database that is down) when they change, and again every
// RepeatEvery while they last; key is forgotten once it succeeds. The zero
// value is ready to use.
type Repeats struct {
	mu   sync.Mutex
	last map[string]logged
	now  func() time.Time // tests
}

type logged struct {
	err string
	at  time.Time
}

// Log records err for key: logged at level with msg and args when it is new
// or due again, or forgotten when nil.
func (r *Repeats) Log(ctx context.Context, level slog.Level, key string, err error, msg string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err == nil {
		delete(r.last, key)
		return
	}
	now := time.Now()
	if r.now != nil {
		now = r.now()
	}
	if last, ok := r.last[key]; ok && last.err == err.Error() && now.Sub(last.at) < RepeatEvery {
		return
	}
	if r.last == nil {
		r.last = map[string]logged{}
	}
	r.last[key] = logged{err.Error(), now}
	slog.Log(ctx, level, msg, append(args, "error", err)...)
}
