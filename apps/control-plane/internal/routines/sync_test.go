package routines

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/routines/migrations"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/akarachen/axp/packages/service-go/pg/pgtest"
	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"
)

func TestMain(m *testing.M) { pgtest.Main(m, migrations.All) }

// The worker's sync leaves exactly the enabled routines' schedules: a
// paused routine's and a deleted one's go.
func TestSyncSchedulesLeavesTheEnabledRoutines(t *testing.T) {
	url := os.Getenv("AXP_TEST_NATS_URL")
	if url == "" {
		t.Skip("AXP_TEST_NATS_URL is not set")
	}
	db := pgtest.DB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	n, err := ConnectNATS(ctx, url, "routines-test")
	if err != nil {
		t.Fatal(err)
	}
	defer n.Close()
	enabled, paused, deleted := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, r := range []struct {
		id string
		on bool
	}{{enabled, true}, {paused, false}} {
		if _, err := db.Exec(ctx, `INSERT INTO routine (id, name, model, schedule, timezone, enabled, created_at, updated_at)
			VALUES ($1, 'r', 'm', '{"kind":"daily","time":"08:00"}', 'Asia/Shanghai', $2, $3, $3)`, r.id, r.on, pg.Now()); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{paused, deleted} {
		if err := n.Schedule(ctx, id, "0 8 * * *", "Asia/Shanghai"); err != nil {
			t.Fatal(err)
		}
	}
	if err := SyncSchedules(ctx, db, &Service{Schedules: n}, n); err != nil {
		t.Fatal(err)
	}
	stream, err := n.js.Stream(ctx, Stream)
	if err != nil {
		t.Fatal(err)
	}
	info, err := stream.Info(ctx, jetstream.WithSubjectFilter(scheduleSubject("*")))
	if err != nil {
		t.Fatal(err)
	}
	if len(info.State.Subjects) != 1 || info.State.Subjects[scheduleSubject(enabled)] != 1 {
		t.Fatalf("schedules %v", info.State.Subjects)
	}
	if err := n.Unschedule(ctx, enabled); err != nil {
		t.Fatal(err)
	}
}
