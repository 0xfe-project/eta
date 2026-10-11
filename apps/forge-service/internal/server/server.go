// Package server is the forge service's HTTP surface, for runtimes under
// /forge and for the browser under /api/forge.
//
// The runtime gateway authenticates the runtime and sets X-AXP-Agent-Id;
// routes under /forge require it. The browser's gateway forwards /api/forge,
// where the user connects the GitHub App.
//
//	/forge/mcp                  MCP (streamable HTTP): open_pull_request
//	/forge/credentials          GET: gh's token (the user's once they authorized
//	                            the App, else the App's) and the commit identity
//
//	/api/forge/v1/github                          GET status (?fresh=1), DELETE
//	/api/forge/v1/github/manifest                 POST {name, organization?, origin}
//	/api/forge/v1/github/manifest/callback        GitHub's redirect after creation
//	/api/forge/v1/github/oauth-client             POST {client_id, client_secret}
//	/api/forge/v1/github/authorization            POST {origin} → {url}, DELETE
//	/api/forge/v1/github/authorization/callback   GitHub's redirect after authorizing
//	/api/forge/v1/pulls?url=                      GET a task's pull request now
//	/api/forge/v1/pulls/merge                     POST {url, head_sha}: merge it
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/akarachen/axp/apps/forge-service/internal/github"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	agentHeader = "X-AXP-Agent-Id"
	// Settings → 连接 on the home page.
	connections = "/?settings=connections"
)

// New returns the service's handler.
func New(gh *github.GitHub, logger *slog.Logger) http.Handler {
	s := &server{gh: gh, logger: logger}
	mux := http.NewServeMux()
	mux.Handle("/forge/", requireAgent(s.runtime()))
	mux.HandleFunc("GET /api/forge/v1/github", s.status)
	mux.HandleFunc("DELETE /api/forge/v1/github", s.forget)
	mux.HandleFunc("POST /api/forge/v1/github/manifest", s.manifest)
	mux.HandleFunc("GET /api/forge/v1/github/manifest/callback", s.callback)
	mux.HandleFunc("POST /api/forge/v1/github/oauth-client", s.oauthClient)
	mux.HandleFunc("POST /api/forge/v1/github/authorization", s.authorize)
	mux.HandleFunc("DELETE /api/forge/v1/github/authorization", s.unauthorize)
	mux.HandleFunc("GET "+github.CallbackPath, s.authorized)
	mux.HandleFunc("GET /api/forge/v1/pulls", s.pull)
	mux.HandleFunc("POST /api/forge/v1/pulls/merge", s.merge)
	mux.HandleFunc("GET /up", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

type server struct {
	gh     *github.GitHub
	logger *slog.Logger
	// The pull requests being merged, so a second click does not race the
	// first.
	merging sync.Map
}

// requireAgent admits only requests the runtime gateway authenticated.
func requireAgent(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(agentHeader) == "" {
			writeError(w, &github.Error{Code: "UNAUTHENTICATED", Message: "unauthenticated", Status: http.StatusUnauthorized})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) runtime() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/forge/mcp", s.mcp())
	mux.HandleFunc("GET /forge/credentials", s.credentials)
	return mux
}

type openPullRequestIn struct {
	Repository string `json:"repository" jsonschema:"\"owner/name\" or the remote URL (git remote get-url origin)"`
	Head       string `json:"head" jsonschema:"the pushed branch"`
	Title      string `json:"title"`
	Body       string `json:"body,omitempty"`
	Base       string `json:"base,omitempty" jsonschema:"defaults to the repository's default branch"`
	Draft      bool   `json:"draft,omitempty"`
}

func (s *server) mcp() http.Handler {
	srv := mcp.NewServer(&mcp.Implementation{Name: "forge"}, nil)
	mcp.AddTool(srv, &mcp.Tool{
		Name: "open_pull_request",
		Description: "Open a GitHub pull request through AXP's GitHub App.\n\n" +
			"Push the branch first. repository is \"owner/name\" or the remote URL " +
			"(`git remote get-url origin`); head is the pushed branch; base defaults " +
			"to the repository's default branch. If a pull request for head is " +
			"already open, it is returned instead. Use it instead of `gh pr create`.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in openPullRequestIn) (*mcp.CallToolResult, *github.PullRequest, error) {
		pull, err := s.gh.OpenPullRequest(ctx, in.Repository, in.Head, in.Title, in.Body, in.Base, in.Draft)
		if err != nil {
			// The agent sees the message as the tool's error.
			return nil, nil, errors.New(message(err))
		}
		// Names the pull request for the transcript to link to: AXP tools put
		// the one thing they made in their result's _meta "axp/ref"
		// (apps/agent-runtime/src/items.ts).
		// An open one found instead keeps the title it has on GitHub.
		ref := map[string]any{"kind": "pull_request", "number": pull.Number, "url": pull.URL}
		if pull.Created {
			ref["title"] = in.Title
		}
		return &mcp.CallToolResult{Meta: mcp.Meta{"axp/ref": ref}}, pull, nil
	})
	return mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, &mcp.StreamableHTTPOptions{
		Stateless:    true,
		JSONResponse: true,
		// Reached through the runtime gateway under its own host name; the
		// network is the trust boundary.
		DisableLocalhostProtection: true,
	})
}

// credentials are the same for agents in runtimes and for remote computers
// (the control plane asks as computer-<id>, for `axp gh`).
func (s *server) credentials(w http.ResponseWriter, r *http.Request) {
	s.answer(w, func() (any, error) { return s.gh.Credentials(r.Context()) })
}

func (s *server) status(w http.ResponseWriter, r *http.Request) {
	s.answer(w, func() (any, error) { return s.gh.Status(r.Context(), r.URL.Query().Get("fresh") == "1") })
}

func (s *server) forget(w http.ResponseWriter, r *http.Request) {
	if err := s.gh.Forget(r.Context()); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) manifest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name         string `json:"name"`
		Organization string `json:"organization"`
		Origin       string `json:"origin"`
	}
	if !decode(w, r, &body) {
		return
	}
	s.answer(w, func() (any, error) {
		return s.gh.StartManifest(body.Name, strings.TrimSpace(body.Organization), body.Origin)
	})
}

