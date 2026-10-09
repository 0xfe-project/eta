package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/danielgtaylor/huma/v2"
)

type thing struct {
	Name string `json:"name" minLength:"1"`
}

func testAPI() *API {
	api := New(Config{Title: "Test", Version: "1", Prefix: "/api/test"})
	AddHealth(api, "/api/test/health", "test")
	huma.Register(api, Op("getThing", http.MethodGet, "/api/test/things/{id}", "A thing", 200, []int{404}),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*Body[thing], error) {
			switch in.ID {
			case "gone":
				return nil, apierr.NotFound()
			case "broken":
				return nil, errors.New("database down")
			case "upstream":
				return nil, apierr.Upstream("REMOTE_UNAVAILABLE", "远程失败。")
			case "wrapped":
				return nil, errors.Join(errors.New("context"), apierr.New(409, "BUSY", "忙。"))
			}
			if RequestID(ctx) == "" || Request(ctx) == nil {
				return nil, errors.New("no request")
			}
			return &Body[thing]{thing{Name: in.ID}}, nil
		})
	huma.Register(api, Op("addThing", http.MethodPost, "/api/test/things", "Add one", 201, []int{422}),
		func(_ context.Context, in *Body[thing]) (*Body[thing], error) { return &Body[thing]{in.Body}, nil })
	return api
}

func do(t *testing.T, method, path, body string, header ...string) (int, map[string]any, http.Header) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	w := httptest.NewRecorder()
	testAPI().Router.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out, w.Header()
}

func code(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	return e["code"].(string) + " " + e["request_id"].(string)
}

func TestEveryErrorIsTheEnvelope(t *testing.T) {
	for _, c := range []struct {
		method, path, body string
		status             int
		code               string
	}{
		{"GET", "/api/test/things/gone", "", 404, "NOT_FOUND"},
		{"GET", "/api/test/things/broken", "", 500, "INTERNAL_ERROR"},
		{"GET", "/api/test/things/wrapped", "", 409, "BUSY"},
		{"POST", "/api/test/things", `{"name": ""}`, 422, "VALIDATION_ERROR"},
		{"POST", "/api/test/things", `{`, 400, "BAD_REQUEST"},
		{"GET", "/api/test/nowhere", "", 404, "NOT_FOUND"},
		{"DELETE", "/api/test/things", "", 405, "METHOD_NOT_ALLOWED"},
	} {
		status, out, _ := do(t, c.method, c.path, c.body, "X-Request-Id", "req-1")
		if status != c.status || code(out) != c.code+" req-1" {
			t.Errorf("%s %s: %d %v", c.method, c.path, status, out)
		}
	}
}

func TestRequestsAreAnsweredAndIdentified(t *testing.T) {
	status, out, header := do(t, "GET", "/api/test/things/x", "")
	if status != 200 || out["name"] != "x" || header.Get("X-Request-ID") == "" {
		t.Fatalf("%d %v %v", status, out, header)
	}
	if status, out, _ := do(t, "GET", "/api/test/health", ""); status != 200 || out["service"] != "test" {
		t.Fatalf("health %d %v", status, out)
	}
	if _, out, _ := do(t, "GET", "/api/test/things/x", ""); out["$schema"] != nil {
		t.Fatalf("a $schema link: %v", out)
	}
	if status, out, _ := do(t, "GET", "/api/test/openapi.json", ""); status != 200 || out["openapi"] == nil {
		t.Fatalf("openapi %d", status)
	}
}

func TestUpstreamFailuresAreLoggedAndCallerMistakesAreNot(t *testing.T) {
	var logs bytes.Buffer
	defer slog.SetDefault(slog.Default())
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))

	do(t, "GET", "/api/test/things/gone", "", "X-Request-Id", "req-404")
	do(t, "GET", "/api/test/things/upstream", "", "X-Request-Id", "req-424")
	line := logs.String()
	if strings.Contains(line, "req-404") {
		t.Errorf("a 404 was logged: %s", line)
	}
	for _, want := range []string{"request_id=req-424", "status=424", "code=REMOTE_UNAVAILABLE", "url.path=/api/test/things/upstream"} {
		if !strings.Contains(line, want) {
			t.Errorf("no %s in %s", want, line)
		}
	}
}
