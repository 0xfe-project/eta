package forge

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/akarachen/axp/apps/control-plane/internal/github"
)

// An issue draft is an issue the user files themself: GitHub's new-issue
// page with the title and body filled in, for when the agent may not create
// it. Nothing is written to GitHub and nothing is kept.

type draftIssueIn struct {
	Repository string `json:"repository" jsonschema:"\"owner/name\" or the remote URL"`
	Title      string `json:"title"`
	Body       string `json:"body,omitempty" jsonschema:"in Markdown"`
}

type issueDraft struct {
	Repository string `json:"repository"`
	Title      string `json:"title"`
	// The new-issue page, prefilled.
	URL string `json:"url"`
	// Set when the body would make the link too long for browsers and
	// GitHub: the link fills in the title only, and the user pastes this.
	Body string `json:"body,omitempty"`
}

// GitHub's owner and repository names; anything else is not a repository a
// link may point into.
var repoName = regexp.MustCompile(`^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`)

// maxDraftURL is how long a prefilled link may get: GitHub answers longer
// ones with an error page.
const maxDraftURL = 8000

// GitHub's limits on an issue's title and body, in characters.
const (
	maxIssueTitle = 256
	maxIssueBody  = 65536
)

func newIssueDraft(in draftIssueIn) (*issueDraft, error) {
	owner, name, err := github.ParseRepository(in.Repository)
	if err != nil {
		return nil, errors.New(message(err))
	}
	repository := owner + "/" + name
	if !repoName.MatchString(repository) || strings.Contains(repository, "..") {
		return nil, errors.New("无法识别仓库 " + in.Repository + "，请写成 owner/name。")
	}
	title := strings.TrimSpace(in.Title)
	switch {
	case title == "":
		return nil, errors.New("缺少标题。")
	case utf8.RuneCountInString(title) > maxIssueTitle:
		return nil, errors.New("标题太长：GitHub issue 标题最多 256 个字符。")
	case utf8.RuneCountInString(in.Body) > maxIssueBody:
		return nil, errors.New("正文太长：GitHub issue 正文最多 65536 个字符。")
	}
	link := func(fields url.Values) string {
		// %20 rather than +, which not every reader takes for a space.
		query := strings.ReplaceAll(fields.Encode(), "+", "%20")
		return "https://github.com/" + repository + "/issues/new?" + query
	}
	fields := url.Values{"title": {title}}
	if in.Body != "" {
		fields.Set("body", in.Body)
	}
	draft := &issueDraft{Repository: repository, Title: title, URL: link(fields)}
	if len(draft.URL) > maxDraftURL {
		fields.Del("body")
		// A title GitHub takes always fits.
		draft.URL, draft.Body = link(fields), in.Body
	}
	return draft, nil
}
