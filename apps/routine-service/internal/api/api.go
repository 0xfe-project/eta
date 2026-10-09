// Package api is the routine service's HTTP API, which the browser calls
// under /api/routines through the gateway. Its OpenAPI document is
// generated from the code; the web client's types are generated from it.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/akarachen/axp/apps/routine-service/internal/routines"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
)

const prefix = "/api/routines"

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

// --- errors ----------------------------------------------------------------------

type ErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
}

// Error is every error response: {"error": {"code", "message", "request_id"}}.
type Error struct {
	status int
	Detail ErrorBody `json:"error"`
}

func (e *Error) Error() string  { return e.Detail.Code + ": " + e.Detail.Message }
func (e *Error) GetStatus() int { return e.status }

var statusErrors = map[int][2]string{
	400: {"BAD_REQUEST", "请求格式无效。"},
	404: {"NOT_FOUND", "资源不存在。"},
	405: {"METHOD_NOT_ALLOWED", "不支持该请求方法。"},
	422: {"VALIDATION_ERROR", "请求参数无效。"},
}

func newError(ctx context.Context, status int, message string, errs ...error) *Error {
	e := &Error{status: status, Detail: ErrorBody{RequestID: requestID(ctx)}}
	for _, err := range errs {
		var product *routines.Error
		if errors.As(err, &product) {
			e.status, e.Detail.Code, e.Detail.Message = product.Status, product.Code, product.Message
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

type ctxKey struct{}

func requestID(ctx context.Context) string {
	id, _ := ctx.Value(ctxKey{}).(string)
	return id
}

// requestIDs gives each request the gateway's X-Request-Id, so gateway and
// service logs line up, or a new one.
func requestIDs(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = strings.ReplaceAll(uuid.NewString(), "-", "")
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, id)))
	})
}

func writeJSON(w http.ResponseWriter, e *Error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.status)
	_ = json.NewEncoder(w).Encode(e)
}

// --- the API -------------------------------------------------------------------------

type RoutineIn struct {
	Name     string            `json:"name" minLength:"1" maxLength:"100"`
	Brief    string            `json:"brief" minLength:"1" maxLength:"8000"`
	Model    string            `json:"model" minLength:"1" maxLength:"200"`
	Schedule routines.Schedule `json:"schedule"`
	Timezone string            `json:"timezone" minLength:"1" maxLength:"64"`
}

// RoutineUpdateIn is a partial update: only fields that are sent change.
type RoutineUpdateIn struct {
	Name     *string            `json:"name,omitempty" nullable:"true" minLength:"1" maxLength:"100"`
	Brief    *string            `json:"brief,omitempty" nullable:"true" minLength:"1" maxLength:"8000"`
	Model    *string            `json:"model,omitempty" nullable:"true" minLength:"1" maxLength:"200"`
	Schedule *routines.Schedule `json:"schedule,omitempty"`
	Timezone *string            `json:"timezone,omitempty" nullable:"true" minLength:"1" maxLength:"64"`
	Enabled  *bool              `json:"enabled,omitempty" nullable:"true"`
}

type FeedbackIn struct {
	Text string `json:"text" minLength:"1" maxLength:"4000"`
}

type RoutineList struct {
	Routines []routines.Routine `json:"routines"`
}

type RoutinePath struct {
	RoutineID string `path:"routine_id"`
}

type Health struct {
	Status  string `json:"status"`
	Service string `json:"service"`
}

type body[T any] struct {
	Body T
}

func op(id, method, path, summary string, status int) huma.Operation {
	return huma.Operation{
		OperationID: id, Method: method, Path: prefix + "/v1" + path, Summary: summary,
		DefaultStatus: status, Tags: []string{"routines"}, Errors: []int{400, 404, 409, 422, 503},
	}
}

