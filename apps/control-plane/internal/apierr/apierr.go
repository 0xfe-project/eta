// Package apierr is the product error: an HTTP status, a stable code and a
// message for people, sent as {"error": {"code", "message", "request_id"}}.
package apierr

import "fmt"

type Error struct {
	Status  int
	Code    string
	Message string
	// Top-level fields of the body, for internal protocol errors (e.g. the
	// next expected event sequence).
	Extra map[string]any
}

func (e *Error) Error() string { return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message) }

func New(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

func NotFound() *Error { return New(404, "NOT_FOUND", "资源不存在。") }

// QueueUnavailable is any failure to reach NATS during a request.
func QueueUnavailable() *Error {
	return New(503, "QUEUE_UNAVAILABLE", "消息队列暂时不可用，请稍后再试。")
}

// Upstream is a failure of something beyond the control plane: the relay,
// a remote computer's runtime, the forge service. It is 424, never 502 or
// 504: Cloudflare, in front of production, replaces an origin's 502 and 504
// with its own error page, and the message would never reach the browser.
func Upstream(code, message string) *Error { return New(424, code, message) }
