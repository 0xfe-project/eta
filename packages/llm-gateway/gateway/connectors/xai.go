// Package connectors implements gateway.Connector for the supported providers.
package connectors

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/0xfe-project/eta/packages/llm-gateway/gateway"
)

// XAI logs in to xAI (Grok) with the device-code flow that CPA's management
// API runs: xai-auth-url starts it, get-auth-status reports completion, and
// CPA stores the credential itself.
type XAI struct {
	Management    *http.Client
	ManagementURL func(string) string
	// HTTP talks to Grok; nil uses a client with a 30s timeout.
	HTTP *http.Client

	mu       sync.Mutex
	sessions map[string]*gateway.LoginSession
}

func (x *XAI) Info() gateway.ConnectorInfo {
	return gateway.ConnectorInfo{
		ID:          "xai",
		DisplayName: "Grok",
		Flow:        gateway.FlowDevice,
		Provider:    "xai",
	}
}

func (x *XAI) StartLogin(ctx context.Context, _ gateway.LoginInput) (*gateway.LoginSession, error) {
	var res struct {
		URL       string `json:"url"`
		State     string `json:"state"`
		UserCode  string `json:"user_code"`
		ExpiresIn int    `json:"expires_in"`
	}
	if err := gateway.Manage(ctx, x.Management, x.ManagementURL("/xai-auth-url"), http.MethodGet, nil, &res); err != nil {
		return nil, &gateway.UserError{Code: gateway.CodeLoginStartFailed, Message: "Could not start the xAI login.", Params: gateway.Params{"provider": "xAI"}, Cause: err}
	}
	if res.ExpiresIn <= 0 {
		res.ExpiresIn = 900
	}
	sess := &gateway.LoginSession{
		ID:        res.State,
		Connector: "xai",
		Flow:      gateway.FlowDevice,
		Status:    gateway.LoginPending,
		URL:       res.URL,
		UserCode:  res.UserCode,
		ExpiresAt: time.Now().Add(time.Duration(res.ExpiresIn) * time.Second),
	}
	x.mu.Lock()
	if x.sessions == nil {
		x.sessions = map[string]*gateway.LoginSession{}
	}
	x.sessions[sess.ID] = sess
	x.mu.Unlock()
	copy := *sess
	return &copy, nil
}

func (x *XAI) PollLogin(ctx context.Context, id string) (*gateway.LoginSession, error) {
	x.mu.Lock()
	sess, ok := x.sessions[id]
	x.mu.Unlock()
	if !ok {
		return nil, gateway.ErrNotFound
	}
	snapshot := func() (*gateway.LoginSession, error) {
		x.mu.Lock()
		defer x.mu.Unlock()
		copy := *sess
		return &copy, nil
	}
	if sess.Status != gateway.LoginPending {
		return snapshot()
	}
	if time.Now().After(sess.ExpiresAt) {
		x.finish(sess, gateway.LoginExpired, gateway.CodeDeviceCodeTimeout, "The device code expired.")
		return snapshot()
	}
	var res struct {
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	err := gateway.Manage(ctx, x.Management, x.ManagementURL("/get-auth-status?state="+url.QueryEscape(id)), http.MethodGet, nil, &res)
	switch {
	case err != nil:
		return nil, err
	case res.Status == "ok":
		x.finish(sess, gateway.LoginSucceeded, "", "")
	case res.Status == "error":
		msg := "The login failed."
		if strings.Contains(strings.ToLower(res.Error), "timeout") || strings.Contains(res.Error, "expired") {
			x.finish(sess, gateway.LoginExpired, gateway.CodeDeviceCodeTimeout, "The device code expired.")
		} else {
			x.finish(sess, gateway.LoginFailed, gateway.CodeLoginFailed, msg)
		}
	}
	return snapshot()
}

func (x *XAI) finish(sess *gateway.LoginSession, status, code, msg string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	sess.Status = status
	sess.Error = nil
	if code != "" {
		sess.Error = &gateway.Problem{Code: code, Message: msg}
	}
}

func (x *XAI) SubmitLogin(context.Context, string, gateway.LoginInput) error {
	return gateway.ErrUnsupported
}

func (x *XAI) CancelLogin(ctx context.Context, id string) error {
	x.mu.Lock()
	sess, ok := x.sessions[id]
	delete(x.sessions, id)
	x.mu.Unlock()
	if !ok {
		return gateway.ErrNotFound
	}
	if sess.Status != gateway.LoginPending {
		return nil
	}
	return gateway.Manage(ctx, x.Management, x.ManagementURL("/oauth-session?state="+url.QueryEscape(id)), http.MethodDelete, nil, nil)
}
