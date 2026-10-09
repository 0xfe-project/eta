package routines

import (
	"fmt"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

// Error is a product error: an HTTP status, a stable code and a message for
// people, sent as {"error": {"code", "message", "request_id"}}.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message) }

func New(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

func NotFound() *Error { return New(404, "NOT_FOUND", "资源不存在。") }

// Time is the API's timestamp: UTC with milliseconds, always the same
// length, so the browser can sort timestamps as strings.
type Time struct{ time.Time }

const timeLayout = "2006-01-02T15:04:05.000Z"

func (t Time) MarshalJSON() ([]byte, error) {
	return []byte(`"` + t.UTC().Format(timeLayout) + `"`), nil
}

func (t *Time) UnmarshalJSON(data []byte) error { return t.Time.UnmarshalJSON(data) }

func (Time) Schema(huma.Registry) *huma.Schema {
	return &huma.Schema{Type: huma.TypeString, Format: "date-time"}
}
