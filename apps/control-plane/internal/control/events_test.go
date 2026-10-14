package control

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/bundles"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/plugins"
	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/akarachen/axp/packages/service-go/pg/pgtest"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/nats-io/nats.go/jetstream"
)

func TestMain(m *testing.M) { pgtest.Main(m, store.Migrations) }

// Against a NATS server of its own: AXP_TEST_NATS_URL, e.g.
//
//	docker run --rm -p 127.0.0.1:14222:4222 nats:2.14-alpine --jetstream
//	AXP_TEST_NATS_URL=nats://127.0.0.1:14222 go test ./internal/control/
func TestEventsAreImportedOnceInOrder(t *testing.T) {
	url := os.Getenv("AXP_TEST_NATS_URL")
	if url == "" {
		t.Skip("AXP_TEST_NATS_URL is not set")
	}
	ctx := context.Background()
	events, err := ConnectEvents(url)
	if err != nil {
		t.Fatal(err)
	}
	if err := events.EnsureStream(ctx); err != nil {
		t.Fatal(err)
	}
	stream, err := events.js.Stream(ctx, EventStream)
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.Purge(ctx); err != nil {
		t.Fatal(err)
	}
	db := pgtest.DB(t)
	service := &chat.Service{Bundles: &bundles.Catalog{Dir: "../../../../bundles", Plugins: &plugins.Catalog{Dir: "../../../../plugins"}}}
	agent, err := pg.InTxValue(ctx, db, func(tx pgx.Tx) (*chat.Agent, error) {
		return service.CreateAgent(ctx, tx, "a", "", nil, []string{})
	})
	if err != nil {
		t.Fatal(err)
	}
	boot := uuid.NewString()
	publish := func(seq int64, kind string) {
		data, _ := json.Marshal(chat.RuntimeEvent{BootID: boot, Seq: seq, Type: kind, Payload: map[string]any{}})
		if _, err := events.js.Publish(ctx, "axp.agent."+agent.ID+".events", data, jetstream.WithMsgID(fmt.Sprintf("%s:%d", boot, seq))); err != nil {
			t.Fatal(err)
		}
	}
	imported := func() int {
		var n int
		_ = db.QueryRow(ctx, "SELECT count(*) FROM agent_event WHERE agent_id = $1", agent.ID).Scan(&n)
		return n
	}
	run := func(want int) {
		t.Helper()
		ctx, cancel := context.WithCancel(ctx)
		woken := make(chan string, 10)
		done := make(chan struct{})
		go func() { events.Import(ctx, db, service, func(id string) { woken <- id }); close(done) }()
		deadline := time.Now().Add(10 * time.Second)
		for imported() < want && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		cancel()
		<-done
		if got := imported(); got != want {
			t.Fatalf("imported %d, want %d", got, want)
		}
		if id := <-woken; id != agent.ID {
			t.Fatalf("woke %s", id)
		}
	}
	publish(1, "runtime.started")
	publish(1, "runtime.started") // a retried publish
	publish(2, "runtime.notice")
	run(2)
	var status string
	_ = db.QueryRow(ctx, "SELECT status FROM agent WHERE id = $1", agent.ID).Scan(&status)
	if status != "ready" {
		t.Fatalf("status %s", status)
	}
	// Started again, it goes on from where it was.
	publish(3, "runtime.notice")
	run(3)
}
