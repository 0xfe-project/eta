package connectors

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/llm-gateway/internal/llm"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCodexDeviceLogin(t *testing.T) {
	enc := func(v any) string {
		raw, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	idToken := enc(map[string]string{"alg": "none"}) + "." + enc(map[string]any{
		"email": "dev@example.com",
		"https://api.openai.com/auth": map[string]string{
			"chatgpt_account_id": "acct-1", "chatgpt_plan_type": "pro",
		},
	}) + ".sig"

	var polls atomic.Int32
	openai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/accounts/deviceauth/usercode":
			_, _ = io.WriteString(w, `{"device_auth_id":"dev-1","user_code":"ABCD-1234","interval":"1"}`)
		case "/api/accounts/deviceauth/token":
			if polls.Add(1) < 2 {
				w.WriteHeader(http.StatusForbidden) // not approved yet
				return
			}
			_, _ = io.WriteString(w, `{"authorization_code":"code-1","code_verifier":"verifier-1"}`)
		case "/oauth/token":
			_ = r.ParseForm()
			if r.Form.Get("code") != "code-1" || r.Form.Get("code_verifier") != "verifier-1" ||
				r.Form.Get("redirect_uri") != codexDeviceRedirectURI {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "access", "refresh_token": "refresh", "id_token": idToken, "expires_in": 3600,
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer openai.Close()

	uploaded := make(chan *http.Request, 1)
	var body []byte
	mgmt := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		body, _ = io.ReadAll(r.Body)
		uploaded <- r
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"status":"ok"}`))}, nil
	})}

	c := &Codex{
		Management:    mgmt,
		ManagementURL: func(p string) string { return "http://cpa" + p },
		Issuer:        openai.URL,
	}
	sess, err := c.StartLogin(context.Background(), llm.LoginInput{})
	if err != nil {
		t.Fatal(err)
	}
	if sess.UserCode != "ABCD-1234" || sess.URL != codexVerificationURL || sess.Status != llm.LoginPending {
		t.Fatalf("session = %+v", sess)
	}

	select {
	case r := <-uploaded:
		if r.Method != http.MethodPost || r.URL.Query().Get("name") != "codex-ba36a4ed-dev@example.com-pro.json" {
			t.Fatalf("upload %s %s", r.Method, r.URL)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("credential was not uploaded")
	}
	var cred map[string]string
	_ = json.Unmarshal(body, &cred)
	if cred["type"] != "codex" || cred["refresh_token"] != "refresh" || cred["account_id"] != "acct-1" || cred["email"] != "dev@example.com" {
		t.Fatalf("credential = %v", cred)
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		got, _ := c.PollLogin(context.Background(), sess.ID)
		if got.Status == llm.LoginSucceeded {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("status = %s", got.Status)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
