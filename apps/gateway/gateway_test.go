package main

import (
	"bufio"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type seen struct {
	upstream string
	path     string
	host     string
	header   http.Header
}

func newUpstream(t *testing.T, name string, got chan<- seen) *url.URL {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- seen{name, r.URL.Path, r.Host, r.Header.Clone()}
		if r.URL.Path == "/api/v1/chat/stream" {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "event: ping\ndata: 1\n\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, name)
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	return u
}

func newGateway(t *testing.T, maxBody int64) (*httptest.Server, chan seen) {
	t.Helper()
	got := make(chan seen, 10)
	gw := New(Config{
		Routes: []Route{
			{Name: "web", Prefix: "/", Upstream: newUpstream(t, "web", got)},
			{Name: "api", Prefix: "/api/", Upstream: newUpstream(t, "api", got)},
			{Name: "llm", Prefix: "/api/llm/", Upstream: newUpstream(t, "llm", got)},
		},
		EdgeSecret:   "s3cret",
		MaxBodyBytes: maxBody,
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	srv := httptest.NewServer(gw)
	t.Cleanup(srv.Close)
	return srv, got
}

func TestRoutesByLongestPrefix(t *testing.T) {
	srv, got := newGateway(t, 0)
	cases := map[string]string{
		"/":                  "web",
		"/workspace":         "web",
		"/assets/app.js":     "web",
		"/api/v1/chat":       "api",
		"/api/health":        "api",
		"/api/llm/v1/models": "llm",
		"/api/llm":           "llm",
		"/api/llmx":          "api",
	}
	for path, want := range cases {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		s := <-got
		if s.upstream != want || s.path != path {
			t.Errorf("%s: routed to %s%s, want %s%s", path, s.upstream, s.path, want, path)
		}
	}
}

func TestHeaders(t *testing.T) {
	srv, got := newGateway(t, 0)
	req, _ := http.NewRequest("GET", srv.URL+"/api/v1/chat", nil)
	req.Host = "axp.example.com"
	req.Header.Set("X-AXP-Edge-Secret", "forged")
	req.Header.Set("X-Axp-Internal", "1")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	s := <-got
	if v := s.header.Get(EdgeSecretHeader); v != "s3cret" {
		t.Errorf("edge secret = %q", v)
	}
	if v := s.header.Get("X-Axp-Internal"); v != "" {
		t.Errorf("client X-AXP header leaked: %q", v)
	}
	if s.host != "axp.example.com" {
		t.Errorf("host = %q", s.host)
	}
	id := res.Header.Get("X-Request-Id")
	if id == "" || s.header.Get("X-Request-Id") != id {
		t.Errorf("request id not propagated: response %q upstream %q", id, s.header.Get("X-Request-Id"))
	}

	req, _ = http.NewRequest("GET", srv.URL+"/api/v1/chat", nil)
	req.Header.Set("X-Request-Id", "client-supplied-id")
	res, _ = http.DefaultClient.Do(req)
	res.Body.Close()
	if s := <-got; s.header.Get("X-Request-Id") != "client-supplied-id" {
		t.Errorf("valid client request id replaced: %q", s.header.Get("X-Request-Id"))
	}
}

func TestStreamsWithoutBuffering(t *testing.T) {
	srv, got := newGateway(t, 0)
	res, err := http.Get(srv.URL + "/api/v1/chat/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	<-got
	line := make(chan string, 1)
	go func() {
		l, _ := bufio.NewReader(res.Body).ReadString('\n')
		line <- l
	}()
	select {
	case l := <-line:
		if l != "event: ping\n" {
			t.Fatalf("first line = %q", l)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SSE event was buffered")
	}
}

func TestUpstreamDown(t *testing.T) {
	gw := New(Config{
		Routes: []Route{{Name: "api", Prefix: "/api/", Upstream: &url.URL{Scheme: "http", Host: "127.0.0.1:1"}}},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	rec := httptest.NewRecorder()
	gw.ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/chat", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d", rec.Code)
	}
	var body struct {
		Error struct{ Code, RequestID string } `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Error.Code != "UPSTREAM_UNAVAILABLE" {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestBodyLimit(t *testing.T) {
	srv, got := newGateway(t, 16)
	res, err := http.Post(srv.URL+"/api/v1/chat/messages", "text/plain", strings.NewReader(strings.Repeat("x", 64)))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d", res.StatusCode)
	}
	select {
	case s := <-got:
		t.Fatalf("oversized body reached %s", s.upstream)
	default:
	}
}

func TestUp(t *testing.T) {
	srv, _ := newGateway(t, 0)
	res, err := http.Get(srv.URL + "/up")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(b) != "ok" {
		t.Fatalf("/up = %q", b)
	}
}
