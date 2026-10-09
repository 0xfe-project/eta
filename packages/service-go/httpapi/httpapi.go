// Package httpapi is a service's HTTP API: huma operations on a chi router,
// with an OpenAPI document generated from the code (the web client's types
// come from it).
//
// Every error, whatever produced it (an operation, huma's validation, the
// router), is the same envelope:
//
//	{"error": {"code": "NOT_FOUND", "message": "资源不存在。", "request_id": "..."}}
//
// An *apierr.Error anywhere in an operation's error chain sets the status,
// code and message; any other error is logged and answered as 500. Each
// request carries the gateway's X-Request-Id (or a new one), so gateway and
// service logs line up.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"golang.org/x/sync/errgroup"
)

func init() {
	// Lists are never null.
	huma.DefaultArrayNullable = false
	huma.NewError = func(status int, message string, errs ...error) huma.StatusError {
		return newError(context.Background(), status, message, errs...)
	}
	huma.NewErrorWithContext = func(ctx huma.Context, status int, message string, errs ...error) huma.StatusError {
		return newError(ctx.Context(), status, message, errs...)
	}
}

// Config describes an API.
type Config struct {
	Title   string
	Version string
	// Prefix every path of the API starts with: its OpenAPI document is at
	// <prefix>/openapi.json and its docs, when served, at <prefix>/docs.
	Prefix string
	// Docs serves the documentation page.
	Docs bool
}

// API is an API's router, for routes outside huma, and its huma API, for
// operations.
type API struct {
	huma.API
	Router chi.Router
}

// New is an API with no operations yet.
func New(c Config) *API {
	r := chi.NewRouter()
	r.Use(requests, middleware.Recoverer)
	r.NotFound(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, newError(r.Context(), 404, "")) })
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, newError(r.Context(), 405, "")) })
	return &API{API: humachi.New(r, humaConfig(c)), Router: r}
}

// Sub is another API on the same router, with its own prefix and OpenAPI
// document (e.g. one for other clients next to the browser's).
func (a *API) Sub(c Config) huma.API {
	return humachi.New(a.Router, humaConfig(c))
}

func humaConfig(c Config) huma.Config {
	config := huma.DefaultConfig(c.Title, c.Version)
	// No $schema links in bodies: responses are exactly their schemas.
	config.CreateHooks = nil
	config.OpenAPIPath = c.Prefix + "/openapi"
	config.SchemasPath = c.Prefix + "/schemas"
	config.DocsPath = ""
	if c.Docs {
		config.DocsPath = c.Prefix + "/docs"
	}
	return config
}

// Body is an operation's input or output with just a body.
type Body[T any] struct {
	Body T
}

// Op is an operation: its id (the generated client's method name), method,
// path, summary, success status and the error statuses it documents.
func Op(id, method, path, summary string, status int, errors []int, tags ...string) huma.Operation {
	return huma.Operation{
		OperationID: id, Method: method, Path: path, Summary: summary,
		DefaultStatus: status, Errors: errors, Tags: tags,
	}
}

type Health struct {
	Status  string `json:"status"`
	Service string `json:"service"`
}

// AddHealth answers GET path with the service's name, for health checks.
func AddHealth(api huma.API, path, service string) {
	huma.Get(api, path, func(context.Context, *struct{}) (*Body[Health], error) {
		return &Body[Health]{Health{Status: "ok", Service: service}}, nil
	}, func(o *huma.Operation) { o.OperationID = "health"; o.Tags = []string{"health"} })
}

// --- requests ------------------------------------------------------------------------

type requestKey struct{}

type request struct {
	id string
	r  *http.Request
}

// requests gives each request its id and keeps the request for operations.
func requests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = strings.ReplaceAll(uuid.NewString(), "-", "")
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestKey{}, request{id, r})))
	})
}

// RequestID is the request's id.
func RequestID(ctx context.Context) string {
	req, _ := ctx.Value(requestKey{}).(request)
	return req.id
}

// Request is the HTTP request an operation answers, for what huma's inputs
// do not give (such as the address it came to); nil outside a request.
func Request(ctx context.Context) *http.Request {
	req, _ := ctx.Value(requestKey{}).(request)
	return req.r
}

// --- errors ----------------------------------------------------------------------------

type ErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
}

// Error is every error response, plus the top-level fields some protocol
// errors carry (apierr.Error.Extra).
type Error struct {
	status int
	Detail ErrorBody `json:"error"`
	extra  map[string]any
}

func (e *Error) Error() string  { return e.Detail.Code + ": " + e.Detail.Message }
func (e *Error) GetStatus() int { return e.status }

func (e *Error) MarshalJSON() ([]byte, error) {
	body := map[string]any{"error": e.Detail}
	for k, v := range e.extra {
		body[k] = v
	}
	return json.Marshal(body)
}

var statusErrors = map[int][2]string{
	400: {"BAD_REQUEST", "请求格式无效。"},
	403: {"FORBIDDEN", "请求被拒绝。"},
	404: {"NOT_FOUND", "资源不存在。"},
	405: {"METHOD_NOT_ALLOWED", "不支持该请求方法。"},
	422: {"VALIDATION_ERROR", "请求参数无效。"},
	429: {"TOO_MANY_REQUESTS", "请求过于频繁，请稍后再试。"},
}

func newError(ctx context.Context, status int, message string, errs ...error) *Error {
	e := &Error{status: status, Detail: ErrorBody{RequestID: RequestID(ctx)}}
	for _, err := range errs {
		var product *apierr.Error
		if errors.As(err, &product) {
			e.status, e.Detail.Code, e.Detail.Message, e.extra = product.Status, product.Code, product.Message, product.Extra
			return e
		}
	}
	if known, ok := statusErrors[status]; ok {
		e.Detail.Code, e.Detail.Message = known[0], known[1]
		return e
	}
	if status < 500 {
		e.Detail.Code, e.Detail.Message = "BAD_REQUEST", "请求无效。"
		return e
	}
	slog.ErrorContext(ctx, "Unhandled API error", "request_id", e.Detail.RequestID, "message", message, "error", errors.Join(errs...))
	e.status, e.Detail.Code, e.Detail.Message = 500, "INTERNAL_ERROR", "服务暂时不可用。"
	return e
}

// WriteError answers a request outside huma (a plain chi route) with the
// envelope; an *apierr.Error in err sets the status.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	writeJSON(w, newError(r.Context(), 500, "", err))
}

func writeJSON(w http.ResponseWriter, e *Error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.status)
	_ = json.NewEncoder(w).Encode(e)
}

// --- serving ---------------------------------------------------------------------------

// Serve serves handler at addr until ctx ends, then waits up to drain for
// requests in flight before closing the rest. It returns only after that, so
// what the caller closes next (the database, NATS) outlives the requests.
func Serve(ctx context.Context, addr string, handler http.Handler, drain time.Duration) error {
	server := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	// A failure to listen ends ctx too, so the shutdown never waits on it.
	g, ctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		slog.Info("Listening", "addr", addr)
		if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	})
	g.Go(func() error {
		<-ctx.Done()
		// ctx has ended, so the drain gets a context of its own.
		shutdown, cancel := context.WithTimeout(context.Background(), drain)
		defer cancel()
		if server.Shutdown(shutdown) != nil {
			_ = server.Close()
		}
		return nil
	})
	return g.Wait()
}
