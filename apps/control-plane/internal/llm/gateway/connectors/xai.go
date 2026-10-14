// Package connectors implements gateway.Connector for the supported providers.
package connectors

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/llm/gateway"
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
		Hint:        "需要可以使用 Grok API 的 xAI 账号（例如 SuperGrok 订阅）。",
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
		return nil, &gateway.UserError{Code: "LOGIN_START_FAILED", Message: "无法发起 xAI 登录，请稍后再试。", Cause: err}
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
		x.finish(sess, gateway.LoginExpired, "验证码已过期，请重新发起。")
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
		x.finish(sess, gateway.LoginSucceeded, "")
	case res.Status == "error":
		msg := "登录失败，请重试。"
		if strings.Contains(strings.ToLower(res.Error), "timeout") || strings.Contains(res.Error, "expired") {
			x.finish(sess, gateway.LoginExpired, "验证码已过期，请重新发起。")
		} else {
			x.finish(sess, gateway.LoginFailed, msg)
		}
	}
	return snapshot()
}

func (x *XAI) finish(sess *gateway.LoginSession, status, msg string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	sess.Status = status
	sess.Error = msg
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
