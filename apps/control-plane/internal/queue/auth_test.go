package queue

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/jwt/v2"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/nats-io/nkeys"
)

// keys is runtime keys and their agents, as the internal API knows them.
func keys(known map[string]string) Authenticate {
	return func(_ context.Context, key string) (string, error) {
		if agent, ok := known[key]; ok {
			return agent, nil
		}
		return "", errors.New("unknown key")
	}
}

// request is the server's auth callout request for a client with token.
func request(t *testing.T, token string) (string, []byte) {
	t.Helper()
	server, _ := nkeys.CreateServer()
	serverKey, _ := server.PublicKey()
	user, _ := nkeys.CreateUser()
	userKey, _ := user.PublicKey()
	req := jwt.NewAuthorizationRequestClaims(serverKey)
	req.UserNkey = userKey
	req.Server = jwt.ServerID{ID: "server-1", Name: "axp-nats"}
	req.ConnectOptions.Token = token
	encoded, err := req.Encode(server)
	if err != nil {
		t.Fatal(err)
	}
	return userKey, []byte(encoded)
}

func TestAuthorizeLimitsARuntimeToItsAgent(t *testing.T) {
	issuer, _ := nkeys.CreateAccount()
	userKey, req := request(t, "instance.token")
	answer, err := authorize(context.Background(), issuer, req, keys(map[string]string{"instance.token": "a1"}))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := jwt.DecodeAuthorizationResponseClaims(string(answer))
	if err != nil || resp.Error != "" || resp.Audience != "server-1" || resp.Subject != userKey {
		t.Fatalf("%+v %v", resp, err)
	}
	user, err := jwt.DecodeUserClaims(resp.Jwt)
	if err != nil {
		t.Fatal(err)
	}
	if user.Audience != Account || user.Name != "agent-a1" || user.Subject != userKey {
		t.Fatalf("%+v", user)
	}
	pub, sub := user.Pub.Allow, user.Sub.Allow
	for _, want := range []string{"$JS.API.CONSUMER.MSG.NEXT.AGENTS.agent-a1", "$JS.ACK.AGENTS.agent-a1.>"} {
		if !slices.Contains(pub, want) {
			t.Errorf("may not publish %s: %v", want, pub)
		}
	}
	if !slices.Equal(sub, jwt.StringList{"axp.agent.a1.control", "_INBOX_a1.>"}) {
		t.Errorf("subscribes to %v", sub)
	}
	for _, s := range append(pub, sub...) {
		if strings.Contains(s, "*") || s == ">" {
			t.Errorf("a wildcard beyond its own subjects: %s", s)
		}
	}
	if user.Resp == nil || user.Resp.MaxMsgs != 1 {
		t.Errorf("cannot answer control requests: %+v", user.Resp)
	}
}

func TestAuthorizeRefusesAnUnknownKey(t *testing.T) {
	issuer, _ := nkeys.CreateAccount()
	_, req := request(t, "stolen")
	answer, err := authorize(context.Background(), issuer, req, keys(nil))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := jwt.DecodeAuthorizationResponseClaims(string(answer))
	if err != nil || resp.Error == "" || resp.Jwt != "" {
		t.Fatalf("%+v %v", resp, err)
	}
}

// Against a NATS server running deploy/nats.conf:
//
//	docker run --rm -p 127.0.0.1:14298:4222 -v $PWD/deploy/nats.conf:/etc/nats/nats.conf:ro \
//	  -e AXP_NATS_PASSWORD=pw -e AXP_NATS_CALLOUT_ISSUER=<issuer> nats:2.14-alpine -c /etc/nats/nats.conf
//	AXP_TEST_NATS_AUTH_URL=nats://127.0.0.1:14298 AXP_TEST_NATS_PASSWORD=pw \
//	  AXP_TEST_NATS_CALLOUT_SEED=<seed> go test ./internal/queue/
func TestARuntimeReachesOnlyItsOwnAgent(t *testing.T) {
	url := os.Getenv("AXP_TEST_NATS_AUTH_URL")
	if url == "" {
		t.Skip("AXP_TEST_NATS_AUTH_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	services, err := Connect(url, os.Getenv("AXP_TEST_NATS_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	defer services.Close()
	if err := services.EnsureStreams(ctx); err != nil {
		t.Fatal(err)
	}
	a, b := uuid.NewString(), uuid.NewString()
	go services.ServeAuth(ctx, os.Getenv("AXP_TEST_NATS_CALLOUT_SEED"), keys(map[string]string{"key-a": a})) //nolint:errcheck
	time.Sleep(200 * time.Millisecond)
	for _, agent := range []string{a, b} {
		if err := services.OpenConsumer(ctx, agent); err != nil {
			t.Fatal(err)
		}
		if _, err := services.Enqueue(ctx, agent, map[string]any{"command_id": agent}); err != nil {
			t.Fatal(err)
		}
	}

	// A key nobody holds does not connect.
	if nc, err := nats.Connect(url, nats.Token("stolen")); err == nil {
		nc.Close()
		t.Fatal("connected with a key nobody holds")
	}

	var mu sync.Mutex
	var violations []string
	runtime, err := nats.Connect(url, nats.Token("key-a"), nats.CustomInboxPrefix(InboxPrefix(a)),
		nats.ErrorHandler(func(_ *nats.Conn, _ *nats.Subscription, err error) {
			mu.Lock()
			defer mu.Unlock()
			violations = append(violations, err.Error())
		}))
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()

	// Its own queue: take and ack.
	js, _ := jetstream.New(runtime)
	own, err := js.Consumer(ctx, Stream, ConsumerName(a))
	if err != nil {
		t.Fatal(err)
	}
	batch, err := own.Fetch(1, jetstream.FetchMaxWait(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	var taken int
	for msg := range batch.Messages() {
		taken++
		if err := msg.Ack(); err != nil {
			t.Fatal(err)
		}
	}
	if taken != 1 {
		t.Fatalf("took %d from its own queue", taken)
	}
	// Another agent's queue: nothing (the request is dropped, so it times
	// out).
	denied, stop := context.WithTimeout(ctx, 2*time.Second)
	defer stop()
	if _, err := js.Consumer(denied, Stream, ConsumerName(b)); err == nil {
		t.Fatal("read another agent's consumer")
	}
	if waiting, err := services.AgentsWithCommands(ctx); err != nil || !waiting[b] {
		t.Fatalf("another agent's command was touched: %v %v", waiting, err)
	}

	// Its control subject: it hears requests and answers them.
	if _, err := runtime.Subscribe(ControlSubject(a), func(m *nats.Msg) { _ = m.Respond([]byte(`{"accepted":true}`)) }); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Flush(); err != nil {
		t.Fatal(err)
	}
	if answer, err := services.Ask(ctx, a, map[string]any{"type": "steer"}); err != nil || answer["accepted"] != true {
		t.Fatalf("its own control: %v %v", answer, err)
	}
	// Another agent's: neither heard nor told.
	_, _ = runtime.Subscribe(ControlSubject(b), func(*nats.Msg) {})
	_ = runtime.Publish(ControlSubject(b), []byte(`{"type":"interrupt"}`))
	_ = runtime.Publish("axp.routine.r1.fire", []byte(`{}`))
	_ = runtime.Flush()
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(violations) < 3 {
		t.Fatalf("expected permission violations, got %q", violations)
	}
	for _, v := range violations {
		if !strings.Contains(strings.ToLower(v), "permissions violation") {
			t.Fatalf("unexpected error %q", v)
		}
	}
}
