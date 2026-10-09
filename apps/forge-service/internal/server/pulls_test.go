package server

import (
	"net/url"
	"testing"
)

// openPull opens a pull request on akarachen/notes as the App and returns
// its URL and number.
func (e *env) openPull(branch string, draft bool) (string, int) {
	e.t.Helper()
	_, credentials := e.credentials()
	emulator.push(e.t, token(credentials), "akarachen/notes", branch)
	pull := e.pull(map[string]any{"repository": "akarachen/notes", "head": branch, "title": "Change " + branch, "draft": draft})
	// As on github.com, where the task's deliverable links to.
	u, _ := url.Parse(pull["url"].(string))
	return "https://github.com" + u.Path, int(pull["number"].(float64))
}

func (e *env) pullState(pullURL string) (int, map[string]any) {
	e.t.Helper()
	status, out, _ := e.do("GET", "/api/forge/v1/pulls?url="+url.QueryEscape(pullURL), false, nil)
	return status, out
}

func (e *env) merge(pullURL, sha string) (int, map[string]any) {
	e.t.Helper()
	status, out, _ := e.do("POST", "/api/forge/v1/pulls/merge", false, map[string]any{"url": pullURL, "head_sha": sha})
	return status, out
}

func TestAPullRequestsStateAndMerge(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	pullURL, _ := e.openPull("merge-me", false)

	status, pull := e.pullState(pullURL)
	if status != 200 || pull["state"] != "open" || pull["merge"] != "ready" || pull["title"] != "Change merge-me" {
		t.Fatalf("pull: %d %v", status, pull)
	}
	if _, ok := pull["additions"].(float64); !ok {
		t.Fatalf("additions: %v", pull)
	}
	sha := pull["head_sha"].(string)

	// What the user saw is not the head any more: nothing is merged.
	status, out := e.merge(pullURL, "0000000000000000000000000000000000000000")
	if status != 409 || errorCode(out) != "STALE_HEAD" {
		t.Fatalf("stale: %d %v", status, out)
	}
	if _, pull = e.pullState(pullURL); pull["state"] != "open" {
		t.Fatalf("merged after a stale head: %v", pull)
	}

	status, out = e.merge(pullURL, sha)
	if status != 200 || out["state"] != "merged" {
		t.Fatalf("merge: %d %v", status, out)
	}
	if _, pull = e.pullState(pullURL); pull["state"] != "merged" || pull["merge"] != nil {
		t.Fatalf("after merging: %v", pull)
	}
	status, out = e.merge(pullURL, sha)
	if status != 409 || errorCode(out) != "ALREADY_MERGED" {
		t.Fatalf("again: %d %v", status, out)
	}
}

func TestGitHubRefusingAStaleHead(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	pullURL, number := e.openPull("pushed-again", false)
	_, pull := e.pullState(pullURL)
	emulator.failMerge("akarachen/notes", number, faultStale)
	status, out := e.merge(pullURL, pull["head_sha"].(string))
	if status != 409 || errorCode(out) != "STALE_HEAD" {
		t.Fatalf("merge: %d %v", status, out)
	}
	if _, pull = e.pullState(pullURL); pull["state"] != "open" {
		t.Fatalf("pull: %v", pull)
	}
}

func TestAMergeWhoseAnswerIsLostIsCheckedOnGitHub(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	pullURL, number := e.openPull("answer-lost", false)
	_, pull := e.pullState(pullURL)
	emulator.failMerge("akarachen/notes", number, faultLost)
	status, out := e.merge(pullURL, pull["head_sha"].(string))
	if status != 200 || out["state"] != "merged" {
		t.Fatalf("merge: %d %v", status, out)
	}
}

func TestAFailedMergeIsReportedAsUnknownWithoutRetrying(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	pullURL, number := e.openPull("github-failed", false)
	_, pull := e.pullState(pullURL)
	emulator.failMerge("akarachen/notes", number, faultFailed)
	status, out := e.merge(pullURL, pull["head_sha"].(string))
	if status != 424 || errorCode(out) != "MERGE_UNKNOWN" {
		t.Fatalf("merge: %d %v", status, out)
	}
	if _, pull = e.pullState(pullURL); pull["state"] != "open" {
		t.Fatalf("pull: %v", pull)
	}
}

func TestADraftCannotBeMerged(t *testing.T) {
	e := newEnv(t)
	e.connect("installed-app")
	pullURL, _ := e.openPull("draft", true)
	_, pull := e.pullState(pullURL)
	if pull["state"] != "draft" || pull["merge"] != "blocked" || pull["reason"] == "" {
		t.Fatalf("pull: %v", pull)
	}
	status, out := e.merge(pullURL, pull["head_sha"].(string))
	if status != 409 || errorCode(out) != "NOT_MERGEABLE" {
		t.Fatalf("merge: %d %v", status, out)
	}
}

func TestPullRequestsThatCannotBeRead(t *testing.T) {
	e := newEnv(t)
	status, out := e.pullState("https://github.com/akarachen/notes/pull/1")
	if status != 409 || errorCode(out) != "GITHUB_NOT_CONNECTED" {
		t.Fatalf("not connected: %d %v", status, out)
	}
	e.connect("installed-app")
	for _, bad := range []string{"https://gitlab.com/a/b/pull/1", "https://github.com/a/b/issues/1", "https://github.com/a/b/pull/x"} {
		if status, out := e.pullState(bad); status != 400 || errorCode(out) != "INVALID_PULL_REQUEST" {
			t.Fatalf("%s: %d %v", bad, status, out)
		}
	}
	// Not granted to the App, or not there.
	for _, missing := range []string{"https://github.com/akarachen/secret/pull/1", "https://github.com/akarachen/notes/pull/999"} {
		if status, out := e.pullState(missing); status != 424 || errorCode(out) != "PULL_REQUEST_UNREACHABLE" {
			t.Fatalf("%s: %d %v", missing, status, out)
		}
	}
	if status, out := e.merge("https://github.com/akarachen/notes/pull/999", "abc"); status != 424 {
		t.Fatalf("merge missing: %d %v", status, out)
	}
}
