package routines

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Schedules in NATS JetStream: stream ROUTINES, which this service owns.
// axp.routine.<routine>.schedule holds a routine's message schedule (cron
// with a time zone), which NATS publishes to axp.routine.<routine>.fire when
// it is due; "run now" publishes there directly. The service takes fires
// through the durable consumer routine-fires.

const (
	Stream    = "ROUTINES"
	consumer  = "routine-fires"
	natsLimit = 5 * time.Second
)

// A fire that waited longer than this in the stream (the service was down,
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
	nc     *nats.Conn
	js     jetstream.JetStream
	stream jetstream.Stream
}

// ConnectNATS connects to url as the services' user (with its password,
// when the server has one) and makes sure the stream and its consumer exist.
func ConnectNATS(ctx context.Context, url, password string) (*NATS, error) {
	options := []nats.Option{nats.Name("routine-service"), nats.Timeout(natsLimit),
		nats.RetryOnFailedConnect(true), nats.MaxReconnects(-1)}
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
	ctx, cancel := context.WithTimeout(ctx, natsLimit)
	defer cancel()
	stream, err := js.CreateOrUpdateStream(ctx, streamConfig)
	if err == nil {
		_, err = stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
			Durable: consumer, FilterSubject: fireSubject("*"), AckPolicy: jetstream.AckExplicitPolicy,
		})
	}
	if err != nil {
		nc.Close()
		return nil, err
	}
	return &NATS{nc: nc, js: js, stream: stream}, nil
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
	ctx, cancel := context.WithTimeout(ctx, natsLimit)
	defer cancel()
	return n.stream.Purge(ctx, jetstream.WithPurgeSubject(scheduleSubject(routineID)))
}

func (n *NATS) Fire(ctx context.Context, routineID string) error {
	ctx, cancel := context.WithTimeout(ctx, natsLimit)
	defer cancel()
	_, err := n.js.Publish(ctx, fireSubject(routineID), []byte(`{"now":true}`))
	return err
}

// Sync makes the stream's schedules the enabled routines': it purges every
// schedule and publishes theirs again, so schedules of routines that are
// gone do not outlive them.
func (n *NATS) Sync(ctx context.Context, rows []Routine) error {
	purge, cancel := context.WithTimeout(ctx, natsLimit)
	defer cancel()
	if err := n.stream.Purge(purge, jetstream.WithPurgeSubject(scheduleSubject("*"))); err != nil {
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
// before the service started (staleFire) is dropped, not made up.
func (n *NATS) Consume(ctx context.Context, fire func(ctx context.Context, routineID string, now bool) error) error {
	c, err := n.stream.Consumer(ctx, consumer)
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
			slog.InfoContext(ctx, "Skipped a routine fire that waited while the service was down",
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
