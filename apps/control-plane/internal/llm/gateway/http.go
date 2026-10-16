package gateway

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/llm/gateway/usage"
)

// Public is the browser's API under /api/llm: connections, logins, the
// catalog and usage. The control plane serves it on its public listener.
// book is who used the models.
func Public(s *Service, book *usage.Book, logger *slog.Logger) http.Handler {
	h := handler{s: s, logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/llm/v1/connectors", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, s.Connectors())
	})
	mux.HandleFunc("GET /api/llm/v1/connections", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, nonNil(s.Connections()))
	})
	mux.HandleFunc("PATCH /api/llm/v1/connections/{id}", h.patchConnection)
	mux.HandleFunc("DELETE /api/llm/v1/connections/{id}", h.deleteConnection)
	mux.HandleFunc("GET /api/llm/v1/usage", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, nonNil(s.Usage(r.Context())))
	})
	// Tokens by chat agent and routine (and by model and account), over the
	// last 5 hours, day and week.
	mux.HandleFunc("GET /api/llm/v1/usage/agents", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"usage": book.Report(time.Now())})
	})
	mux.Handle("GET /api/llm/v1/models", Catalog(s))
	// What memory may embed with (POST /v1/embeddings), and whether it can now.
	mux.HandleFunc("GET /api/llm/v1/embedding-models", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, s.EmbeddingModels())
	})
	// Checks every account against its provider now, rather than reporting
	// what the last requests left behind.
	mux.HandleFunc("POST /api/llm/v1/refresh", h.refresh)
	mux.HandleFunc("POST /api/llm/v1/logins", h.startLogin)
	mux.HandleFunc("GET /api/llm/v1/logins/{id}", h.pollLogin)
	mux.HandleFunc("POST /api/llm/v1/logins/{id}/input", h.submitLogin)
	mux.HandleFunc("DELETE /api/llm/v1/logins/{id}", h.cancelLogin)
	mux.HandleFunc("/api/llm/", func(w http.ResponseWriter, r *http.Request) {
		h.fail(w, r, http.StatusNotFound, "NOT_FOUND", "资源不存在。")
	})
	return mux
}

// Catalog is the model catalog as JSON: the browser's GET
// /api/llm/v1/models and, on the internal listener, the other processes'.
func Catalog(s *Service) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, s.Models())
	})
}

type handler struct {
	s      *Service
	logger *slog.Logger
}

func (h handler) patchConnection(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil || body.Enabled == nil {
		h.fail(w, r, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "请求参数无效。")
		return
	}
	conn, err := h.s.SetEnabled(r.Context(), r.PathValue("id"), *body.Enabled)
	if err != nil {
		h.error(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, conn)
}

func (h handler) deleteConnection(w http.ResponseWriter, r *http.Request) {
	if err := h.s.Delete(r.Context(), r.PathValue("id")); err != nil {
		h.error(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h handler) refresh(w http.ResponseWriter, r *http.Request) {
	status, err := h.s.Refresh(r.Context())
	if err != nil {
		h.error(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (h handler) startLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Connector string `json:"connector"`
		LoginInput
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil || body.Connector == "" {
		h.fail(w, r, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "请求参数无效。")
		return
	}
	sess, err := h.s.StartLogin(r.Context(), body.Connector, body.LoginInput)
	if err != nil {
		h.error(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, sess)
}

func (h handler) pollLogin(w http.ResponseWriter, r *http.Request) {
	sess, err := h.s.PollLogin(r.Context(), r.PathValue("id"))
	if err != nil {
		h.error(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, sess)
}

func (h handler) submitLogin(w http.ResponseWriter, r *http.Request) {
	var in LoginInput
	if json.NewDecoder(r.Body).Decode(&in) != nil {
		h.fail(w, r, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "请求参数无效。")
		return
	}
	if err := h.s.SubmitLogin(r.Context(), r.PathValue("id"), in); err != nil {
		h.error(w, r, err)
		return
	}
	h.pollLogin(w, r)
}

func (h handler) cancelLogin(w http.ResponseWriter, r *http.Request) {
	if err := h.s.CancelLogin(r.Context(), r.PathValue("id")); err != nil && !errors.Is(err, ErrNotFound) {
		h.error(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// error writes err for the browser. An upstream failure is 424, never 502:
// Cloudflare, in front of production, replaces an origin's 502 and 504 with
// its own error page, and the message would never reach the browser.
func (h handler) error(w http.ResponseWriter, r *http.Request, err error) {
	var ue *UserError
	switch {
	case errors.Is(err, ErrNotFound):
		h.fail(w, r, http.StatusNotFound, "NOT_FOUND", "资源不存在。")
	case errors.Is(err, ErrUnsupported):
		h.fail(w, r, http.StatusConflict, "UNSUPPORTED", "该连接方式不支持此操作。")
	case errors.As(err, &ue):
		h.logger.Warn("llm request failed", "path", r.URL.Path, "error", err)
		h.fail(w, r, http.StatusFailedDependency, ue.Code, ue.Message)
	default:
		h.logger.Error("llm request failed", "path", r.URL.Path, "error", err)
		h.fail(w, r, http.StatusFailedDependency, "UPSTREAM_ERROR", "模型服务暂时不可用，请稍后再试。")
	}
}

// fail writes the control plane's error envelope.
func (h handler) fail(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{
		"code":       code,
		"message":    message,
		"request_id": r.Header.Get("X-Request-Id"),
	}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
