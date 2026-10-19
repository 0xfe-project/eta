package gateway

import (
	"encoding/json"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// codes.json is what the TypeScript side (LLM_CODES) is checked against.
func TestCodesMatchTheSharedList(t *testing.T) {
	raw, err := os.ReadFile("../codes.json")
	if err != nil {
		t.Fatal(err)
	}
	var shared []string
	if err := json.Unmarshal(raw, &shared); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(shared, Codes) {
		t.Fatalf("codes.json = %v, Codes = %v", shared, Codes)
	}
	seen := map[string]bool{}
	for _, c := range Codes {
		if seen[c] {
			t.Errorf("duplicate code %q", c)
		}
		seen[c] = true
	}
}

// Every Code constant is in Codes, and nothing else is.
func TestEveryCodeConstantIsListed(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "codes.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var declared []string
	ast.Inspect(file, func(n ast.Node) bool {
		spec, ok := n.(*ast.ValueSpec)
		if !ok || !strings.HasPrefix(spec.Names[0].Name, "Code") {
			return true
		}
		lit, ok := spec.Values[0].(*ast.BasicLit)
		if !ok {
			return true
		}
		value, _ := strconv.Unquote(lit.Value)
		declared = append(declared, value)
		return true
	})
	if !slices.Equal(declared, Codes) {
		t.Fatalf("constants = %v, Codes = %v", declared, Codes)
	}
}

func listed(t *testing.T, p *Problem) *Problem {
	t.Helper()
	if p == nil {
		t.Fatal("no problem")
	}
	if !slices.Contains(Codes, p.Code) {
		t.Errorf("code %q is not in Codes", p.Code)
	}
	if p.Message == "" || strings.ContainsFunc(p.Message, func(r rune) bool { return r > 0x2e7f }) {
		t.Errorf("%s: the diagnostic must be English text, got %q", p.Code, p.Message)
	}
	return p
}

func TestConnectionReasonsCarryCodesAndParams(t *testing.T) {
	cases := []struct {
		name   string
		conn   Connection
		apiKey bool
		code   string
		params Params
	}{
		{"login", Connection{State: StateNeedsLogin}, false, CodeLoginExpired, Params{"provider": "Codex"}},
		{"api key", Connection{State: StateNeedsLogin}, true, CodeInvalidAPIKey, Params{"provider": "Codex"}},
		{"quota", Connection{State: StateRateLimited}, false, CodeQuotaExhausted, Params{"provider": "Codex"}},
		{"refused", Connection{State: StateError, Error: problem(CodeUpstreamError, "x", "status", 403)}, false, CodeUpstreamError, Params{"provider": "Codex", "status": 403}},
		{"disabled", Connection{State: StateDisabled}, false, CodeAccountDisabled, Params{"provider": "Codex"}},
		{"none", Connection{State: "missing"}, false, CodeNoConnection, Params{"provider": "Codex"}},
	}
	for _, c := range cases {
		got := listed(t, connectionReason("Codex", c.apiKey, c.conn))
		if got.Code != c.code || len(got.Params) != len(c.params) {
			t.Errorf("%s: %+v", c.name, got)
		}
		for k, v := range c.params {
			if got.Params[k] != v {
				t.Errorf("%s: param %s = %v, want %v", c.name, k, got.Params[k], v)
			}
		}
	}
}

func TestModelFailuresCarryCodes(t *testing.T) {
	now := time.Now()
	later := now.Add(time.Minute)
	for _, c := range []struct {
		name   string
		state  *coreauth.ModelState
		code   string
		status any
	}{
		{"disabled", &coreauth.ModelState{Status: coreauth.StatusDisabled}, CodeModelDisabled, nil},
		{"quota", &coreauth.ModelState{Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 429}}, CodeModelQuotaExhausted, nil},
		{"forbidden", &coreauth.ModelState{Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 403}}, CodeModelForbidden, 403},
		{"not found", &coreauth.ModelState{Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 404}}, CodeModelNotFound, nil},
		{"5xx", &coreauth.ModelState{Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{HTTPStatus: 502}}, CodeUpstreamUnstable, 502},
		{"timeout", &coreauth.ModelState{Unavailable: true, NextRetryAfter: later, LastError: &coreauth.Error{Message: "timeout"}}, CodeUpstreamUnreachable, nil},
	} {
		a := &coreauth.Auth{ID: "a", ModelStates: map[string]*coreauth.ModelState{"m": c.state}}
		_, reason, _ := modelStatus(a, Connection{State: StateActive}, "m", "Codex", false, now)
		got := listed(t, reason)
		if got.Code != c.code || got.Params["status"] != c.status {
			t.Errorf("%s: %+v", c.name, got)
		}
	}
}

