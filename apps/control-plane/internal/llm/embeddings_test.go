package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/llm/gateway"
	"github.com/akarachen/axp/apps/control-plane/internal/llm/gateway/cpa"
)

// google is a fake of Google's batchEmbedContents: every vector's first
// value is its text's length, so the order of the answers shows.
type google struct {
	*httptest.Server
	mu       sync.Mutex
	requests []map[string]any
	keys     []string
	// status, when set, is every answer's.
	status int
}

func newGoogle(t *testing.T) *google {
	g := &google{}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Requests []struct {
				Model   string `json:"model"`
				Content struct {
					Parts []struct{ Text string } `json:"parts"`
				} `json:"content"`
				OutputDimensionality int `json:"outputDimensionality"`
			} `json:"requests"`
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		var logged map[string]any
		_ = json.Unmarshal(raw, &logged)
		g.mu.Lock()
		g.requests = append(g.requests, map[string]any{"path": r.URL.Path, "body": logged})
		g.keys = append(g.keys, r.Header.Get("x-goog-api-key"))
		status := g.status
		g.mu.Unlock()
		if status != 0 {
			http.Error(w, `{"error":{"message":"nope"}}`, status)
			return
		}
		var out []map[string]any
		for _, req := range body.Requests {
			dims := req.OutputDimensionality
			if dims == 0 {
				dims = 3072
			}
			v := make([]float64, dims)
			v[0] = float64(len(req.Content.Parts[0].Text))
			out = append(out, map[string]any{"values": v})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"embeddings": out})
	}))
	t.Cleanup(g.Close)
	return g
}

