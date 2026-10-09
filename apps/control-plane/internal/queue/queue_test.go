package queue

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

// Against a real NATS server of its own: AXP_TEST_NATS_URL, e.g.
//
//	docker run --rm -p 127.0.0.1:14222:4222 nats:2.14-alpine --jetstream
//	AXP_TEST_NATS_URL=nats://127.0.0.1:14222 go test ./internal/queue/
func connect(t *testing.T) *NATS {
	t.Helper()
	url := os.Getenv("AXP_TEST_NATS_URL")
	if url == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("AXP_TEST_NATS_URL is not set; CI runs the NATS tests")
		}
		t.Skip("AXP_TEST_NATS_URL is not set")
	}
	q, err := Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(q.Close)
	if err := q.EnsureStreams(context.Background()); err != nil {
		t.Fatal(err)
	}
	return q
}

func TestCommands(t *testing.T) {
	q := connect(t)
	ctx := context.Background()
	agent := uuid.NewString()
	t.Cleanup(func() { _ = q.Forget(context.Background(), agent) })
	if err := q.OpenConsumer(ctx, agent); err != nil {
		t.Fatal(err)
	}
	var seqs []int64
	for range MaxQueuedPerAgent {
		seq, err := q.Enqueue(ctx, agent, map[string]any{"command_id": uuid.NewString()})
		if err != nil {
			t.Fatal(err)
		}
		seqs = append(seqs, seq)
	}
	if _, err := q.Enqueue(ctx, agent, map[string]any{}); !errors.Is(err, ErrFull) {
		t.Fatalf("a full queue took a command: %v", err)
	}
	agents, err := q.AgentsWithCommands(ctx)
	if err != nil || !agents[agent] {
		t.Fatalf("agents %v %v", agents, err)
	}
	if waiting, err := q.Waiting(ctx, seqs[0]); err != nil || !waiting {
		t.Fatalf("waiting %v %v", waiting, err)
	}
	if ok, err := q.Withdraw(ctx, seqs[0]); err != nil || !ok {
		t.Fatalf("withdraw %v %v", ok, err)
	}
	if ok, err := q.Withdraw(ctx, seqs[0]); err != nil || ok {
		t.Fatalf("withdrew twice %v %v", ok, err)
	}
	if waiting, err := q.Waiting(ctx, seqs[0]); err != nil || waiting {
		t.Fatalf("still waiting %v %v", waiting, err)
	}
	if err := q.Drop(ctx, agent); err != nil {
		t.Fatal(err)
	}
	if agents, _ := q.AgentsWithCommands(ctx); agents[agent] {
		t.Fatal("dropped commands remain")
	}
}

func TestControl(t *testing.T) {
	q := connect(t)
	ctx := context.Background()
	agent := uuid.NewString()
	if answer, err := q.Ask(ctx, agent, map[string]any{"type": "steer"}); err != nil || answer != nil {
		t.Fatalf("nobody listens, yet %v %v", answer, err)
	}
	sub, err := q.nc.Subscribe(ControlSubject(agent), func(m *nats.Msg) { _ = m.Respond([]byte(`{"accepted":true}`)) })
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Unsubscribe() //nolint:errcheck
	answer, err := q.Ask(ctx, agent, map[string]any{"type": "steer"})
	if err != nil || answer["accepted"] != true {
		t.Fatalf("answer %v %v", answer, err)
	}
	if err := q.Tell(ctx, agent, map[string]any{"type": "interrupt"}); err != nil {
		t.Fatal(err)
	}
}
