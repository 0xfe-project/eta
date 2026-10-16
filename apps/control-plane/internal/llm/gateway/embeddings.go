package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/llm/gateway/cpa"
	"github.com/akarachen/axp/apps/control-plane/internal/llm/gateway/usage"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	sdkusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

// EmbeddingProvider is the CPA provider whose credentials embed: Google AI
// Studio's API keys.
const EmbeddingProvider = "gemini"

// geminiURL is Google's API when a credential names no base URL.
const geminiURL = "https://generativelanguage.googleapis.com"

// Google takes up to this many inputs in one batchEmbedContents.
const embedBatch = 100

// EmbeddingModels are the models POST /v1/embeddings serves. Both take
// outputDimensionality 128 to 3072.
var EmbeddingModels = []struct{ ID, DisplayName string }{
	{"gemini-embedding-001", "Gemini Embedding 001"},
	{"gemini-embedding-2-preview", "Gemini Embedding 2 Preview"},
}

func embeddingModel(id string) bool {
	for _, m := range EmbeddingModels {
		if m.ID == id {
			return true
		}
	}
	return false
}

// EmbeddingModel is an entry of GET /api/llm/v1/embedding-models.
type EmbeddingModel struct {
	ID          string           `json:"id"`
	DisplayName string           `json:"display_name"`
	Status      string           `json:"status"`
	Available   bool             `json:"available"`
	Reason      *ConnectionError `json:"reason,omitempty"`
	RetryAt     *time.Time       `json:"retry_at,omitempty"`
}

// EmbeddingModels is each embedding model's status: the best of the Google
// AI Studio accounts', as for the chat models.
func (s *Service) EmbeddingModels() []EmbeddingModel {
	now := s.now()
	const name = "Google AI Studio"
	var auths []*coreauth.Auth
	for _, a := range s.auths.List() {
		if strings.EqualFold(a.Provider, EmbeddingProvider) {
			auths = append(auths, a)
		}
	}
	out := make([]EmbeddingModel, 0, len(EmbeddingModels))
	for _, em := range EmbeddingModels {
		m := EmbeddingModel{ID: em.ID, DisplayName: em.DisplayName, Status: ModelUnavailable,
			Reason: &ConnectionError{"NO_CONNECTION", "尚未绑定 " + name + " 账号。"}}
		for _, a := range auths {
			state, reason, retryAt := modelStatus(a, normalize(a, EmbeddingProvider, now), em.ID, name, now)
			if modelRank(state) > modelRank(m.Status) || m.Reason != nil && m.Reason.Code == "NO_CONNECTION" {
				m.Status, m.Reason, m.RetryAt = state, reason, retryAt
			}
		}
		m.Available = m.Status != ModelUnavailable
		out = append(out, m)
	}
	return out
}

// embedCandidates are the accounts that may embed with model now, the
// healthy ones first, then the oldest.
func (s *Service) embedCandidates(model string) []*coreauth.Auth {
	now := s.now()
	type candidate struct {
		a    *coreauth.Auth
		rank int
	}
	var out []candidate
	for _, a := range s.auths.List() {
		if !strings.EqualFold(a.Provider, EmbeddingProvider) || a.Attributes["api_key"] == "" {
			continue
		}
		state, _, _ := modelStatus(a, normalize(a, EmbeddingProvider, now), model, "", now)
		if state == ModelUnavailable {
			continue
		}
		out = append(out, candidate{a, modelRank(state)})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].rank != out[j].rank {
			return out[i].rank > out[j].rank
		}
		return out[i].a.CreatedAt.Before(out[j].a.CreatedAt)
	})
	auths := make([]*coreauth.Auth, len(out))
	for i, c := range out {
		auths[i] = c.a
	}
	return auths
}

// embedRequest is OpenAI's POST /v1/embeddings body.
type embedRequest struct {
	Model          string          `json:"model"`
	Input          json.RawMessage `json:"input"`
	Dimensions     *int            `json:"dimensions"`
	EncodingFormat string          `json:"encoding_format"`
}

type embeddingData struct {
	Object    string    `json:"object"`
	Index     int       `json:"index"`
	Embedding []float64 `json:"embedding"`
}