// TestEmbeddings: POST /v1/embeddings is OpenAI's, served by Google's own
// API with a Google AI Studio key, booked to the agent.
func TestEmbeddings(t *testing.T) {
	f := shared
	ctx := context.Background()
	up := newGoogle(t)

	// No account yet: the models say so, and the API refuses.
	var models []gateway.EmbeddingModel
	getJSON(t, f.public.URL+"/api/llm/v1/embedding-models", &models)
	if len(models) != 2 || models[0].Available || models[0].Reason == nil || models[0].Reason.Code != "NO_CONNECTION" {
		t.Fatalf("embedding models without an account = %+v", models)
	}
	res := v1(t, f, "POST", "/v1/embeddings", "agent-e", `{"model":"gemini-embedding-001","input":"hi"}`)
	if res.StatusCode != http.StatusServiceUnavailable || openAICode(t, res) != "no_account" {
		t.Fatalf("without an account: %d", res.StatusCode)
	}

	body, _ := json.Marshal([]map[string]any{{"api-key": "g-key", "base-url": up.URL}})
	if err := gateway.Manage(ctx, f.m.proxy.Management(), cpa.ManagementURL("/gemini-api-key"), http.MethodPut, body, nil); err != nil {
		t.Fatalf("add Gemini key: %v", err)
	}
	waitFor(t, func() bool {
		getJSON(t, f.public.URL+"/api/llm/v1/embedding-models", &models)
		return models[0].Available && models[1].Available
	})

	t.Run("OpenAI's shape, in input order", func(t *testing.T) {
		res := v1(t, f, "POST", "/v1/embeddings", "agent-e",
			`{"model":"gemini-embedding-001","input":["a","bbb","cc"],"dimensions":768,"encoding_format":"float"}`)
		raw, _ := io.ReadAll(res.Body)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%d %s", res.StatusCode, raw)
		}
		var out struct {
			Object string `json:"object"`
			Model  string `json:"model"`
			Data   []struct {
				Object    string    `json:"object"`
				Index     int       `json:"index"`
				Embedding []float64 `json:"embedding"`
			} `json:"data"`
			Usage struct {
				PromptTokens int `json:"prompt_tokens"`
				TotalTokens  int `json:"total_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		if out.Object != "list" || out.Model != "gemini-embedding-001" || len(out.Data) != 3 {
			t.Fatalf("response = %s", raw)
		}
		for i, want := range []float64{1, 3, 2} {
			d := out.Data[i]
			if d.Object != "embedding" || d.Index != i || len(d.Embedding) != 768 || d.Embedding[0] != want {
				t.Fatalf("data[%d] = %v %d %d %v", i, d.Object, d.Index, len(d.Embedding), d.Embedding[0])
			}
		}
		if out.Usage.PromptTokens == 0 || out.Usage.TotalTokens != out.Usage.PromptTokens {
			t.Fatalf("usage = %+v", out.Usage)
		}
		up.mu.Lock()
		last := up.requests[len(up.requests)-1]
		key := up.keys[len(up.keys)-1]
		up.mu.Unlock()
		if last["path"] != "/v1beta/models/gemini-embedding-001:batchEmbedContents" || key != "g-key" {
			t.Fatalf("upstream request = %v (key %q)", last, key)
		}
		reqs := last["body"].(map[string]any)["requests"].([]any)
		first := reqs[0].(map[string]any)
		if len(reqs) != 3 || first["model"] != "models/gemini-embedding-001" || first["outputDimensionality"] != float64(768) {
			t.Fatalf("upstream body = %v", last["body"])
		}
		// Booked to the agent, on the account, under the model.
		waitFor(t, func() bool {
			for _, u := range f.m.book.Report(time.Now()) {
				if u.Principal == "agent-e" && u.Windows["5h"].Requests >= 1 && u.Windows["5h"].TotalTokens > 0 &&
					u.Models[0].Name == "gemini-embedding-001" {
					return true
				}
			}
			return false
		})
	})

	t.Run("a single string", func(t *testing.T) {
		res := v1(t, f, "POST", "/v1/embeddings", "agent-e", `{"model":"gemini-embedding-2-preview","input":"hello"}`)
		raw, _ := io.ReadAll(res.Body)
		if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), `"index":0`) {
			t.Fatalf("%d %s", res.StatusCode, raw)
		}
	})

	t.Run("refusals", func(t *testing.T) {
		for _, c := range []struct {
			agent, body string
			status      int
			code        string
		}{
			{"", `{"model":"gemini-embedding-001","input":"x"}`, 401, "unauthenticated"},
			{"agent-e", `{"model":"gemini-embedding-001","input":"x","encoding_format":"base64"}`, 400, "unsupported_encoding_format"},
			{"agent-e", `{"model":"gpt-test","input":"x"}`, 400, "model_not_found"},
			{"agent-e", `{"model":"gemini-embedding-001","input":[]}`, 400, "invalid_input"},
			{"agent-e", `{"model":"gemini-embedding-001","input":"x","dimensions":64}`, 400, "invalid_dimensions"},
		} {
			res := v1(t, f, "POST", "/v1/embeddings", c.agent, c.body)
			if res.StatusCode != c.status || openAICode(t, res) != c.code {
				t.Errorf("%s as %q: %d", c.body, c.agent, res.StatusCode)
			}
		}
	})

	t.Run("a rejected key is the account's", func(t *testing.T) {
		up.mu.Lock()
		up.status = http.StatusUnauthorized
		up.mu.Unlock()
		res := v1(t, f, "POST", "/v1/embeddings", "agent-e", `{"model":"gemini-embedding-001","input":"x"}`)
		if res.StatusCode != http.StatusServiceUnavailable || openAICode(t, res) != "no_account" {
			t.Fatalf("after a 401: %d", res.StatusCode)
		}
		getJSON(t, f.public.URL+"/api/llm/v1/embedding-models", &models)
		if models[0].Available {
			t.Fatalf("model after a 401 = %+v", models[0])
		}
		var failed int64
		for _, u := range f.m.book.Report(time.Now()) {
			if u.Principal == "agent-e" {
				failed = u.Windows["5h"].Failed
			}
		}
		if failed == 0 {
			t.Fatal("the failure was not booked")
		}
	})

	// Leave no Gemini account behind for the other tests.
	if err := gateway.Manage(ctx, f.m.proxy.Management(), cpa.ManagementURL("/gemini-api-key"), http.MethodPut, []byte("[]"), nil); err != nil {
		t.Fatal(err)
	}
}

func openAICode(t *testing.T, res *http.Response) string {
	t.Helper()
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("not OpenAI's error: %v", err)
	}
	if body.Error.Type == "" || body.Error.Message == "" {
		t.Fatalf("error = %+v", body.Error)
	}
	return body.Error.Code
}
