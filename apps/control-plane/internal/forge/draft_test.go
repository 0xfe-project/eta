package forge

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

func TestIssueDraftPrefillsGitHubsNewIssuePage(t *testing.T) {
	body := "## 复现\n1. 打开「设置」\n2. 输入 `a & b = c?` #12 100%+1\n\n> 引用"
	draft, err := newIssueDraft(draftIssueIn{
		Repository: "git@github.com:akarachen/axp.git", Title: "  卡片 & 链接 #1  ", Body: body,
	})
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(draft.URL)
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme != "https" || u.Host != "github.com" || u.Path != "/akarachen/axp/issues/new" {
		t.Fatalf("url: %s", draft.URL)
	}
	if strings.Contains(u.RawQuery, "+") {
		t.Fatalf("spaces as +: %s", u.RawQuery)
	}
	q := u.Query()
	if q.Get("title") != "卡片 & 链接 #1" || q.Get("body") != body || draft.Body != "" {
		t.Fatalf("query: %v, body: %q", q, draft.Body)
	}
	if draft.Repository != "akarachen/axp" {
		t.Fatalf("repository: %s", draft.Repository)
	}
}

func TestIssueDraftLeavesATooLongBodyToPaste(t *testing.T) {
	body := strings.Repeat("很长的正文。\n", 1000)
	draft, err := newIssueDraft(draftIssueIn{Repository: "akarachen/axp", Title: "长", Body: body})
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(draft.URL)
	if len(draft.URL) > maxDraftURL || u.Query().Has("body") || draft.Body != body {
		t.Fatalf("url %d chars, body kept: %v", len(draft.URL), draft.Body == body)
	}
}

func TestIssueDraftRefusesWhatIsNotAGitHubRepository(t *testing.T) {
	for _, repository := range []string{
		"", "axp", "a/b/c", "https://evil.example/a/b", "a b/c", "a/b?x=1", "a/b#c", "../b", "a/..", "javascript:alert(1)/x",
	} {
		if _, err := newIssueDraft(draftIssueIn{Repository: repository, Title: "t"}); err == nil {
			t.Errorf("%q: no error", repository)
		}
	}
	for _, in := range []draftIssueIn{
		{Repository: "a/b", Title: "  "},
		{Repository: "a/b", Title: strings.Repeat("长", 257)},
		{Repository: "a/b", Title: "t", Body: strings.Repeat("x", 65537)},
	} {
		if _, err := newIssueDraft(in); err == nil {
			t.Errorf("%.20q: no error", in.Title)
		}
	}
}

// Drafting writes nothing to GitHub, so it works before the App is connected.
func TestDraftIssueNeedsNoGitHub(t *testing.T) {
	e := newEnv(t)
	result := e.callTool("draft_issue", map[string]any{"repository": "akarachen/axp", "title": "Bug", "body": "坏了"})
	var draft map[string]any
	if err := json.Unmarshal([]byte(text(result)), &draft); err != nil || result.IsError {
		t.Fatalf("result: %v", text(result))
	}
	want := "https://github.com/akarachen/axp/issues/new?body=%E5%9D%8F%E4%BA%86&title=Bug"
	if draft["url"] != want {
		t.Fatalf("url: %v", draft["url"])
	}
	// The transcript offers to file it; it is not an issue yet.
	if ref := result.Meta["axp/ref"]; fmt.Sprint(ref) != "map[kind:issue_draft title:Bug url:"+want+"]" {
		t.Fatalf("ref: %v", ref)
	}
	bad := e.callTool("draft_issue", map[string]any{"repository": "https://evil.example/a/b", "title": "x"})
	if !bad.IsError {
		t.Fatalf("bad repository: %v", text(bad))
	}
}
