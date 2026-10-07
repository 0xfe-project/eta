// Package main is AXP's edge gateway: the single same-origin entry for the
// browser. It routes by path prefix to the web app, the control plane and the
// LLM gateway, and it is the only caller those services trust.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

// EdgeSecretHeader proves to an upstream that a request came through the
// gateway. Clients cannot set it: every inbound X-AXP-* header is dropped.
const EdgeSecretHeader = "X-AXP-Edge-Secret"

const requestIDHeader = "X-Request-Id"

// Route sends every path under Prefix to Upstream, unchanged.
type Route struct {
	Name     string
	Prefix   string
	Upstream *url.URL
}

type Config struct {
	Routes     []Route
	EdgeSecret string
	// MaxBodyBytes caps request bodies; zero disables the limit.
	MaxBodyBytes int64
	Logger       *slog.Logger
}

type route struct {
	Route
	proxy *httputil.ReverseProxy
}

type Gateway struct {
	routes  []route
	maxBody int64
	logger  *slog.Logger
}

func New(cfg Config) *Gateway {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	g := &Gateway{maxBody: cfg.MaxBodyBytes, logger: logger}
	for _, r := range cfg.Routes {
		g.routes = append(g.routes, route{Route: r, proxy: g.newProxy(r, cfg.EdgeSecret)})
	}
	// Longest prefix first, so /api/llm/ wins over /api/.
	sort.SliceStable(g.routes, func(i, j int) bool {
		return len(g.routes[i].Prefix) > len(g.routes[j].Prefix)
	})
	return g
}

func (g *Gateway) newProxy(r Route, secret string) *httputil.ReverseProxy {
	upstream := r.Upstream
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			for name := range pr.Out.Header {
				if strings.HasPrefix(http.CanonicalHeaderKey(name), "X-Axp-") {
					pr.Out.Header.Del(name)
				}
			}
			pr.SetURL(upstream)
			// Keep the browser's host so upstreams build same-origin URLs.
			pr.Out.Host = pr.In.Host
			pr.SetXForwarded()
			if secret != "" {
				pr.Out.Header.Set(EdgeSecretHeader, secret)
			}
		},
		// Stream every response as it arrives (SSE, chunked replies).
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, req *http.Request, err error) {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeError(w, req, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "请求内容过大。")
				return
			}
			g.logger.Warn("upstream error", "route", r.Name, "path", req.URL.Path, "error", err,
				"request_id", req.Header.Get(requestIDHeader))
			writeError(w, req, http.StatusBadGateway, "UPSTREAM_UNAVAILABLE", "服务暂时不可用，请稍后再试。")
		},
	}
}

func (g *Gateway) match(path string) *route {
	for i := range g.routes {
		prefix := g.routes[i].Prefix
		if strings.HasPrefix(path, prefix) || path+"/" == prefix {
			return &g.routes[i]
		}
	}
	return nil
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	id := r.Header.Get(requestIDHeader)
	if !validRequestID.MatchString(id) {
		id = newRequestID()
	}
	r.Header.Set(requestIDHeader, id)
	w.Header().Set(requestIDHeader, id)
	rec := &recorder{ResponseWriter: w, status: http.StatusOK}

	upstream := "gateway"
	switch rt := g.match(r.URL.Path); {
	case r.URL.Path == "/up":
		rec.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = rec.Write([]byte("ok"))
	case rt == nil:
		writeError(rec, r, http.StatusNotFound, "NOT_FOUND", "资源不存在。")
	case g.maxBody > 0 && r.ContentLength > g.maxBody:
		upstream = rt.Name
		writeError(rec, r, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "请求内容过大。")
	default:
		upstream = rt.Name
		if g.maxBody > 0 && r.Body != nil {
			r.Body = http.MaxBytesReader(rec, r.Body, g.maxBody)
		}
		rt.proxy.ServeHTTP(rec, r)
	}

	if !rec.wroteHeader && r.Header.Get("Upgrade") != "" {
		// A hijacked connection never reports its status here.
		rec.status = http.StatusSwitchingProtocols
	}
	// Page and asset loads are not worth a record each (in development every
	// Vite module is one; OpenObserve's UI polls its API); API calls and
	// failures are.
	if (upstream == "web" || upstream == "observe") && rec.status < http.StatusBadRequest {
		return
	}
	g.logger.Info("request",
		"method", r.Method,
		"path", r.URL.Path,
		"upstream", upstream,
		"status", rec.status,
		"bytes", rec.bytes,
		"duration_ms", time.Since(start).Milliseconds(),
		"request_id", id,
	)
}

var validRequestID = regexp.MustCompile(`^[A-Za-z0-9._-]{8,128}$`)

func newRequestID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// writeError uses the control plane's error envelope.
func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{
			"code":       code,
			"message":    message,
			"request_id": r.Header.Get(requestIDHeader),
		},
	})
}

// recorder captures the status for access logs. Unwrap keeps flushing and
// hijacking (WebSocket upgrades) working through http.ResponseController.
type recorder struct {
	http.ResponseWriter
	status      int
	bytes       int64
	wroteHeader bool
}

func (r *recorder) WriteHeader(status int) {
	if !r.wroteHeader {
		r.status = status
		r.wroteHeader = true
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *recorder) Write(b []byte) (int, error) {
	r.wroteHeader = true
	n, err := r.ResponseWriter.Write(b)
	r.bytes += int64(n)
	return n, err
}

func (r *recorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }
