package usage

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	sdkusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

func record(principal, account, model string, at time.Time, in, out int64) sdkusage.Record {
	return sdkusage.Record{APIKey: principal, AuthID: account, Alias: model, RequestedAt: at,
		Detail: sdkusage.Detail{InputTokens: in, OutputTokens: out}}
}

func TestTheBookSumsWindowsByPrincipal(t *testing.T) {
	now := time.Date(2026, 10, 9, 12, 30, 0, 0, time.UTC)
	book, err := Open(filepath.Join(t.TempDir(), "usage.json"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	book.HandleUsage(ctx, record("agent-1", "acct-a", "gpt-5.5", now.Add(-time.Hour), 100, 10))       // 5h, 24h, 7d
	book.HandleUsage(ctx, record("agent-1", "acct-b", "gpt-5.5", now.Add(-6*time.Hour), 50, 5))       // 24h, 7d
	book.HandleUsage(ctx, record("agent-1", "acct-a", "grok-4", now.Add(-48*time.Hour), 1000, 0))     // 7d
	book.HandleUsage(ctx, record("routine-r1", "acct-a", "gpt-5.5", now.Add(-10*24*time.Hour), 7, 7)) // older than the week
	book.HandleUsage(ctx, record("", "acct-a", "gpt-5.5", now, 9, 9))                                 // nobody's: not counted
	failed := record("routine-r1", "acct-a", "gpt-5.5", now, 3, 0)
	failed.Failed = true
	book.HandleUsage(ctx, failed)

	report := book.Report(now)
	if len(report) != 2 || report[0].Principal != "agent-1" || report[1].Principal != "routine-r1" {
		t.Fatalf("%+v", report)
	}
	agent := report[0]
	for window, want := range map[string]int64{"5h": 110, "24h": 165, "7d": 1165} {
		if got := agent.Windows[window].TotalTokens; got != want {
			t.Errorf("%s: %d, want %d", window, got, want)
		}
	}
	if agent.Windows["7d"].Requests != 3 || agent.Models[0].Name != "grok-4" || agent.Accounts[0].Name != "acct-a" {
		t.Fatalf("%+v", agent)
	}
	if r := report[1].Windows["7d"]; r.Requests != 1 || r.Failed != 1 || r.TotalTokens != 3 {
		t.Fatalf("routine %+v", r)
	}

	// Written and read back; past Retention it is dropped.
	if err := book.Flush(now); err != nil {
		t.Fatal(err)
	}
	again, err := Open(book.path)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.Report(now)[0].Windows["7d"].TotalTokens; got != 1165 {
		t.Fatalf("read back %d", got)
	}
	if err := again.Flush(now.Add(Retention - time.Hour)); err != nil {
		t.Fatal(err)
	}
	if n := len(again.buckets); n != 1 {
		t.Fatalf("%d buckets kept past retention", n)
	}
}