// Embeddings is OpenAI's POST /v1/embeddings over Google's own
// batchEmbedContents, with a Google AI Studio account: Google's
// OpenAI-compatible endpoint does not say it honours dimensions, which
// memory's vector tables are made for. It is for the agent X-AXP-Agent-Id
// names, whose usage it books.
func Embeddings(s *Service, book *usage.Book, client *http.Client, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		agent := strings.TrimSpace(r.Header.Get(cpa.AgentHeader))
		if agent == "" {
			openAIError(w, http.StatusUnauthorized, "authentication_error", "unauthenticated", "X-AXP-Agent-Id is required")
			return
		}
		var req embedRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(&req); err != nil {
			openAIError(w, http.StatusBadRequest, "invalid_request_error", "invalid_json", "the body is not valid JSON")
			return
		}
		inputs, ok := embedInputs(req.Input)
		switch {
		case !embeddingModel(req.Model):
			openAIError(w, http.StatusBadRequest, "invalid_request_error", "model_not_found", fmt.Sprintf("model %q does not embed", req.Model))
			return
		case !ok:
			openAIError(w, http.StatusBadRequest, "invalid_request_error", "invalid_input", "input must be a non-empty string or array of strings")
			return
		case req.EncodingFormat != "" && req.EncodingFormat != "float":
			openAIError(w, http.StatusBadRequest, "invalid_request_error", "unsupported_encoding_format", "only encoding_format float is supported")
			return
		case req.Dimensions != nil && (*req.Dimensions < 128 || *req.Dimensions > 3072):
			openAIError(w, http.StatusBadRequest, "invalid_request_error", "invalid_dimensions", "dimensions must be between 128 and 3072")
			return
		}
		e := embedder{s: s, book: book, client: client, logger: logger, agent: agent, model: req.Model, dims: req.Dimensions}
		data := make([]embeddingData, 0, len(inputs))
		tokens := 0
		for start := 0; start < len(inputs); start += embedBatch {
			batch := inputs[start:min(start+embedBatch, len(inputs))]
			vectors, n, fail := e.embed(r.Context(), batch)
			if fail != nil {
				if fail.retryAfter > 0 {
					w.Header().Set("Retry-After", strconv.Itoa(int(fail.retryAfter.Seconds())))
				}
				openAIError(w, fail.status, fail.kind, fail.code, fail.message)
				return
			}
			for i, v := range vectors {
				data = append(data, embeddingData{"embedding", start + i, v})
			}
			tokens += n
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"object": "list",
			"data":   data,
			"model":  req.Model,
			"usage":  map[string]int{"prompt_tokens": tokens, "total_tokens": tokens},
		})
	})
}

func embedInputs(raw json.RawMessage) ([]string, bool) {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return []string{one}, one != ""
	}
	var many []string
	if json.Unmarshal(raw, &many) != nil || len(many) == 0 {
		return nil, false
	}
	for _, s := range many {
		if s == "" {
			return nil, false
		}
	}
	return many, true
}

type embedder struct {
	s      *Service
	book   *usage.Book
	client *http.Client
	logger *slog.Logger
	agent  string
	model  string
	dims   *int
}

// embedFailure is a request's failure, as OpenAI's error.
type embedFailure struct {
	status     int
	kind, code string
	message    string
	retryAfter time.Duration
}

// embed embeds one batch with the first account that takes it: an account
// that rejects the key or is out of quota is marked as CPA marks it and the
// next one is tried.
func (e embedder) embed(ctx context.Context, inputs []string) ([][]float64, int, *embedFailure) {
	candidates := e.s.embedCandidates(e.model)
	if len(candidates) == 0 {
		return nil, 0, e.noAccount()
	}
	var last *embedFailure
	for _, a := range candidates {
		vectors, tokens, status, err := e.call(ctx, a, inputs)
		failed := err != nil
		e.book.HandleUsage(ctx, sdkusage.Record{
			APIKey: e.agent, AuthID: a.ID, Provider: EmbeddingProvider, Model: e.model, RequestedAt: time.Now(),
			Failed: failed, Detail: sdkusage.Detail{InputTokens: int64(tokens), TotalTokens: int64(tokens)},
		})
		if !failed {
			e.s.auths.MarkResult(ctx, coreauth.Result{AuthID: a.ID, Provider: a.Provider, Model: e.model, Success: true})
			return vectors, tokens, nil
		}
		if ctx.Err() != nil {
			return nil, 0, &embedFailure{499, "server_error", "cancelled", "the request was cancelled", 0}
		}
		e.logger.Warn("Embedding failed", "account", a.ID, "model", e.model, "status", status, "error", err)
		result := coreauth.Result{AuthID: a.ID, Provider: a.Provider, Model: e.model,
			Error: &coreauth.Error{Message: err.Error(), HTTPStatus: status, Retryable: status == 0 || status == 429 || status >= 500}}
		switch {
		case status == http.StatusBadRequest || status == http.StatusNotFound:
			// The request's, not the account's.
			return nil, 0, &embedFailure{http.StatusBadRequest, "invalid_request_error", "upstream_rejected", err.Error(), 0}
		case status == http.StatusUnauthorized || status == http.StatusForbidden:
			e.s.auths.MarkResult(ctx, result)
			last = e.noAccount()
		case status == http.StatusTooManyRequests:
			e.s.auths.MarkResult(ctx, result)
			last = &embedFailure{http.StatusTooManyRequests, "rate_limit_error", "rate_limited", "Google AI Studio is rate limiting every account", time.Minute}
		default:
			e.s.auths.MarkResult(ctx, result)
			last = &embedFailure{http.StatusBadGateway, "server_error", "upstream_error", "Google AI Studio failed: " + err.Error(), 0}
		}
	}
	return nil, 0, last
}

