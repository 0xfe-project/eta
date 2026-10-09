package telemetry

import (
	"context"
	"log/slog"
	"sync"
)

// Repeats logs failures that recur on every tick of a loop (a computer that
// stays offline, a database that is down) once per change: an error is
// logged when it differs from key's last one, and key is forgotten once it
// succeeds. The zero value is ready to use.
type Repeats struct {
	mu   sync.Mutex
	last map[string]string
}

// Log records err for key: logged at level with msg and args when it is new,
// or forgotten when nil.
func (r *Repeats) Log(ctx context.Context, level slog.Level, key string, err error, msg string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err == nil {
		delete(r.last, key)
		return
	}
	if r.last == nil {
		r.last = map[string]string{}
	}
	if r.last[key] == err.Error() {
		return
	}
	r.last[key] = err.Error()
	slog.Log(ctx, level, msg, append(args, "error", err)...)
}
