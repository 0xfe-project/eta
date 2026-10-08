package connectors

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func stubHTTP(t *testing.T, bodies map[string]string) *http.Client {
	return &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("%s: missing bearer token", r.URL)
		}
		body, ok := bodies[r.URL.String()]
		status := http.StatusOK
		if !ok {
			status = http.StatusNotFound
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
	})}
}

func TestCodexUsage(t *testing.T) {
	c := &Codex{HTTP: stubHTTP(t, map[string]string{codexUsageURL: `{
		"plan_type": "prolite",
		"rate_limit": {
			"primary_window": {"used_percent": 42, "limit_window_seconds": 18000, "reset_at": 1791948720},
			"secondary_window": {"used_percent": 120, "limit_window_seconds": 604800, "reset_at": 1792000000}
		}
	}`})}
	u, err := c.Usage(context.Background(), map[string]any{"access_token": "tok", "account_id": "acct"})
	if err != nil {
		t.Fatal(err)
	}
	if u.Plan != "Pro 5x" || len(u.Windows) != 2 {
		t.Fatalf("usage = %+v", u)
	}
	if w := u.Windows[0]; w.Kind != "5h" || w.Used != 42 || !w.ResetsAt.Equal(time.Unix(1791948720, 0)) {
		t.Errorf("primary = %+v", w)
	}
	if w := u.Windows[1]; w.Kind != "weekly" || w.Used != 100 {
		t.Errorf("secondary = %+v", w)
	}

	if _, err := c.Usage(context.Background(), map[string]any{}); err == nil {
		t.Error("expected an error without a token")
	}
}

func TestXAIUsage(t *testing.T) {
	x := &XAI{HTTP: stubHTTP(t, map[string]string{
		grokBillingURL: `{"config": {"currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY",
			"start": "2026-10-06T03:19:45Z", "end": "2026-10-13T03:19:45Z"}, "creditUsagePercent": "2.5"}}`,
		grokSettingsURL: `{"subscription_tier_display": "SuperGrok Heavy"}`,
	})}
	u, err := x.Usage(context.Background(), map[string]any{"access_token": "tok"})
	if err != nil {
		t.Fatal(err)
	}
	if u.Plan != "SuperGrok Heavy" || len(u.Windows) != 1 {
		t.Fatalf("usage = %+v", u)
	}
	if w := u.Windows[0]; w.Kind != "weekly" || w.Used != 2.5 || w.DurationSeconds != 7*24*3600 {
		t.Errorf("window = %+v", w)
	}

	// No billing period (and zero usage, which proto-JSON omits): no windows.
	x.HTTP = stubHTTP(t, map[string]string{grokBillingURL: `{"config": {}}`})
	if u, err := x.Usage(context.Background(), map[string]any{"access_token": "tok"}); err != nil || len(u.Windows) != 0 {
		t.Errorf("usage = %+v, %v", u, err)
	}
}
