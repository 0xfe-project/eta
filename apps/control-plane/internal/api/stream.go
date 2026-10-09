package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/danielgtaylor/huma/v2"
)

// Server-sent product events, replayed from the persistent ui_event table.
// Every event is read back from the database, so a client that reconnects
// with its last cursor misses nothing; polling only decides when to look
// again.

const (
	streamBatch = 100
	pollEvery   = 500 * time.Millisecond
	heartbeat   = 15 * time.Second
)

type streamOptions struct {
	poll      time.Duration
	heartbeat time.Duration
	// Stop after this many polls without events (tests); 0 never stops.
	maxIdlePolls int
}

// streamEvents writes events after seq until ctx ends.
func streamEvents(ctx context.Context, d *Deps, w io.Writer, flush func(), seq int64, opts streamOptions) error {
	// Tell EventSource how long to wait before reconnecting.
	if _, err := io.WriteString(w, "retry: 3000\n\n"); err != nil {
		return err
	}
	flush()
	conversationID := ""
	lastWrite := time.Now()
	idle := 0
	for {
		var events []*chat.UIEvent
		if conversationID == "" {
			var err error
			if conversationID, err = chat.DefaultConversationID(ctx, d.DB); err != nil {
				return err
			}
		}
		if conversationID != "" {
			var err error
			if events, err = chat.EventsAfter(ctx, d.DB, conversationID, seq, streamBatch); err != nil {
				return err
			}
		}
		for _, event := range events {
			seq = event.Seq
			var data bytes.Buffer
			if err := json.Compact(&data, event.Payload); err != nil {
				return err
			}
			if _, err := fmt.Fprintf(w, "id: %s\nevent: %s\ndata: %s\n\n", d.Chat.Cursors.Event(event.Seq), event.Type, data.Bytes()); err != nil {
				return err
			}
		}
		if len(events) > 0 {
			flush()
			lastWrite, idle = time.Now(), 0
			continue
		}
		if time.Since(lastWrite) >= opts.heartbeat {
			// A comment: keeps proxies open without moving the cursor.
			if _, err := io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return err
			}
			flush()
			lastWrite = time.Now()
		}
		idle++
		if opts.maxIdlePolls > 0 && idle >= opts.maxIdlePolls {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(opts.poll):
		}
	}
}

func registerStream(api huma.API, d *Deps) {
	registry := api.OpenAPI().Components.Schemas
	var payloads []*huma.Schema
	for _, t := range []reflect.Type{
		reflect.TypeFor[chat.AgentUpdated](), reflect.TypeFor[chat.AgentDeleted](),
		reflect.TypeFor[chat.MessageUpdated](), reflect.TypeFor[chat.InteractionUpdated](),
	} {
		payloads = append(payloads, registry.Schema(t, true, ""))
	}
	operation := op("chatStream", http.MethodGet, "/api/v1/chat/stream",
		"Product events after a cursor (server-sent events)", 200, "chat")
	operation.Description = "Events agent.updated (AgentUpdated), agent.deleted (AgentDeleted), " +
		"message.updated (MessageUpdated) and interaction.updated (InteractionUpdated); each event's id " +
		"is the cursor to resume after it."
	operation.Responses = map[string]*huma.Response{
		"200": {
			Description: "Server-sent events",
			Content: map[string]*huma.MediaType{
				"text/event-stream": {Schema: &huma.Schema{OneOf: payloads}},
			},
		},
	}
	huma.Register(api, operation, func(ctx context.Context, in *struct {
		Cursor      string `query:"cursor" doc:"The snapshot's event_cursor."`
		LastEventID string `header:"Last-Event-ID" doc:"Sent by a reconnecting EventSource; wins over cursor."`
	}) (*huma.StreamResponse, error) {
		// A reconnecting EventSource resumes from its last delivered event.
		start := in.LastEventID
		if start == "" {
			start = in.Cursor
		}
		if start == "" {
			return nil, apierr.New(400, "INVALID_CURSOR", "缺少事件游标。")
		}
		seq, err := d.Chat.StreamStart(ctx, d.DB, start)
		if err != nil {
			return nil, err
		}
		return &huma.StreamResponse{Body: func(hctx huma.Context) {
			hctx.SetHeader("Content-Type", "text/event-stream")
			hctx.SetHeader("Cache-Control", "no-cache")
			hctx.SetHeader("X-Accel-Buffering", "no")
			hctx.SetStatus(http.StatusOK)
			w := hctx.BodyWriter()
			flush := func() {
				if f, ok := w.(http.Flusher); ok {
					f.Flush()
				}
			}
			_ = streamEvents(hctx.Context(), d, w, flush, seq, streamOptions{poll: pollEvery, heartbeat: heartbeat})
		}}, nil
	})
}
