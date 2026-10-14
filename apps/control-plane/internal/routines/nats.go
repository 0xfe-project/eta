package routines

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Schedules in NATS JetStream: stream ROUTINES, which routines own.
// axp.routine.<routine>.schedule holds a routine's message schedule (cron
// with a time zone), which NATS publishes to axp.routine.<routine>.fire when
// it is due; "run now" publishes there directly. The API only publishes
// these; the routine worker makes the stream, syncs the schedules when it
// starts (SyncSchedules) and takes fires through the durable consumer
// routine-fires.

const (
	Stream    = "ROUTINES"
	consumer  = "routine-fires"
	natsLimit = 5 * time.Second
)

// A fire that waited longer than this in the stream (the worker was down,
// so it piled up) is dropped when it is finally taken: missed fires are not
// made up, and neither is a "run now" nobody took in time.
var staleFire = time.Minute

var streamConfig = jetstream.StreamConfig{
	Name:     Stream,
	Subjects: []string{"axp.routine.>"},
	// A fire stays until it is taken; schedules stay until replaced or
	// purged.
	Retention:         jetstream.WorkQueuePolicy,
	Storage:           jetstream.FileStorage,
	AllowMsgSchedules: true,
	MaxMsgs:           -1,
	MaxBytes:          -1,
	MaxMsgSize:        -1,
	MaxConsumers:      -1,
	MaxMsgsPerSubject: -1,
}

func scheduleSubject(id string) string { return "axp.routine." + id + ".schedule" }
func fireSubject(id string) string     { return "axp.routine." + id + ".fire" }

// NATS is the routines' schedules on a NATS server.
type NATS struct {
	nc *nats.Conn
	js jetstream.JetStream
}

// DialNATS connects to url, reconnecting for as long as it takes: the API
// starts without NATS, and only its writes to schedules fail meanwhile.
func DialNATS(url, name string) (*NATS, error) {
	nc, err := nats.Connect(url, nats.Name(name), nats.Timeout(natsLimit),
		nats.RetryOnFailedConnect(true), nats.MaxReconnects(-1))
	if err != nil {
		return nil, err
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, err
	}
	return &NATS{nc: nc, js: js}, nil
}

// ConnectNATS connects to url and makes sure the stream and its consumer
// exist: the worker's connection.
func ConnectNATS(ctx context.Context, url, name string) (*NATS, error) {
	n, err := DialNATS(url, name)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, natsLimit)
	defer cancel()
	stream, err := n.js.CreateOrUpdateStream(ctx, streamConfig)
	if err == nil {
		_, err = stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
			Durable: consumer, FilterSubject: fireSubject("*"), AckPolicy: jetstream.AckExplicitPolicy,
		})
	}
	if err != nil {
		n.Close()
		return nil, err
	}
	return n, nil
}

func (n *NATS) Close() { n.nc.Close() }

func (n *NATS) Schedule(ctx context.Context, routineID, cron, timezone string) error {
	ctx, cancel := context.WithTimeout(ctx, natsLimit)
	defer cancel()
	msg := nats.NewMsg(scheduleSubject(routineID))
	msg.Data = []byte("{}")
	// NATS cron has seconds.
	msg.Header.Set(jetstream.ScheduleHeader, "0 "+cron)
	msg.Header.Set(jetstream.ScheduleTargetHeader, fireSubject(routineID))
	msg.Header.Set(jetstream.ScheduleTimeZoneHeader, timezone)
	_, err := n.js.PublishMsg(ctx, msg)
	return err
}

func (n *NATS) Unschedule(ctx context.Context, routineID string) error {
	return n.purge(ctx, scheduleSubject(routineID))
}

func (n *NATS) purge(ctx context.Context, subject string) error {
	ctx, cancel := context.WithTimeout(ctx, natsLimit)
	defer cancel()
	stream, err := n.js.Stream(ctx, Stream)
	if err != nil {
		return err
	}
	return stream.Purge(ctx, jetstream.WithPurgeSubject(subject))
}

func (n *NATS) Fire(ctx context.Context, routineID string) error {
	ctx, cancel := context.WithTimeout(ctx, natsLimit)
	defer cancel()
	_, err := n.js.Publish(ctx, fireSubject(routineID), []byte(`{"now":true}`))
	return err
}

// SyncSchedules makes the stream's schedules the enabled routines': it
// purges every schedule and publishes theirs again, so schedules of routines
// that are gone do not outlive them. It holds a lock on the routine table
// meanwhile, so no write from the API (which schedules before it commits)
// falls between the list and the purge.
func SyncSchedules(ctx context.Context, db *pgxpool.Pool, s *Service, n *NATS) error {
	return pg.InTx(ctx, db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "LOCK TABLE routine IN SHARE MODE"); err != nil {
			return err
		}
		rows, err := s.List(ctx, tx)
		if err != nil {
			return err
		}
		return n.sync(ctx, rows)
	})
}

func (n *NATS) sync(ctx context.Context, rows []RoutineSummary) error {
	if err := n.purge(ctx, scheduleSubject("*")); err != nil {
		return err
	}
	for _, r := range rows {
		if r.Enabled {
			if err := n.Schedule(ctx, r.ID, r.Schedule.Cron5(), r.Timezone); err != nil {
				return err
			}
		}
	}
	return nil
}

// Consume hands fires to fire as they arrive (now when asked to run now),
// until ctx ends. A fire is acked when it is taken; one that waited since
// before the worker started (staleFire) is dropped, not made up.
func (n *NATS) Consume(ctx context.Context, fire func(ctx context.Context, routineID string, now bool) error) error {
	c, err := n.js.Consumer(ctx, Stream, consumer)
	if err != nil {
		return err
	}
	consuming, err := c.Consume(func(msg jetstream.Msg) {
		_ = msg.Ack()
		parts := strings.Split(msg.Subject(), ".")
		if len(parts) != 4 {
			return
		}
		if meta, err := msg.Metadata(); err == nil && time.Since(meta.Timestamp) > staleFire {
			slog.InfoContext(ctx, "Skipped a routine fire that waited while the worker was down",
				"routine", parts[2], "fired_at", meta.Timestamp)
			return
		}
		var body struct {
			Now bool `json:"now"`
		}
		_ = json.Unmarshal(msg.Data(), &body)
		if err := fire(ctx, parts[2], body.Now); err != nil {
			slog.ErrorContext(ctx, "Starting a routine run failed", "routine", parts[2], "error", err)
		}
	})
	if err != nil {
		return err
	}
	<-ctx.Done()
	consuming.Stop()
	return nil
}
