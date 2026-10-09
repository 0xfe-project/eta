// Package jsontime is the API's timestamp: UTC with milliseconds, always the
// same length, so the browser can sort timestamps as strings.
package jsontime

import (
	"time"

	"github.com/danielgtaylor/huma/v2"
)

const layout = "2006-01-02T15:04:05.000Z"

type Time struct{ time.Time }

func From(t time.Time) Time { return Time{t} }

// Ptr is t as a Time, or nil.
func Ptr(t *time.Time) *Time {
	if t == nil {
		return nil
	}
	return &Time{*t}
}

func (t Time) MarshalJSON() ([]byte, error) {
	return []byte(`"` + t.UTC().Format(layout) + `"`), nil
}

func (t *Time) UnmarshalJSON(data []byte) error {
	return t.Time.UnmarshalJSON(data)
}

func (Time) Schema(huma.Registry) *huma.Schema {
	return &huma.Schema{Type: huma.TypeString, Format: "date-time"}
}
