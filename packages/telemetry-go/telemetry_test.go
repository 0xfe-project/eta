package telemetry

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

func TestConsoleLine(t *testing.T) {
	var out bytes.Buffer
	logger := slog.New(levelHandler{newConsoleHandler(&out)})

	logger.Debug("hidden")
	logger.With("svc", "api").WithGroup("g").Warn("gateway listening", "addr", ":8080", "note", "two words", "n", 3)

	line := out.String()
	if strings.Contains(line, "hidden") {
		t.Fatalf("debug record below the level was written: %q", line)
	}
	want := ` WARN  gateway listening svc=api g.addr=:8080 g.note="two words" g.n=3` + "\n"
	if !strings.HasSuffix(line, want) || len(line) != len("15:04:05.000")+len(want) {
		t.Fatalf("line = %q, want time followed by %q", line, want)
	}
}

type transport struct {
	mu     sync.Mutex
	events []*sentry.Event
}

func (t *transport) Configure(sentry.ClientOptions) {}
func (t *transport) SendEvent(e *sentry.Event) {
	t.mu.Lock()
	t.events = append(t.events, e)
	t.mu.Unlock()
}
func (t *transport) Flush(time.Duration) bool              { return true }
func (t *transport) FlushWithContext(context.Context) bool { return true }
func (t *transport) Close()                                {}

func TestErrorsAreIssuesGroupedByMessage(t *testing.T) {
	sent := &transport{}
	client, err := sentry.NewClient(sentry.ClientOptions{Dsn: "http://k@localhost/1", Transport: sent})
	if err != nil {
		t.Fatal(err)
	}
	hub := sentry.NewHub(client, sentry.NewScope())
	ctx := sentry.SetHubOnContext(context.Background(), hub)
	logger := slog.New(issueHandler{})

	logger.InfoContext(ctx, "not an issue")
	logger.With("bundle", "memory").ErrorContext(ctx, "A bundle's service failed", "error", errors.New("pod 7 crashed"), "n", 2)

	if len(sent.events) != 1 {
		t.Fatalf("sent %d events, want 1", len(sent.events))
	}
	e := sent.events[0]
	if e.Message != "A bundle's service failed" || e.Fingerprint[0] != e.Message {
		t.Fatalf("message %q, fingerprint %v", e.Message, e.Fingerprint)
	}
	if len(e.Exception) != 1 || e.Exception[0].Type != e.Message || e.Exception[0].Value != "pod 7 crashed" {
		t.Fatalf("exception %+v", e.Exception)
	}
	attrs := e.Contexts["attributes"]
	if attrs["bundle"] != "memory" || attrs["n"] != "2" {
		t.Fatalf("attributes %v", attrs)
	}
}
