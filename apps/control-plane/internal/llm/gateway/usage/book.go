// Package usage keeps model usage by who used it: hourly counts by
// principal (a chat agent's id, which memory extraction for it shares;
// "routine-<id>" for a routine's runs), account (connection) and model.
//
// CLIProxyAPI publishes a record for every upstream request to its usage
// plugins (sdk/cliproxy/usage), whatever its own usage-statistics setting;
// the record's API key is the principal the gateway authenticated
// (cpa.AgentHeader). The book is a JSON file in the gateway's state
// directory, written every minute and on shutdown, and keeps Retention.
package usage

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	sdkusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

// Retention is how long hourly counts are kept.
const Retention = 30 * 24 * time.Hour

// Windows are the spans a report sums: an account's 5-hour window, a day,
// a week.
var Windows = []struct {
	Name string
	Span time.Duration
}{{"5h", 5 * time.Hour}, {"24h", 24 * time.Hour}, {"7d", 7 * 24 * time.Hour}}

// Counts are requests and tokens.
type Counts struct {
	Requests        int64 `json:"requests"`
	Failed          int64 `json:"failed"`
	InputTokens     int64 `json:"input_tokens"`
	OutputTokens    int64 `json:"output_tokens"`
	CachedTokens    int64 `json:"cached_tokens"`
	ReasoningTokens int64 `json:"reasoning_tokens"`
	TotalTokens     int64 `json:"total_tokens"`
}

func (c *Counts) add(o Counts) {
	c.Requests += o.Requests
	c.Failed += o.Failed
	c.InputTokens += o.InputTokens
	c.OutputTokens += o.OutputTokens
	c.CachedTokens += o.CachedTokens
	c.ReasoningTokens += o.ReasoningTokens
	c.TotalTokens += o.TotalTokens
}

type key struct {
	Hour      time.Time `json:"hour"`
	Principal string    `json:"principal"`
	Account   string    `json:"account"`
	Model     string    `json:"model"`
}

type entry struct {
	key
	Counts
}

// Book is the counts, kept in the file at path.
type Book struct {
	path    string
	mu      sync.Mutex
	buckets map[key]*Counts
	dirty   bool
}

// Open reads the book at path; a missing file is an empty book.
func Open(path string) (*Book, error) {
	b := &Book{path: path, buckets: map[key]*Counts{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return b, nil
	}
	if err != nil {
		return nil, err
	}
	var entries []entry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, err
	}
	for _, e := range entries {
		c := e.Counts
		b.buckets[e.key] = &c
	}
	return b, nil
}

// HandleUsage counts one upstream request (CLIProxyAPI's usage plugin).
func (b *Book) HandleUsage(_ context.Context, r sdkusage.Record) {
	principal := strings.TrimSpace(r.APIKey)
	if principal == "" {
		return
	}
	at := r.RequestedAt
	if at.IsZero() {
		at = time.Now()
	}
	// The model the caller asked for, as the catalog names it.
	model := r.Alias
	if model == "" {
		model = r.Model
	}
	k := key{Hour: at.UTC().Truncate(time.Hour), Principal: principal, Account: r.AuthID, Model: model}
	d := r.Detail
	c := Counts{
		Requests: 1, InputTokens: d.InputTokens, OutputTokens: d.OutputTokens,
		CachedTokens: d.CachedTokens + d.CacheReadTokens, ReasoningTokens: d.ReasoningTokens, TotalTokens: d.TotalTokens,
	}
	if c.TotalTokens == 0 {
		c.TotalTokens = c.InputTokens + c.OutputTokens
	}
	if r.Failed {
		c.Failed = 1
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.buckets[k] == nil {
		b.buckets[k] = &Counts{}
	}
	b.buckets[k].add(c)
	b.dirty = true
}

// Flush drops counts past Retention and writes the book if it changed.
func (b *Book) Flush(now time.Time) error {
	b.mu.Lock()
	cutoff := now.Add(-Retention)
	for k := range b.buckets {
		if k.Hour.Before(cutoff) {
			delete(b.buckets, k)
			b.dirty = true
		}
	}
	if !b.dirty {
		b.mu.Unlock()
		return nil
	}
	entries := make([]entry, 0, len(b.buckets))
	for k, c := range b.buckets {
		entries = append(entries, entry{k, *c})
	}
	b.dirty = false
	b.mu.Unlock()
	sort.Slice(entries, func(i, j int) bool { return entries[i].Hour.Before(entries[j].Hour) })
	data, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	tmp := b.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, b.path)
}

// Run writes the book every minute until ctx ends, then once more.
func (b *Book) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			if err := b.Flush(time.Now()); err != nil {
				slog.Error("Cannot write the usage book", "error", err)
			}
			return
		case <-ticker.C:
			if err := b.Flush(time.Now()); err != nil {
				slog.Warn("Cannot write the usage book", "error", err)
			}
		}
	}
}

// Usage is one principal's: its totals per window, and the last week by
// model and by account.
type Usage struct {
	Principal string            `json:"principal"`
	Windows   map[string]Counts `json:"windows"`
	Models    []Part            `json:"models"`
	Accounts  []Part            `json:"accounts"`
}

// Part is a share of a principal's last week.
type Part struct {
	Name string `json:"name"`
	Counts
}

// Report is every principal's usage over the windows ending now, busiest
// first. Hours count whole: the current hour, and the ones before it.
func (b *Book) Report(now time.Time) []Usage {
	current := now.UTC().Truncate(time.Hour)
	week := Windows[len(Windows)-1].Span
	type parts struct{ models, accounts map[string]*Counts }
	byPrincipal := map[string]*Usage{}
	breakdown := map[string]parts{}
	b.mu.Lock()
	for k, c := range b.buckets {
		age := current.Sub(k.Hour)
		if age < 0 || age >= week {
			continue
		}
		u := byPrincipal[k.Principal]
		if u == nil {
			u = &Usage{Principal: k.Principal, Windows: map[string]Counts{}}
			for _, w := range Windows {
				u.Windows[w.Name] = Counts{}
			}
			byPrincipal[k.Principal] = u
			breakdown[k.Principal] = parts{map[string]*Counts{}, map[string]*Counts{}}
		}
		for _, w := range Windows {
			if age < w.Span {
				sum := u.Windows[w.Name]
				sum.add(*c)
				u.Windows[w.Name] = sum
			}
		}
		p := breakdown[k.Principal]
		for name, into := range map[string]map[string]*Counts{k.Model: p.models, k.Account: p.accounts} {
			if into[name] == nil {
				into[name] = &Counts{}
			}
			into[name].add(*c)
		}
	}
	b.mu.Unlock()
	out := make([]Usage, 0, len(byPrincipal))
	for principal, u := range byPrincipal {
		u.Models, u.Accounts = sorted(breakdown[principal].models), sorted(breakdown[principal].accounts)
		out = append(out, *u)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i].Windows["7d"].TotalTokens, out[j].Windows["7d"].TotalTokens
		return a > b || (a == b && out[i].Principal < out[j].Principal)
	})
	return out
}

func sorted(m map[string]*Counts) []Part {
	out := make([]Part, 0, len(m))
	for name, c := range m {
		out = append(out, Part{name, *c})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].TotalTokens > out[j].TotalTokens || (out[i].TotalTokens == out[j].TotalTokens && out[i].Name < out[j].Name)
	})
	return out
}
