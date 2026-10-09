package routines

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestKeyProxyForwardsRunningRunsAsTheirRoutine(t *testing.T) {
	var agents []string
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		agents = append(agents, r.Header.Get(AgentHeader)+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
	}))
	defer gateway.Close()
	proxy, err := NewKeyProxy(gateway.URL)
	if err != nil {
		t.Fatal(err)
	}
	key, revoke := proxy.Issue("r1")
	get := func(path, key string) int {
		req, _ := http.NewRequest(http.MethodGet, proxy.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+key)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if s := get("/v1/models", key); s != 200 {
		t.Fatalf("status %d", s)
	}
	if strings.Join(agents, ",") != "routine-r1 /v1/models " {
		t.Fatalf("gateway saw %q", agents)
	}
	for _, c := range []struct{ path, key string }{{"/v1/models", "other"}, {"/api/llm/v1/connections", key}} {
		if s := get(c.path, c.key); s != 403 {
			t.Fatalf("%s with %s: %d", c.path, c.key, s)
		}
	}
	revoke()
	if s := get("/v1/models", key); s != 403 {
		t.Fatalf("revoked key: %d", s)
	}
}

func TestDescribeAndNextRun(t *testing.T) {
	weekly := Schedule{Kind: "weekly", Days: []int{5, 1, 1}, Time: "07:30"}
	if Describe(weekly) != "每周一、五 07:30" || weekly.Cron5() != "30 7 * * 1,5" {
		t.Fatalf("%q %q", Describe(weekly), weekly.Cron5())
	}
	after := time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC) // Friday 08:00 in Shanghai; next is Monday 07:30
	next, err := NextRun(weekly, "Asia/Shanghai", after)
	if err != nil || next.UTC().Format(time.RFC3339) != "2026-10-11T23:30:00Z" {
		t.Fatalf("%v %v", next, err)
	}
}

// With AXP_TEST_NATS_URL, against a NATS server of the test's own (no other
// routine service may consume its fires).
func TestNATSSchedulesAndFires(t *testing.T) {
	url := os.Getenv("AXP_TEST_NATS_URL")
	if url == "" {
		t.Skip("AXP_TEST_NATS_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
	defer cancel()
	n, err := ConnectNATS(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer n.Close()
	fired := make(chan [2]any, 4)
	go n.Consume(ctx, func(_ context.Context, id string, now bool) error { //nolint:errcheck
		fired <- [2]any{id, now}
		return nil
	})
	asked, scheduled := uuid.NewString(), uuid.NewString()
	if err := n.Fire(ctx, asked); err != nil {
		t.Fatal(err)
	}
	if got := <-fired; got != [2]any{asked, true} {
		t.Fatalf("fired %v", got)
	}
	// Every minute, from NATS itself.
	if err := n.Schedule(ctx, scheduled, "* * * * *", "Asia/Shanghai"); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-fired:
		if got != [2]any{scheduled, false} {
			t.Fatalf("fired %v", got)
		}
	case <-ctx.Done():
		t.Fatal("the schedule never fired")
	}
	if err := n.Unschedule(ctx, scheduled); err != nil {
		t.Fatal(err)
	}
	info, err := n.stream.Info(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if info.State.Msgs != 0 {
		t.Fatalf("%d messages left", info.State.Msgs)
	}
}
