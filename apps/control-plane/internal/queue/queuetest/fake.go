// Package queuetest stands in for NATS in tests: the agents' queues and
// their live runtimes.
package queuetest

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"

	"github.com/akarachen/axp/apps/control-plane/internal/queue"
)

type command struct {
	agentID string
	body    map[string]any
}

type Fake struct {
	mu       sync.Mutex
	commands map[int64]command
	seq      int64

	Consumers []string
	Forgotten []string
	Told      []map[string]any
	Asked     []map[string]any
	// Steering is whether a running turn takes steers.
	Steering bool
	// Down makes every call that needs NATS fail.
	Down bool
	// MaxQueued is the per-agent limit (queue.MaxQueuedPerAgent by default).
	MaxQueued int
}

func New() *Fake {
	return &Fake{commands: map[int64]command{}, MaxQueued: queue.MaxQueuedPerAgent}
}

var errDown = errors.New("nats down")

func asMap(body any) map[string]any {
	data, _ := json.Marshal(body)
	var m map[string]any
	_ = json.Unmarshal(data, &m)
	return m
}

func (f *Fake) Enqueue(_ context.Context, agentID string, body any) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Down {
		return 0, errDown
	}
	if len(f.queuedLocked(agentID)) >= f.MaxQueued {
		return 0, queue.ErrFull
	}
	f.seq++
	f.commands[f.seq] = command{agentID, asMap(body)}
	return f.seq, nil
}

func (f *Fake) Withdraw(_ context.Context, seq int64) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.commands[seq]
	delete(f.commands, seq)
	return ok, nil
}

func (f *Fake) Waiting(_ context.Context, seq int64) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.commands[seq]
	return ok, nil
}

func (f *Fake) AgentsWithCommands(context.Context) (map[string]bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	agents := map[string]bool{}
	for _, c := range f.commands {
		agents[c.agentID] = true
	}
	return agents, nil
}

func (f *Fake) OpenConsumer(_ context.Context, agentID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Consumers = append(f.Consumers, agentID)
	return nil
}

func (f *Fake) Drop(_ context.Context, agentID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for seq, c := range f.commands {
		if c.agentID == agentID {
			delete(f.commands, seq)
		}
	}
	return nil
}

func (f *Fake) Forget(ctx context.Context, agentID string) error {
	_ = f.Drop(ctx, agentID)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Forgotten = append(f.Forgotten, agentID)
	return nil
}

func (f *Fake) Tell(_ context.Context, _ string, body any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Told = append(f.Told, asMap(body))
	return nil
}

func (f *Fake) Ask(_ context.Context, _ string, body any) (map[string]any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Asked = append(f.Asked, asMap(body))
	return map[string]any{"accepted": f.Steering}, nil
}

// --- for tests ---------------------------------------------------------------

func (f *Fake) queuedLocked(agentID string) []map[string]any {
	var seqs []int64
	for seq, c := range f.commands {
		if c.agentID == agentID {
			seqs = append(seqs, seq)
		}
	}
	slices.Sort(seqs)
	bodies := []map[string]any{}
	for _, seq := range seqs {
		bodies = append(bodies, f.commands[seq].body)
	}
	return bodies
}

// Queued is the agent's waiting commands, in order.
func (f *Fake) Queued(agentID string) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.queuedLocked(agentID)
}

// Take is what the agent's runtime does: take the next command.
func (f *Fake) Take(agentID string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	var first int64
	for seq, c := range f.commands {
		if c.agentID == agentID && (first == 0 || seq < first) {
			first = seq
		}
	}
	if first == 0 {
		return nil
	}
	body := f.commands[first].body
	delete(f.commands, first)
	return body
}

// ToldOf is the control messages of type kind, without their type.
func (f *Fake) ToldOf(kind string) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []map[string]any{}
	for _, body := range f.Told {
		if body["type"] != kind {
			continue
		}
		rest := map[string]any{}
		for k, v := range body {
			if k != "type" {
				rest[k] = v
			}
		}
		out = append(out, rest)
	}
	return out
}
