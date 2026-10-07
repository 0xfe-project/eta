// Package llm is the llm-gateway's provider-neutral layer: connectors bring
// credentials in, the core auth manager routes with them, and the catalog
// lists the models they unlock.
package llm

import (
	"context"
	"errors"
	"time"
)

// Login flows a connector can run.
const (
	FlowDevice        = "oauth_device"
	FlowRedirectPaste = "oauth_redirect"
	FlowAPIKey        = "api_key"
)

// Login session states.
const (
	LoginPending   = "pending"
	LoginSucceeded = "succeeded"
	LoginFailed    = "failed"
	LoginExpired   = "expired"
)

// ConnectorInfo describes a connector to the UI.
type ConnectorInfo struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	Flow        string `json:"flow"`
	// Provider is the core auth provider key the connector produces
	// (credentials and models are grouped by it).
	Provider string `json:"-"`
	// Hint is optional guidance shown next to the login step.
	Hint string `json:"hint,omitempty"`
}

// LoginInput carries user-supplied values for StartLogin/SubmitLogin.
type LoginInput struct {
	CallbackURL string `json:"callback_url,omitempty"`
	APIKey      string `json:"api_key,omitempty"`
	BaseURL     string `json:"base_url,omitempty"`
}

// LoginSession is one login attempt.
type LoginSession struct {
	ID        string    `json:"id"`
	Connector string    `json:"connector"`
	Flow      string    `json:"flow"`
	Status    string    `json:"status"`
	URL       string    `json:"url,omitempty"`
	UserCode  string    `json:"user_code,omitempty"`
	ExpiresAt time.Time `json:"expires_at"`
	Error     string    `json:"error,omitempty"`
}

// Connector is one way of bringing credentials into the core auth manager.
// Codex and xAI OAuth are the first implementations; a raw API key
// connector registers an auth the same way.
type Connector interface {
	Info() ConnectorInfo
	StartLogin(ctx context.Context, in LoginInput) (*LoginSession, error)
	PollLogin(ctx context.Context, id string) (*LoginSession, error)
	SubmitLogin(ctx context.Context, id string, in LoginInput) error
	CancelLogin(ctx context.Context, id string) error
}

// ErrNotFound is returned for unknown connectors, connections or logins.
var ErrNotFound = errors.New("not found")

// ErrUnsupported is returned when a connector does not support an operation.
var ErrUnsupported = errors.New("unsupported")

// UserError carries a message safe to show to the user.
type UserError struct {
	Code    string
	Message string
	Cause   error
}

func (e *UserError) Error() string {
	if e.Cause != nil {
		return e.Message + ": " + e.Cause.Error()
	}
	return e.Message
}

func (e *UserError) Unwrap() error { return e.Cause }
