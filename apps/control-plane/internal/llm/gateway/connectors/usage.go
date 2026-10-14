package connectors

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/llm/gateway"
)

// The endpoints the Codex CLI and the Grok CLI read their own limits from.
const (
	codexUsageURL   = "https://chatgpt.com/backend-api/wham/usage"
	grokBillingURL  = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
	grokSettingsURL = "https://cli-chat-proxy.grok.com/v1/settings"
)

var errNoToken = &gateway.UserError{Code: "NO_TOKEN", Message: "该账号没有可用的登录令牌。"}

// Usage reads the 5-hour and weekly windows of a ChatGPT subscription.
func (c *Codex) Usage(ctx context.Context, metadata map[string]any) (gateway.Usage, error) {
	token, _ := metadata["access_token"].(string)
	if token == "" {
		return gateway.Usage{}, errNoToken
	}
	accountID, _ := metadata["account_id"].(string)
	var body struct {
		PlanType  string `json:"plan_type"`
		RateLimit struct {
			Primary   *codexWindow `json:"primary_window"`
			Secondary *codexWindow `json:"secondary_window"`
		} `json:"rate_limit"`
	}
	if err := getUsage(ctx, c.client(), codexUsageURL, token, map[string]string{"ChatGPT-Account-Id": accountID}, &body); err != nil {
		return gateway.Usage{}, err
	}
	u := gateway.Usage{Plan: codexPlanName(body.PlanType)}
	for _, w := range []struct {
		window   *codexWindow
		fallback string
	}{{body.RateLimit.Primary, "5h"}, {body.RateLimit.Secondary, "weekly"}} {
		if w.window != nil {
			u.Windows = append(u.Windows, w.window.usage(w.fallback))
		}
	}
	return u, nil
}

type codexWindow struct {
	UsedPercent        float64 `json:"used_percent"`
	LimitWindowSeconds int64   `json:"limit_window_seconds"`
	ResetAt            int64   `json:"reset_at"`
}

func (w codexWindow) usage(fallback string) gateway.UsageWindow {
	out := gateway.UsageWindow{
		Kind:            gateway.WindowKind(w.LimitWindowSeconds, fallback),
		Used:            clampPercent(w.UsedPercent),
		DurationSeconds: w.LimitWindowSeconds,
	}
	if w.ResetAt > 0 {
		t := time.Unix(w.ResetAt, 0).UTC()
		out.ResetsAt = &t
	}
	return out
}

// codexPlanName turns chatgpt_plan_type into the name ChatGPT shows.
func codexPlanName(plan string) string {
	switch strings.ToLower(strings.TrimSpace(plan)) {
	case "":
		return ""
	case "prolite":
		return "Pro 5x"
	case "pro":
		return "Pro 20x"
	}
	words := strings.Split(strings.ToLower(plan), "_")
	for i, w := range words {
		if w != "" {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}

// Usage reads the credit window of a Grok subscription. Accounts billed
// without a period (no subscription) report no windows.
func (x *XAI) Usage(ctx context.Context, metadata map[string]any) (gateway.Usage, error) {
	token, _ := metadata["access_token"].(string)
	if token == "" {
		return gateway.Usage{}, errNoToken
	}
	var billing struct {
		Config struct {
			CurrentPeriod *struct {
				Start time.Time `json:"start"`
				End   time.Time `json:"end"`
			} `json:"currentPeriod"`
			CreditUsagePercent flexFloat `json:"creditUsagePercent"` // omitted when zero
		} `json:"config"`
	}
	if err := getUsage(ctx, x.client(), grokBillingURL, token, nil, &billing); err != nil {
		return gateway.Usage{}, err
	}
	var settings struct {
		Tier string `json:"subscription_tier_display"`
	}
	_ = getUsage(ctx, x.client(), grokSettingsURL, token, nil, &settings) // the plan name is optional
	u := gateway.Usage{Plan: strings.TrimSpace(settings.Tier)}
	if p := billing.Config.CurrentPeriod; p != nil && p.End.After(p.Start) {
		seconds := int64(p.End.Sub(p.Start).Seconds())
		end := p.End.UTC()
		u.Windows = []gateway.UsageWindow{{
			Kind:            gateway.WindowKind(seconds, "weekly"),
			Used:            clampPercent(float64(billing.Config.CreditUsagePercent)),
			ResetsAt:        &end,
			DurationSeconds: seconds,
		}}
	}
	return u, nil
}

func (x *XAI) client() *http.Client {
	if x.HTTP != nil {
		return x.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func getUsage(ctx context.Context, client *http.Client, url, token string, headers map[string]string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
	res, err := client.Do(req)
	if err != nil {
		return &gateway.UserError{Code: "USAGE_UNAVAILABLE", Message: "暂时无法读取用量。", Cause: err}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	switch {
	case res.StatusCode == http.StatusUnauthorized:
		return &gateway.UserError{Code: "AUTH_EXPIRED", Message: "登录已失效，无法读取用量。", Cause: fmt.Errorf("usage: status 401")}
	case res.StatusCode/100 != 2:
		return &gateway.UserError{Code: "USAGE_UNAVAILABLE", Message: "暂时无法读取用量。", Cause: fmt.Errorf("usage: status %d", res.StatusCode)}
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return &gateway.UserError{Code: "USAGE_UNAVAILABLE", Message: "暂时无法读取用量。", Cause: err}
	}
	return nil
}

// flexFloat accepts a JSON number or a numeric string.
type flexFloat float64

func (f *flexFloat) UnmarshalJSON(b []byte) error {
	v, err := strconv.ParseFloat(strings.Trim(string(b), `"`), 64)
	if err != nil {
		return err
	}
	*f = flexFloat(v)
	return nil
}

func clampPercent(v float64) float64 {
	return min(max(v, 0), 100)
}