func TestCheckErrorsCarryCodes(t *testing.T) {
	rejectedLogin := &UserError{Code: CodeLoginExpired, Message: "x"}
	for _, c := range []struct {
		err    error
		apiKey bool
		code   string
	}{
		{rejectedLogin, false, CodeLoginExpired},
		{&UserError{Code: CodeInvalidAPIKey, Message: "x"}, true, CodeInvalidAPIKey},
		{errors.New("down"), false, CodeCheckFailed},
		{&UserError{Code: CodeUsageUnavailable, Message: "x"}, false, CodeCheckFailed},
	} {
		if got := listed(t, checkError(c.err, c.apiKey)); got.Code != c.code {
			t.Errorf("%v: %s", c.err, got.Code)
		}
	}
	if checkError(nil, false) != nil {
		t.Error("a check that worked has no error")
	}
}

type errorEnvelope struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Params    Params `json:"params"`
		RequestID string `json:"request_id"`
	} `json:"error"`
}

func TestManagementRefusalsCarryCodes(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	api := Admin(nil, logger)
	call := func(method, path, body string) (int, errorEnvelope) {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("X-Request-Id", "req-1")
		rec := httptest.NewRecorder()
		api.ServeHTTP(rec, req)
		var env errorEnvelope
		_ = json.Unmarshal(rec.Body.Bytes(), &env)
		return rec.Code, env
	}
	for _, c := range []struct {
		name, method, path, body string
		status                   int
		code                     string
	}{
		{"unknown route", "GET", "/api/llm/v1/nothing", "", http.StatusNotFound, CodeNotFound},
		{"bad patch", "PATCH", "/api/llm/v1/connections/a", `{}`, http.StatusUnprocessableEntity, CodeInvalidRequest},
		{"bad login", "POST", "/api/llm/v1/logins", `{}`, http.StatusUnprocessableEntity, CodeInvalidRequest},
		{"bad input", "POST", "/api/llm/v1/logins/x/input", `nope`, http.StatusUnprocessableEntity, CodeInvalidRequest},
	} {
		status, env := call(c.method, c.path, c.body)
		if status != c.status || env.Error.Code != c.code || env.Error.RequestID != "req-1" {
			t.Errorf("%s: %d %+v", c.name, status, env)
		}
		if !slices.Contains(Codes, env.Error.Code) {
			t.Errorf("%s: unlisted code", c.name)
		}
	}

	h := handler{logger: logger}
	for _, c := range []struct {
		name   string
		err    error
		status int
		code   string
		params Params
	}{
		{"not found", ErrNotFound, http.StatusNotFound, CodeNotFound, nil},
		{"unsupported", ErrUnsupported, http.StatusConflict, CodeUnsupported, nil},
		{"user error", &UserError{Code: CodeLoginStartFailed, Message: "x", Params: Params{"provider": "Codex"}}, http.StatusFailedDependency, CodeLoginStartFailed, Params{"provider": "Codex"}},
		{"anything else", errors.New("boom"), http.StatusFailedDependency, CodeGatewayUnavailable, nil},
	} {
		rec := httptest.NewRecorder()
		h.error(rec, httptest.NewRequest("GET", "/api/llm/v1/x", nil), c.err)
		var env errorEnvelope
		_ = json.Unmarshal(rec.Body.Bytes(), &env)
		if rec.Code != c.status || env.Error.Code != c.code || len(env.Error.Params) != len(c.params) {
			t.Errorf("%s: %d %+v", c.name, rec.Code, env)
		}
		for k, v := range c.params {
			if env.Error.Params[k] != v {
				t.Errorf("%s: param %s", c.name, k)
			}
		}
		if strings.Contains(env.Error.Message, "boom") {
			t.Errorf("%s: raw error leaked: %q", c.name, env.Error.Message)
		}
	}
}
