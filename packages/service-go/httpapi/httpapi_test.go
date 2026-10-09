package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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

// serve runs Serve with a handler that blocks each request until release
// closes; entered receives once a request is in the handler.
func serve(t *testing.T, drain time.Duration) (addr string, entered, release chan struct{}, cancel context.CancelFunc, served chan error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr = ln.Addr().String()
	_ = ln.Close()
	entered, release, served = make(chan struct{}, 1), make(chan struct{}), make(chan error, 1)
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		entered <- struct{}{}
		<-release
		_, _ = io.WriteString(w, "done")
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { served <- Serve(ctx, addr, handler, drain) }()
	waitListening(t, addr, true)
	return
}

// waitListening waits until addr accepts connections, or refuses them.
func waitListening(t *testing.T, addr string, want bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		conn, err := net.Dial("tcp", addr)
		if err == nil {
			_ = conn.Close()
		}
		if (err == nil) == want {
			return
		}
	}
	t.Fatalf("listening at %s never became %v", addr, want)
}

func get(addr string) (string, error) {
	res, err := http.Get("http://" + addr + "/")
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	return string(body), err
}

func returned(t *testing.T, served chan error) error {
	t.Helper()
	select {
	case err := <-served:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return")
		return nil
	}
}

func TestServeDrainsRequestsBeforeReturning(t *testing.T) {
	addr, entered, release, cancel, served := serve(t, 10*time.Second)
	answered := make(chan string, 1)
	go func() { body, err := get(addr); answered <- fmt.Sprint(body, err) }()
	<-entered
	cancel()
	waitListening(t, addr, false) // Shutdown has started
	select {
	case err := <-served:
		t.Fatalf("Serve returned (%v) with a request in flight", err)
	default:
	}
	close(release)
	if got := <-answered; got != "done<nil>" {
		t.Fatalf("response = %q; want the full body", got)
	}
	if err := returned(t, served); err != nil {
		t.Fatal(err)
	}
}

func TestServeGivesUpAfterTheDrain(t *testing.T) {
	addr, entered, release, cancel, served := serve(t, 50*time.Millisecond)
	defer close(release)
	go func() { _, _ = get(addr) }()
	<-entered
	cancel()
	if err := returned(t, served); err != nil {
		t.Fatal(err)
	}
}

func TestServeReturnsWhenItCannotListen(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	served := make(chan error, 1)
	// ctx never ends: Serve must not wait for a shutdown that never starts.
	go func() { served <- Serve(context.Background(), ln.Addr().String(), http.NotFoundHandler(), time.Second) }()
	if err := returned(t, served); err == nil {
		t.Fatal("Serve = nil; want the listen error")
	}
}
