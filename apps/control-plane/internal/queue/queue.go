// Package queue is the agent queue: NATS JetStream
// (docs/architecture/queue.md).
//
// This is the only queue. A command waiting to run is a message on its
// agent's subject axp.agent.<agent>.commands; PostgreSQL records what
// happened to it, never whether it waits. The agent's runtime takes one
// message at a time through the consumer agent-<agent>, acks it and runs it.
//
// The live runtime also listens on axp.agent.<agent>.control (plain NATS,
// not stored): interrupts, approval decisions and steers go there.
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

const (
	Stream = "AGENTS"
	// MaxQueuedPerAgent commands wait at most; a full queue refuses more.
	MaxQueuedPerAgent = 20
	timeout           = 5 * time.Second
	// A runtime acks a command as soon as it takes it; this only matters if
	// it dies in between.
	ackWait = 30 * time.Second

	// JetStream's "maximum messages per subject exceeded".
	errMaxMsgsPerSubject = 10077
	// JetStream's answers when deleting a message that is gone: "no message
	// found", or "sequence not found" when messages around it remain (other
	// agents' commands, in the shared stream).
	errMsgDeleteFailed  = 10057
	errSequenceNotFound = 10043
)

// ErrFull is a full agent queue.
var ErrFull = errors.New("agent queue full")

// Queue is what the control plane does with NATS.
type Queue interface {
	// Enqueue queues a command; returns its stream sequence, or ErrFull.
	Enqueue(ctx context.Context, agentID string, body any) (int64, error)
	// Withdraw takes a command off the queue; false if a runtime took it.
	Withdraw(ctx context.Context, seq int64) (bool, error)
	// Waiting reports whether a command is still in the queue.
	Waiting(ctx context.Context, seq int64) (bool, error)
	AgentsWithCommands(ctx context.Context) (map[string]bool, error)
	// OpenConsumer opens the agent's consumer; its runtime reads through it.
	OpenConsumer(ctx context.Context, agentID string) error
	// Drop empties the agent's queue.
	Drop(ctx context.Context, agentID string) error
	// Forget drops a deleted agent's queue and consumer.
	Forget(ctx context.Context, agentID string) error
	// Tell sends the agent's live runtime a control message, if it listens.
	Tell(ctx context.Context, agentID string, body any) error
	// Ask asks the agent's live runtime; nil when no runtime answers.
	Ask(ctx context.Context, agentID string, body any) (map[string]any, error)
}

func CommandsSubject(agentID string) string { return "axp.agent." + agentID + ".commands" }
func ControlSubject(agentID string) string  { return "axp.agent." + agentID + ".control" }
func ConsumerName(agentID string) string    { return "agent-" + agentID }

var streamConfig = jetstream.StreamConfig{
	Name:     Stream,
	Subjects: []string{"axp.agent.*.commands"},
	// A message stays until a runtime takes it.
	Retention: jetstream.WorkQueuePolicy,
	Storage:   jetstream.FileStorage,
	// A full agent queue refuses new commands.
	MaxMsgsPerSubject:    MaxQueuedPerAgent,
	Discard:              jetstream.DiscardNew,
	DiscardNewPerSubject: true,
	MaxMsgs:              -1,
	MaxBytes:             -1,
	MaxAge:               0,
	MaxMsgSize:           -1,
	MaxConsumers:         -1,
}

// NATS is the queue on a NATS server.
type NATS struct {
	nc *nats.Conn
	js jetstream.JetStream

	mu      sync.Mutex
	streams map[string]jetstream.Stream
}

// Connect connects to url as the services' user (with its password, when
// the server has one); a server that is not up yet is retried in the
// background.
func Connect(url, password string) (*NATS, error) {
	options := []nats.Option{
		nats.Name("control-plane"),
		nats.Timeout(timeout),
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
	}
	if password != "" {
		options = append(options, nats.UserInfo("services", password))
	}
	nc, err := nats.Connect(url, options...)
	if err != nil {
		return nil, err
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, err
	}
	return &NATS{nc: nc, js: js, streams: map[string]jetstream.Stream{}}, nil
}

func (q *NATS) Close() { q.nc.Close() }

