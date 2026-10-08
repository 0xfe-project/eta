// Package connectors implements llm.Connector for the supported providers.
package connectors

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/akarachen/axp/apps/llm-gateway/internal/llm"
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
	sessions map[string]*llm.LoginSession
}

func (x *XAI) Info() llm.ConnectorInfo {
	return llm.ConnectorInfo{
		ID:          "xai",
		DisplayName: "Grok",
		Flow:        llm.FlowDevice,
		Provider:    "xai",
		Hint:        "需要可以使用 Grok API 的 xAI 账号（例如 SuperGrok 订阅）。",
	}
}

func (x *XAI) StartLogin(ctx context.Context) (*llm.LoginSession, error) {
	var res struct {
		URL       string `json:"url"`
		State     string `json:"state"`
		UserCode  string `json:"user_code"`
		ExpiresIn int    `json:"expires_in"`
	}
	if err := llm.Manage(ctx, x.Management, x.ManagementURL("/xai-auth-url"), http.MethodGet, nil, &res); err != nil {
		return nil, &llm.UserError{Code: "LOGIN_START_FAILED", Message: "无法发起 xAI 登录，请稍后再试。", Cause: err}
	}
	if res.ExpiresIn <= 0 {
		res.ExpiresIn = 900
	}
	sess := &llm.LoginSession{
		ID:        res.State,
		Connector: "xai",
		Flow:      llm.FlowDevice,
		Status:    llm.LoginPending,
		URL:       res.URL,
		UserCode:  res.UserCode,
		ExpiresAt: time.Now().Add(time.Duration(res.ExpiresIn) * time.Second),
	}
	x.mu.Lock()
	if x.sessions == nil {
		x.sessions = map[string]*llm.LoginSession{}
	}
	x.sessions[sess.ID] = sess
	x.mu.Unlock()
	copy := *sess
	return &copy, nil
}

func (x *XAI) PollLogin(ctx context.Context, id string) (*llm.LoginSession, error) {
	x.mu.Lock()
	sess, ok := x.sessions[id]
	x.mu.Unlock()
	if !ok {
		return nil, llm.ErrNotFound
	}
	snapshot := func() (*llm.LoginSession, error) {
		x.mu.Lock()
		defer x.mu.Unlock()
		copy := *sess
		return &copy, nil
	}
	if sess.Status != llm.LoginPending {
		return snapshot()
	}
	if time.Now().After(sess.ExpiresAt) {
		x.finish(sess, llm.LoginExpired, "验证码已过期，请重新发起。")
		return snapshot()
	}
	var res struct {
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	err := llm.Manage(ctx, x.Management, x.ManagementURL("/get-auth-status?state="+url.QueryEscape(id)), http.MethodGet, nil, &res)
	switch {
	case err != nil:
		return nil, err
	case res.Status == "ok":
		x.finish(sess, llm.LoginSucceeded, "")
	case res.Status == "error":
		msg := "登录失败，请重试。"
		if strings.Contains(strings.ToLower(res.Error), "timeout") || strings.Contains(res.Error, "expired") {
			x.finish(sess, llm.LoginExpired, "验证码已过期，请重新发起。")
		} else {
			x.finish(sess, llm.LoginFailed, msg)
		}
	}
	return snapshot()
}

func (x *XAI) finish(sess *llm.LoginSession, status, msg string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	sess.Status = status
	sess.Error = msg
}

func (x *XAI) CancelLogin(ctx context.Context, id string) error {
	x.mu.Lock()
	sess, ok := x.sessions[id]
	delete(x.sessions, id)
	x.mu.Unlock()
	if !ok {
		return llm.ErrNotFound
	}
	if sess.Status != llm.LoginPending {
		return nil
	}
	return llm.Manage(ctx, x.Management, x.ManagementURL("/oauth-session?state="+url.QueryEscape(id)), http.MethodDelete, nil, nil)
}
