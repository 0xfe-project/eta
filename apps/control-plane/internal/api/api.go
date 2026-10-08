// Package api is the control plane's HTTP surface: the public API the
// browser calls under /api (through the gateway) and the internal API
// runtimes call under /internal (through the runtime gateway). Each is its
// own huma API with its own OpenAPI document, generated from the code; the
// web client's types are generated from the public one.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/apierr"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/control"
	"github.com/akarachen/axp/apps/control-plane/internal/routines"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
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

// Deps is what the handlers use.
type Deps struct {
	DB       *pgxpool.Pool
	Chat     *chat.Service
	Routines *routines.Service
	Protocol *control.Protocol
	Tasks    *tasks.Service
	// Where remote computers reach AXP; the browser's address when empty.
	PublicURL string
	// The forge service, for remote computers' GitHub credentials.
	ForgeURL string
	// What remote computers download from /remote/dl: the axp binaries and
	// the agenvo connectors.
	RemoteDist string
	// Dev serves the internal API's docs.
	Dev bool
}

// --- errors ----------------------------------------------------------------------

type ErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
}

// Error is every error response: {"error": {"code", "message", "request_id"}},
// plus top-level fields some internal protocol errors carry.
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

// --- request ids --------------------------------------------------------------------

type ctxKey int

const (
	requestIDKey ctxKey = iota
	requestKey
)

// RequestID is the request's id: the gateway's X-Request-Id, so gateway and
// service logs line up, or a new one.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

type requestInfo struct{ method, path string }

func requestIDs(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = strings.ReplaceAll(uuid.NewString(), "-", "")
		}
		w.Header().Set("X-Request-ID", id)
		ctx := context.WithValue(r.Context(), requestIDKey, id)
		ctx = context.WithValue(ctx, requestKey, requestInfo{r.Method, r.URL.Path})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// router is a chi router whose own errors use the error envelope.
func router() chi.Router {
	r := chi.NewRouter()
	r.Use(requestIDs, middleware.Recoverer)
	r.NotFound(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, newError(r.Context(), 404, "")) })
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, newError(r.Context(), 405, "")) })
	return r
}

func writeJSON(w http.ResponseWriter, e *Error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.status)
	_ = json.NewEncoder(w).Encode(e)
}

func config(title, version, prefix string, docs bool) huma.Config {
	c := huma.DefaultConfig(title, version)
	// No $schema links in bodies: responses are exactly their schemas.
	c.CreateHooks = nil
	c.OpenAPIPath = prefix + "/openapi"
	c.SchemasPath = prefix + "/schemas"
	c.DocsPath = ""
	if docs {
		c.DocsPath = prefix + "/docs"
	}
	return c
}

// Public is the browser's API under /api.
func Public(d *Deps) (http.Handler, huma.API) {
	r := router()
	r.Use(withRequest)
	remote(r, d)
	api := humachi.New(r, config("AXP Control Plane", "0.1.0", "/api", true))
	huma.Get(api, "/api/health", func(context.Context, *struct{}) (*struct{ Body Health }, error) {
		return &struct{ Body Health }{Health{Status: "ok", Service: "control-plane"}}, nil
	}, func(o *huma.Operation) { o.OperationID = "health"; o.Tags = []string{"health"} })
	registerChat(api, d)
	registerRoutines(api, d)
	registerTasks(api, d)
	return r, api
}

type Health struct {
	Status  string `json:"status"`
	Service string `json:"service"`
}

// Internal is runtimes' API under /internal. It is never served by the
// public server.
func Internal(d *Deps) (http.Handler, huma.API) {
	r := router()
	api := humachi.New(r, config("AXP Internal Runtime Protocol", "1", "/internal", d.Dev))
	registerInternal(api, d)
	// The tasks plugin, through the runtime gateway's /tasks.
	r.Handle("/tasks/mcp", tasksMCP(d))
	return r, api
}
