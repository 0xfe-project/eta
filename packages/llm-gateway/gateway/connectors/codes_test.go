package connectors

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/0xfe-project/eta/packages/llm-gateway/gateway"
)

func problemCode(err error) string {
	var ue *gateway.UserError
	if errors.As(err, &ue) {
		return ue.Code
	}
	return ""
}

func TestUsageFailuresHaveCodes(t *testing.T) {
	statusClient := func(status int, body string) *http.Client {
		return &http.Client{Transport: roundTrip(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
		})}
	}
	cred := map[string]any{"access_token": "tok"}
	cases := []struct {
		name string
		http *http.Client
		cred map[string]any
		want string
	}{
		{"no token", statusClient(200, "{}"), map[string]any{}, gateway.CodeNoToken},
		{"401", statusClient(http.StatusUnauthorized, ""), cred, gateway.CodeLoginExpired},
		{"500", statusClient(http.StatusInternalServerError, ""), cred, gateway.CodeUsageUnavailable},
		{"not json", statusClient(200, "<html>"), cred, gateway.CodeUsageUnavailable},
		{"network", &http.Client{Transport: roundTrip(func(*http.Request) (*http.Response, error) { return nil, errors.New("down") })}, cred, gateway.CodeUsageUnavailable},
	}
	for _, c := range cases {
		_, err := (&Codex{HTTP: c.http}).Usage(context.Background(), c.cred)
		if got := problemCode(err); got != c.want {
			t.Errorf("%s: code %q, want %q", c.name, got, c.want)
		}
	}
}

func TestCodexLoginStartFailureHasCode(t *testing.T) {
	openai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer openai.Close()
	_, err := (&Codex{Issuer: openai.URL}).StartLogin(context.Background(), gateway.LoginInput{})
	var ue *gateway.UserError
	if !errors.As(err, &ue) || ue.Code != gateway.CodeLoginStartFailed || ue.Params["provider"] != "Codex" {
		t.Fatalf("err = %v", err)
	}
}

func TestCodexLoginEndsWithCode(t *testing.T) {
	openai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/accounts/deviceauth/usercode" {
			_, _ = io.WriteString(w, `{"device_auth_id":"d","user_code":"A-1","interval":"1"}`)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer openai.Close()
	cx := &Codex{Issuer: openai.URL}
	sess, err := cx.StartLogin(context.Background(), gateway.LoginInput{})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		got, _ := cx.PollLogin(context.Background(), sess.ID)
		if got.Status != gateway.LoginPending {
			if got.Status != gateway.LoginFailed || got.Error == nil || got.Error.Code != gateway.CodeLoginFailed {
				t.Fatalf("session = %+v", got)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("login still pending")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
