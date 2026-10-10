package control

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Runtimes publish their events to JetStream, one subject per agent
// (apps/agent-runtime/src/outbox.ts). The controller reads the stream in
// order and imports each batch in one transaction together with how far it
// has read (event_position), so every event is imported once, in order,
// whatever stops in between. The stream keeps a week of events.

const (
	EventStream  = "AGENT_EVENTS"
	eventSubject = "axp.agent.*.events"
	natsTimeout  = 5 * time.Second
)

var eventStreamConfig = jetstream.StreamConfig{
	Name:      EventStream,
	Subjects:  []string{eventSubject},
	Retention: jetstream.LimitsPolicy,
	Storage:   jetstream.FileStorage,
	MaxAge:    7 * 24 * time.Hour,
	// Runtimes retry a publish with the same message id.
	Duplicates: 2 * time.Minute,
	MaxMsgs:    -1,
	MaxBytes:   -1,
}

// Events is the runtimes' event stream.
type Events struct {
	js jetstream.JetStream
}

// ConnectEvents connects to NATS at url; a server that is not up yet is
// retried in the background.
func ConnectEvents(url string) (*Events, error) {
	nc, err := nats.Connect(url, nats.Name("control-plane"), nats.Timeout(natsTimeout),
		nats.RetryOnFailedConnect(true), nats.MaxReconnects(-1))
	if err != nil {
		return nil, err
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, err
	}
	return &Events{js: js}, nil
}

// EnsureStream creates or updates the stream.
func (e *Events) EnsureStream(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, natsTimeout)
	defer cancel()
	_, err := e.js.CreateOrUpdateStream(ctx, eventStreamConfig)
	return err
}

type delivered struct {
	agentID string
	event   chat.RuntimeEvent
}

// Import reads the stream until ctx ends, importing through service and
// waking the controller for each agent it heard from.
func (e *Events) Import(ctx context.Context, db *pgxpool.Pool, service *chat.Service, wake func(agentID string)) {
	for ctx.Err() == nil {
		if err := e.importFrom(ctx, db, service, wake); err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "Importing runtime events failed; retrying", "error", err)
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
			}
		}
	}
}

func (e *Events) importFrom(ctx context.Context, db *pgxpool.Pool, service *chat.Service, wake func(string)) error {
	var position uint64
	err := db.QueryRow(ctx, "SELECT seq FROM event_position WHERE stream = $1", EventStream).Scan(&position)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	stream, err := e.js.Stream(ctx, EventStream)
	if err != nil {
		return err
	}
	config := jetstream.OrderedConsumerConfig{FilterSubjects: []string{eventSubject}}
	if position > 0 {
		config.DeliverPolicy, config.OptStartSeq = jetstream.DeliverByStartSequencePolicy, position+1
	}
	consumer, err := stream.OrderedConsumer(ctx, config)
	if err != nil {
		return err
	}
	for ctx.Err() == nil {
		batch, err := consumer.Fetch(chat.MaxEventBatch, jetstream.FetchMaxWait(time.Second))
		if err != nil {
			return err
		}
		var events []delivered
		last := position
		for msg := range batch.Messages() {
			meta, err := msg.Metadata()
			if err != nil {
				return err
			}
			last = meta.Sequence.Stream
			parts := strings.Split(msg.Subject(), ".")
			var event chat.RuntimeEvent
			if len(parts) != 4 || json.Unmarshal(msg.Data(), &event) != nil {
				slog.WarnContext(ctx, "Skipping a malformed runtime event", "subject", msg.Subject())
				continue
			}
			if id, ok := pg.ParseID(parts[2]); ok {
				events = append(events, delivered{agentID: id, event: event})
			}
		}
		if err := batch.Error(); err != nil && !errors.Is(err, nats.ErrTimeout) {
			return err
		}
		if last == position {
			continue
		}
		if err := pg.InTx(ctx, db, func(tx pgx.Tx) error {
			for start := 0; start < len(events); {
				end := start + 1
				for end < len(events) && events[end].agentID == events[start].agentID {
					end++
				}
				run := make([]chat.RuntimeEvent, 0, end-start)
				for _, d := range events[start:end] {
					run = append(run, d.event)
				}
				if err := service.ImportEvents(ctx, tx, events[start].agentID, run); err != nil {
					return err
				}
				start = end
			}
			_, err := tx.Exec(ctx, `INSERT INTO event_position (stream, seq) VALUES ($1, $2)
				ON CONFLICT (stream) DO UPDATE SET seq = excluded.seq`, EventStream, last)
			return err
		}); err != nil {
			return err
		}
		position = last
		woken := map[string]bool{}
		for _, d := range events {
			if !woken[d.agentID] {
				woken[d.agentID] = true
				wake(d.agentID)
			}
		}
	}
	return nil
}