// callback is GitHub sending the browser back after the App was created; the
// browser goes on to Settings → 连接, with what happened.
func (s *server) callback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	target := back("github", "created")
	if _, err := s.gh.FinishManifest(r.Context(), q.Get("code"), q.Get("state")); err != nil {
		s.logger.Warn("creating the GitHub App failed", "error", err)
		target = back("github_error", message(err))
	}
	http.Redirect(w, r, target, http.StatusSeeOther)
}

func (s *server) oauthClient(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := s.gh.SetOAuthClient(body.ClientID, body.ClientSecret); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) authorize(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Origin string `json:"origin"`
	}
	if !decode(w, r, &body) {
		return
	}
	s.answer(w, func() (any, error) {
		target, err := s.gh.StartAuthorization(body.Origin)
		return map[string]string{"url": target}, err
	})
}

func (s *server) unauthorize(w http.ResponseWriter, r *http.Request) {
	if err := s.gh.ForgetUser(r.Context()); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// back is Settings → 连接, told what happened.
func back(key, value string) string {
	return connections + "&" + url.Values{key: {value}}.Encode()
}

// authorized is GitHub sending the browser back after the user authorized
// the App, from the wizard or right after installing it.
func (s *server) authorized(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	target := back("github", "authorized")
	var err error
	switch {
	case q.Get("error") != "":
		// Declined, or GitHub could not ask.
		err = &github.Error{Code: "AUTHORIZATION_DECLINED", Message: "没有完成授权：" + q.Get("error_description")}
	case q.Get("code") != "":
		_, err = s.gh.FinishAuthorization(r.Context(), q.Get("code"), q.Get("state"), q.Get("setup_action"))
	case q.Get("setup_action") != "":
		target = back("setup_action", q.Get("setup_action"))
	default:
		err = &github.Error{Code: "AUTHORIZATION_EXPIRED", Message: "这次授权已失效，请回到 AXP 重新授权。"}
	}
	if err != nil {
		s.logger.Warn("authorizing the GitHub App failed", "error", err)
		target = back("github_error", message(err))
	}
	http.Redirect(w, r, target, http.StatusSeeOther)
}

func (s *server) pull(w http.ResponseWriter, r *http.Request) {
	s.answer(w, func() (any, error) { return s.gh.PullRequest(r.Context(), r.URL.Query().Get("url")) })
}

func (s *server) merge(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL     string `json:"url"`
		HeadSHA string `json:"head_sha"`
	}
	if !decode(w, r, &body) {
		return
	}
	if _, busy := s.merging.LoadOrStore(body.URL, true); busy {
		writeError(w, &github.Error{Code: "MERGE_IN_PROGRESS", Message: "这个 PR 正在合并。", Status: http.StatusConflict})
		return
	}
	defer s.merging.Delete(body.URL)
	s.answer(w, func() (any, error) {
		pull, err := s.gh.MergePullRequest(r.Context(), body.URL, body.HeadSHA)
		if err == nil {
			s.logger.Info("merged a pull request", "url", body.URL, "head_sha", body.HeadSHA)
		}
		return pull, err
	})
}

// answer writes what produce returns as JSON, or its error.
func (s *server) answer(w http.ResponseWriter, produce func() (any, error)) {
	value, err := produce()
	if err != nil {
		s.fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func (s *server) fail(w http.ResponseWriter, err error) {
	var forgeErr *github.Error
	if errors.As(err, &forgeErr) {
		writeError(w, forgeErr)
		return
	}
	s.logger.Error("forge request failed", "error", err)
	writeError(w, &github.Error{Code: "INTERNAL", Message: "代码托管服务出错。", Status: http.StatusInternalServerError})
}

// message is what the user or agent is told about err.
func message(err error) string {
	var forgeErr *github.Error
	if errors.As(err, &forgeErr) {
		return forgeErr.Message
	}
	return "代码托管服务出错，请稍后再试。"
}

func writeError(w http.ResponseWriter, e *github.Error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.Status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": e.Code, "message": e.Message}})
}

func decode(w http.ResponseWriter, r *http.Request, into any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(into); err != nil {
		writeError(w, &github.Error{Code: "INVALID_REQUEST", Message: "请求格式不对。", Status: http.StatusBadRequest})
		return false
	}
	return true
}
