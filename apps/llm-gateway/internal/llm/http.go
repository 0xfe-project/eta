package llm

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
)

// Mount registers the public API under /api/llm. The gateway forwards it to
// the browser; the control plane calls it directly.
func Mount(e *gin.Engine, s *Service, logger *slog.Logger) {
	e.GET("/api/llm/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "llm-gateway"})
	})

	h := handler{s: s, logger: logger}
	v1 := e.Group("/api/llm/v1")
	v1.GET("/connectors", func(c *gin.Context) { c.JSON(http.StatusOK, s.Connectors()) })
	v1.GET("/connections", func(c *gin.Context) { c.JSON(http.StatusOK, nonNil(s.Connections())) })
	v1.PATCH("/connections/:id", h.patchConnection)
	v1.DELETE("/connections/:id", h.deleteConnection)
	v1.GET("/models", func(c *gin.Context) { c.JSON(http.StatusOK, s.Models()) })
	v1.POST("/logins", h.startLogin)
	v1.GET("/logins/:id", h.pollLogin)
	v1.POST("/logins/:id/input", h.submitLogin)
	v1.DELETE("/logins/:id", h.cancelLogin)
}

type handler struct {
	s      *Service
	logger *slog.Logger
}

func (h handler) patchConnection(c *gin.Context) {
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if c.ShouldBindJSON(&body) != nil || body.Enabled == nil {
		h.fail(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "请求参数无效。")
		return
	}
	conn, err := h.s.SetEnabled(c.Request.Context(), c.Param("id"), *body.Enabled)
	if err != nil {
		h.error(c, err)
		return
	}
	c.JSON(http.StatusOK, conn)
}

func (h handler) deleteConnection(c *gin.Context) {
	if err := h.s.Delete(c.Request.Context(), c.Param("id")); err != nil {
		h.error(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h handler) startLogin(c *gin.Context) {
	var body struct {
		Connector string `json:"connector"`
		LoginInput
	}
	if c.ShouldBindJSON(&body) != nil || body.Connector == "" {
		h.fail(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "请求参数无效。")
		return
	}
	sess, err := h.s.StartLogin(c.Request.Context(), body.Connector, body.LoginInput)
	if err != nil {
		h.error(c, err)
		return
	}
	c.JSON(http.StatusCreated, sess)
}

func (h handler) pollLogin(c *gin.Context) {
	sess, err := h.s.PollLogin(c.Request.Context(), c.Param("id"))
	if err != nil {
		h.error(c, err)
		return
	}
	c.JSON(http.StatusOK, sess)
}

func (h handler) submitLogin(c *gin.Context) {
	var in LoginInput
	if c.ShouldBindJSON(&in) != nil {
		h.fail(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "请求参数无效。")
		return
	}
	if err := h.s.SubmitLogin(c.Request.Context(), c.Param("id"), in); err != nil {
		h.error(c, err)
		return
	}
	h.pollLogin(c)
}

func (h handler) cancelLogin(c *gin.Context) {
	if err := h.s.CancelLogin(c.Request.Context(), c.Param("id")); err != nil && !errors.Is(err, ErrNotFound) {
		h.error(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h handler) error(c *gin.Context, err error) {
	var ue *UserError
	switch {
	case errors.Is(err, ErrNotFound):
		h.fail(c, http.StatusNotFound, "NOT_FOUND", "资源不存在。")
	case errors.Is(err, ErrUnsupported):
		h.fail(c, http.StatusConflict, "UNSUPPORTED", "该连接方式不支持此操作。")
	case errors.As(err, &ue):
		h.logger.Warn("llm request failed", "path", c.Request.URL.Path, "error", err)
		h.fail(c, http.StatusBadGateway, ue.Code, ue.Message)
	default:
		h.logger.Error("llm request failed", "path", c.Request.URL.Path, "error", err)
		h.fail(c, http.StatusBadGateway, "UPSTREAM_ERROR", "模型服务暂时不可用，请稍后再试。")
	}
}

// fail writes the control plane's error envelope.
func (h handler) fail(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{
		"code":       code,
		"message":    message,
		"request_id": c.GetHeader("X-Request-Id"),
	}})
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