func (q *NATS) stream(ctx context.Context, name string) (jetstream.Stream, error) {
	q.mu.Lock()
	s, ok := q.streams[name]
	q.mu.Unlock()
	if ok {
		return s, nil
	}
	s, err := q.js.Stream(ctx, name)
	if err != nil {
		return nil, err
	}
	q.mu.Lock()
	q.streams[name] = s
	q.mu.Unlock()
	return s, nil
}

func withTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, timeout)
}

// EnsureStreams creates or updates the stream.
func (q *NATS) EnsureStreams(ctx context.Context) error {
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	_, err := q.js.CreateOrUpdateStream(ctx, streamConfig)
	return err
}

func (q *NATS) Enqueue(ctx context.Context, agentID string, body any) (int64, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	ack, err := q.js.Publish(ctx, CommandsSubject(agentID), data)
	if err != nil {
		var apiErr *jetstream.APIError
		if errors.As(err, &apiErr) && apiErr.ErrorCode == errMaxMsgsPerSubject {
			return 0, ErrFull
		}
		return 0, err
	}
	return int64(ack.Sequence), nil
}

func (q *NATS) Withdraw(ctx context.Context, seq int64) (bool, error) {
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	s, err := q.stream(ctx, Stream)
	if err != nil {
		return false, err
	}
	if err := s.DeleteMsg(ctx, uint64(seq)); err != nil {
		// The client keeps only the text of the server's answer.
		gone := errors.Is(err, jetstream.ErrMsgDeleteUnsuccessful) &&
			(strings.Contains(err.Error(), fmt.Sprintf("err_code=%d", errMsgDeleteFailed)) ||
				strings.Contains(err.Error(), fmt.Sprintf("err_code=%d", errSequenceNotFound)))
		if gone || errors.Is(err, jetstream.ErrMsgNotFound) {
			// A runtime took it.
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func (q *NATS) Waiting(ctx context.Context, seq int64) (bool, error) {
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	s, err := q.stream(ctx, Stream)
	if err != nil {
		return false, err
	}
	if _, err := s.GetMsg(ctx, uint64(seq)); err != nil {
		if errors.Is(err, jetstream.ErrMsgNotFound) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func (q *NATS) AgentsWithCommands(ctx context.Context) (map[string]bool, error) {
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	s, err := q.stream(ctx, Stream)
	if err != nil {
		return nil, err
	}
	info, err := s.Info(ctx, jetstream.WithSubjectFilter("axp.agent.*.commands"))
	if err != nil {
		return nil, err
	}
	agents := map[string]bool{}
	for subject := range info.State.Subjects {
		if parts := strings.Split(subject, "."); len(parts) == 4 {
			agents[parts[2]] = true
		}
	}
	return agents, nil
}

func (q *NATS) OpenConsumer(ctx context.Context, agentID string) error {
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	s, err := q.stream(ctx, Stream)
	if err != nil {
		return err
	}
	_, err = s.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:       ConsumerName(agentID),
		FilterSubject: CommandsSubject(agentID),
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       ackWait,
	})
	return err
}

func (q *NATS) Drop(ctx context.Context, agentID string) error {
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	s, err := q.stream(ctx, Stream)
	if err != nil {
		return err
	}
	return s.Purge(ctx, jetstream.WithPurgeSubject(CommandsSubject(agentID)))
}

func (q *NATS) Forget(ctx context.Context, agentID string) error {
	if err := q.Drop(ctx, agentID); err != nil {
		return err
	}
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	s, err := q.stream(ctx, Stream)
	if err != nil {
		return err
	}
	if err := s.DeleteConsumer(ctx, ConsumerName(agentID)); err != nil && !errors.Is(err, jetstream.ErrConsumerNotFound) {
		return err
	}
	return nil
}

func (q *NATS) Tell(ctx context.Context, agentID string, body any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	if err := q.nc.Publish(ControlSubject(agentID), data); err != nil {
		return err
	}
	return q.nc.FlushTimeout(timeout)
}

func (q *NATS) Ask(ctx context.Context, agentID string, body any) (map[string]any, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	ctx, cancel := withTimeout(ctx)
	defer cancel()
	reply, err := q.nc.RequestWithContext(ctx, ControlSubject(agentID), data)
	if errors.Is(err, nats.ErrNoResponders) || errors.Is(err, nats.ErrTimeout) || errors.Is(err, context.DeadlineExceeded) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var answer map[string]any
	if err := json.Unmarshal(reply.Data, &answer); err != nil {
		return nil, err
	}
	return answer, nil
}
