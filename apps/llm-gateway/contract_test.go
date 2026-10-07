package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/llm-gateway/internal/connectors"
	"github.com/akarachen/axp/apps/llm-gateway/internal/cpa"
	"github.com/akarachen/axp/apps/llm-gateway/internal/llm"
	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy"
)

func fakeJWT(claims map[string]any) string {
	enc := func(v any) string {
		raw, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	return enc(map[string]string{"alg": "none"}) + "." + enc(claims) + ".sig"
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// TestCPAContract guards the CPA surface llm-gateway depends on: the
// management API accepts a codex credential in CPA's file format, the core
// auth manager lists it, and its models reach the registry and /v1/models.
// It must pass on every CPA upgrade.
func TestCPAContract(t *testing.T) {
	port := freePort(t)
	var service *llm.Service
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	proxy, err := cpa.New(cpa.Options{
		Host: "127.0.0.1", Port: port, StateDir: t.TempDir(),
		Mount: func(e *gin.Engine) { llm.Mount(e, service, logger) },
	})
	if err != nil {
		t.Fatal(err)
	}
	mgmt := proxy.Management()
	service = llm.NewService(llm.Config{
		Connectors: []llm.Connector{
			&connectors.Codex{Management: mgmt, ManagementURL: cpa.ManagementURL},
			&connectors.XAI{Management: mgmt, ManagementURL: cpa.ManagementURL},
		},
		Auths:         proxy.Auths,
		Registry:      cliproxy.GlobalModelRegistry(),
		Management:    mgmt,
		ManagementURL: cpa.ManagementURL,
		CatalogPath:   t.TempDir() + "/models.json",
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- proxy.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	waitFor(t, func() bool {
		res, err := http.Get(base + "/api/llm/health")
		if err == nil {
			res.Body.Close()
		}
		return err == nil && res.StatusCode == 200
	})

	idToken := fakeJWT(map[string]any{
		"email": "dev@example.com",
		"https://api.openai.com/auth": map[string]string{
			"chatgpt_account_id": "acct-1", "chatgpt_plan_type": "plus",
		},
	})
	cred, name, err := connectors.CodexCredential(idToken, "access", "refresh", 3600, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := llm.Manage(ctx, mgmt, cpa.ManagementURL("/auth-files?name="+url.QueryEscape(name)), http.MethodPost, cred, nil); err != nil {
		t.Fatalf("upload credential: %v", err)
	}

	var conn llm.Connection
	waitFor(t, func() bool {
		for _, c := range service.Connections() {
			if c.Connector == "codex" {
				conn = c
				return true
			}
		}
		return false
	})
	if conn.Label != "dev@example.com" || conn.Plan != "plus" || conn.State != llm.StateActive {
		t.Fatalf("connection = %+v", conn)
	}

	var models []llm.Model
	waitFor(t, func() bool {
		models = service.Models()
		return len(models) > 0
	})
	for _, m := range models {
		if m.Connector != "codex" || !m.Available {
			t.Fatalf("model = %+v", m)
		}
	}
	for _, m := range models {
		t.Logf("model %s %q ctx=%d", m.ID, m.DisplayName, m.ContextWindow)
	}

	// /v1 serves only requests the runtime gateway attributed to an agent.
	listModels := func(agent string) *http.Response {
		req, _ := http.NewRequest("GET", base+"/v1/models", nil)
		if agent != "" {
			req.Header.Set(cpa.AgentHeader, agent)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	unattributed := listModels("")
	unattributed.Body.Close()
	if unattributed.StatusCode != http.StatusUnauthorized {
		t.Fatalf("/v1/models without an agent: %d", unattributed.StatusCode)
	}
	res := listModels("agent")
	var list struct {
		Data []struct{ ID string } `json:"data"`
	}
	_ = json.NewDecoder(res.Body).Decode(&list)
	res.Body.Close()
	if len(list.Data) == 0 {
		t.Fatal("/v1/models is empty after adding a codex credential")
	}

	// Disable, then delete through the management API.
	if _, err := service.SetEnabled(ctx, conn.ID, false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	waitFor(t, func() bool {
		for _, m := range service.Models() {
			if m.Available {
				return false
			}
		}
		return true
	})
	if err := service.Delete(ctx, conn.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	waitFor(t, func() bool { return len(service.Connections()) == 0 })
	for _, m := range service.Models() {
		if m.Available || m.Unavailable == nil || m.Unavailable.Code != "NO_CONNECTION" {
			t.Fatalf("model after delete = %+v", m)
		}
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