// New is the API's handler, and the API for its OpenAPI document.
func New(s *routines.Service, docs bool) (http.Handler, huma.API) {
	r := chi.NewRouter()
	r.Use(requestIDs, middleware.Recoverer)
	r.NotFound(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, newError(r.Context(), 404, "")) })
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, newError(r.Context(), 405, "")) })
	config := huma.DefaultConfig("AXP Routines", "0.1.0")
	// No $schema links in bodies: responses are exactly their schemas.
	config.CreateHooks = nil
	config.OpenAPIPath, config.SchemasPath, config.DocsPath = prefix+"/openapi", prefix+"/schemas", ""
	if docs {
		config.DocsPath = prefix + "/docs"
	}
	api := humachi.New(r, config)

	huma.Get(api, prefix+"/health", func(context.Context, *struct{}) (*body[Health], error) {
		return &body[Health]{Health{Status: "ok", Service: "routine-service"}}, nil
	}, func(o *huma.Operation) { o.OperationID = "health"; o.Tags = []string{"health"} })

	huma.Register(api, op("listRoutines", http.MethodGet, "/routines", "Every routine with its recent runs", 200),
		func(ctx context.Context, _ *struct{}) (*body[RoutineList], error) {
			list, err := s.List(ctx)
			if err != nil {
				return nil, err
			}
			return &body[RoutineList]{RoutineList{list}}, nil
		})

	huma.Register(api, op("createRoutine", http.MethodPost, "/routines", "Create a routine", 201),
		func(ctx context.Context, in *struct{ Body RoutineIn }) (*body[routines.Routine], error) {
			routine, err := s.Create(ctx, routines.Input(in.Body))
			if err != nil {
				return nil, err
			}
			return &body[routines.Routine]{*routine}, nil
		})

	huma.Register(api, op("updateRoutine", http.MethodPatch, "/routines/{routine_id}",
		"Change a routine; only the fields sent change", 200),
		func(ctx context.Context, in *struct {
			RoutinePath
			Body RoutineUpdateIn
		}) (*body[routines.Routine], error) {
			b := in.Body
			routine, err := s.Update(ctx, in.RoutineID, routines.Changes{
				Name: b.Name, Brief: b.Brief, Model: b.Model, Schedule: b.Schedule, Timezone: b.Timezone, Enabled: b.Enabled,
			})
			if err != nil {
				return nil, err
			}
			return &body[routines.Routine]{*routine}, nil
		})

	huma.Register(api, op("deleteRoutine", http.MethodDelete, "/routines/{routine_id}", "Delete a routine and its history", 204),
		func(ctx context.Context, in *RoutinePath) (*struct{}, error) {
			return nil, s.Delete(ctx, in.RoutineID)
		})

	huma.Register(api, op("runRoutine", http.MethodPost, "/routines/{routine_id}/run", "Run a routine now", 202),
		func(ctx context.Context, in *RoutinePath) (*body[routines.Routine], error) {
			routine, err := s.RunNow(ctx, in.RoutineID)
			if err != nil {
				return nil, err
			}
			return &body[routines.Routine]{*routine}, nil
		})

	huma.Register(api, op("restoreBrief", http.MethodPost, "/routines/{routine_id}/briefs/{version}/restore",
		"Make an earlier brief the current one", 200),
		func(ctx context.Context, in *struct {
			RoutinePath
			Version int `path:"version"`
		}) (*body[routines.Routine], error) {
			routine, err := s.RestoreBrief(ctx, in.RoutineID, in.Version)
			if err != nil {
				return nil, err
			}
			return &body[routines.Routine]{*routine}, nil
		})

	huma.Register(api, op("addFeedback", http.MethodPost, "/routines/{routine_id}/runs/{run_id}/feedback",
		"Give feedback on a run; it revises the brief", 201),
		func(ctx context.Context, in *struct {
			RoutinePath
			RunID string `path:"run_id"`
			Body  FeedbackIn
		}) (*body[routines.Feedback], error) {
			feedback, err := s.AddFeedback(ctx, in.RoutineID, in.RunID, strings.TrimSpace(in.Body.Text))
			if err != nil {
				return nil, err
			}
			return &body[routines.Feedback]{*feedback}, nil
		})
	return r, api
}