func (e embedder) noAccount() *embedFailure {
	return &embedFailure{http.StatusServiceUnavailable, "server_error", "no_account",
		"no usable Google AI Studio account: connect one in the model services", 0}
}

// call is one batchEmbedContents with account a: the vectors, the tokens
// they took (counted by Google, else estimated) and the HTTP status of a
// failure.
func (e embedder) call(ctx context.Context, a *coreauth.Auth, inputs []string) ([][]float64, int, int, error) {
	type part struct {
		Text string `json:"text"`
	}
	type content struct {
		Parts []part `json:"parts"`
	}
	type request struct {
		Model                string  `json:"model"`
		Content              content `json:"content"`
		OutputDimensionality *int    `json:"outputDimensionality,omitempty"`
	}
	reqs := make([]request, len(inputs))
	for i, text := range inputs {
		reqs[i] = request{"models/" + e.model, content{[]part{{text}}}, e.dims}
	}
	body, _ := json.Marshal(map[string]any{"requests": reqs})
	base := strings.TrimRight(a.Attributes["base_url"], "/")
	if base == "" {
		base = geminiURL
	}
	endpoint := base + "/v1beta/models/" + url.PathEscape(e.model) + ":batchEmbedContents"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, 0, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", a.Attributes["api_key"])
	res, err := e.client.Do(req)
	if err != nil {
		return nil, 0, 0, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 256<<20))
	if res.StatusCode != http.StatusOK {
		return nil, 0, res.StatusCode, fmt.Errorf("HTTP %d: %s", res.StatusCode, upstreamMessage(raw))
	}
	var out struct {
		Embeddings []struct {
			Values []float64 `json:"values"`
		} `json:"embeddings"`
		UsageMetadata struct {
			PromptTokenCount int `json:"promptTokenCount"`
		} `json:"usageMetadata"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, 0, http.StatusBadGateway, fmt.Errorf("unreadable response: %w", err)
	}
	if len(out.Embeddings) != len(inputs) {
		return nil, 0, http.StatusBadGateway, fmt.Errorf("%d embeddings for %d inputs", len(out.Embeddings), len(inputs))
	}
	vectors := make([][]float64, len(inputs))
	for i, emb := range out.Embeddings {
		if e.dims != nil && len(emb.Values) != *e.dims {
			return nil, 0, http.StatusBadGateway, fmt.Errorf("%d dimensions, not %d", len(emb.Values), *e.dims)
		}
		vectors[i] = emb.Values
	}
	tokens := out.UsageMetadata.PromptTokenCount
	if tokens == 0 {
		tokens = estimateTokens(inputs)
	}
	return vectors, tokens, 0, nil
}

// estimateTokens is about 4 bytes of UTF-8 a token: Google's
// batchEmbedContents does not say what it counted.
func estimateTokens(inputs []string) int {
	n := 0
	for _, s := range inputs {
		n += (len(s) + 3) / 4
	}
	return n
}

func upstreamMessage(raw []byte) string {
	var body struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &body) == nil && body.Error.Message != "" {
		return body.Error.Message
	}
	msg := strings.TrimSpace(string(raw))
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

// openAIError writes OpenAI's error envelope.
func openAIError(w http.ResponseWriter, status int, kind, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"message": message, "type": kind, "code": code}})
}
