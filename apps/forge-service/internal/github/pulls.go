package github

// Pull requests a task delivered, for the task's detail: their state and
// size, and merging one when the user asks to.
//
// Both act as the user who authorized the App, so GitHub applies the user's
// own permissions, and as the App without an authorization. Merging never
// asks GitHub to bypass anything: no admin override, no auto-merge, no
// branch deletion; it names the head commit the user saw, so a pull request
// updated since is not merged.

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	gh "github.com/google/go-github/v92/github"
)

// Pull is a pull request as the task's detail shows it.
type Pull struct {
	URL       string `json:"url"`
	Title     string `json:"title"`
	State     string `json:"state"` // open, draft, merged, closed
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	// HeadSHA is the commit the user sees; merging names it.
	HeadSHA string `json:"head_sha"`
	// Merge tells whether it can be merged now: ready, pending while GitHub
	// still computes it, or blocked, with Reason. Empty unless open.
	Merge  string `json:"merge,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// ParsePullURL returns owner, name and number from a pull request's URL on
// github.com.
func ParsePullURL(value string) (string, string, int, error) {
	u, err := url.Parse(strings.TrimSpace(value))
	invalid := newError("INVALID_PULL_REQUEST", http.StatusBadRequest, "%s 不是 GitHub 的 PR 链接。", value)
	if err != nil || u.Hostname() != "github.com" {
		return "", "", 0, invalid
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 4 || parts[2] != "pull" {
		return "", "", 0, invalid
	}
	number, err := strconv.Atoi(parts[3])
	if err != nil || number <= 0 || parts[0] == "" || parts[1] == "" {
		return "", "", 0, invalid
	}
	return parts[0], parts[1], number, nil
}

// pullClient is who reads and merges: the user who authorized the App, or
// the App. A token GitHub refuses (401) is forgotten and the App is used.
func (g *GitHub) pullClient(ctx context.Context, owner string, retry bool) (*gh.Client, bool, error) {
	if !retry {
		if user := g.userToken(ctx); user != nil {
			return g.client(gh.WithAuthToken(user.AccessToken)), true, nil
		}
	}
	inst, err := g.installationFor(ctx, owner)
	if err != nil {
		return nil, false, err
	}
	t, err := g.token(ctx, inst.GetID())
	if err != nil {
		return nil, false, err
	}
	return g.client(gh.WithAuthToken(t.value)), false, nil
}

// PullRequest reads a pull request's state now.
func (g *GitHub) PullRequest(ctx context.Context, pullURL string) (*Pull, error) {
	owner, name, number, err := ParsePullURL(pullURL)
	if err != nil {
		return nil, err
	}
	_, pull, repo, err := g.readAs(ctx, owner, name, number)
	if err != nil {
		return nil, err
	}
	return view(pull, repo), nil
}

// readAs reads the pull request and its repository with pullClient's
// client, which it returns for what comes next.
func (g *GitHub) readAs(ctx context.Context, owner, name string, number int) (*gh.Client, *gh.PullRequest, *gh.Repository, error) {
	if _, err := g.require(); err != nil {
		return nil, nil, nil, err
	}
	client, asUser, err := g.pullClient(ctx, owner, false)
	if err != nil {
		return nil, nil, nil, err
	}
	pull, repo, err := readPull(ctx, client, owner, name, number)
	if asUser && statusOf(err) == http.StatusUnauthorized {
		g.dropUser()
		if client, _, err = g.pullClient(ctx, owner, true); err != nil {
			return nil, nil, nil, err
		}
		pull, repo, err = readPull(ctx, client, owner, name, number)
	}
	if err != nil {
		return nil, nil, nil, readError(err)
	}
	return client, pull, repo, nil
}

func readPull(ctx context.Context, client *gh.Client, owner, name string, number int) (*gh.PullRequest, *gh.Repository, error) {
	pull, _, err := client.PullRequests.Get(ctx, owner, name, number)
	if err != nil {
		return nil, nil, err
	}
	repo, _, err := client.Repositories.Get(ctx, owner, name)
	return pull, repo, err
}

func readError(err error) error {
	switch statusOf(err) {
	case http.StatusNotFound, http.StatusForbidden:
		return newError("PULL_REQUEST_UNREACHABLE", http.StatusFailedDependency,
			"GitHub 上看不到这个 PR：App 或你的账号没有这个仓库的权限，或 PR 已不存在。")
	}
	return fromGitHub(err)
}

func view(pull *gh.PullRequest, repo *gh.Repository) *Pull {
	p := &Pull{
		URL: pull.GetHTMLURL(), Title: pull.GetTitle(), State: pull.GetState(),
		Additions: pull.GetAdditions(), Deletions: pull.GetDeletions(), HeadSHA: pull.GetHead().GetSHA(),
	}
	switch {
	case pull.GetMerged():
		p.State = "merged"
		return p
	case p.State != "open":
		p.State = "closed"
		return p
	case pull.GetDraft():
		p.State = "draft"
		p.Merge, p.Reason = "blocked", "草稿 PR 不能合并，请先在 GitHub 上标为可审阅。"
		return p
	}
	p.Merge, p.Reason = mergeability(pull, repo)
	return p
}

// mergeability is whether GitHub would merge pull now, as far as its
// mergeable_state tells; GitHub computes it in the background, so it may
// not be known yet.
func mergeability(pull *gh.PullRequest, repo *gh.Repository) (string, string) {
	if perms := repo.GetPermissions(); perms != nil && perms.Push != nil && !perms.GetPush() && !perms.GetMaintain() && !perms.GetAdmin() {
		return "blocked", "没有这个仓库的写权限，不能合并。"
	}
	if mergeMethod(repo) == "" && repo.AllowMergeCommit != nil {
		return "blocked", "仓库没有允许任何合并方式。"
	}
	switch state := pull.GetMergeableState(); {
	case pull.Mergeable == nil || state == "unknown" || state == "":
		return "pending", "GitHub 还在计算能否合并，稍后刷新。"
	case !pull.GetMergeable() || state == "dirty":
		return "blocked", "有冲突，需要先解决。"
	case state == "blocked":
		return "blocked", "分支保护的要求还没满足（审批或必需的检查）。"
	case state == "behind":
		return "blocked", "分支落后于目标分支，需要先更新。"
	}
	// clean, unstable (checks that are not required failed), has_hooks.
	return "ready", ""
}

// mergeMethod is the repository's merge method AXP uses: squash, a merge
// commit or rebase, the first the repository allows. Empty when GitHub does
// not say (the token cannot see the settings): GitHub's default then.
func mergeMethod(repo *gh.Repository) string {
	switch {
	case repo.GetAllowSquashMerge():
		return "squash"
	case repo.GetAllowMergeCommit():
		return "merge"
	case repo.GetAllowRebaseMerge():
		return "rebase"
	}
	return ""
}

// MergePullRequest merges a pull request if its head is still headSHA, with
// the repository's merge method. When the answer is lost (GitHub
// unreachable, timing out or failing), it reads the pull request again
// instead of retrying: merged at headSHA is success, anything else is
// MERGE_UNKNOWN. Either way the result is the pull request now.
func (g *GitHub) MergePullRequest(ctx context.Context, pullURL, headSHA string) (*Pull, error) {
	owner, name, number, err := ParsePullURL(pullURL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(headSHA) == "" {
		return nil, newError("INVALID_REQUEST", http.StatusBadRequest, "缺少要合并的提交。")
	}
	// The user leaving does not cut a merge short.
	ctx = context.WithoutCancel(ctx)
	client, pull, repo, err := g.readAs(ctx, owner, name, number)
	if err != nil {
		return nil, err
	}
	now := view(pull, repo)
	switch {
	case now.State == "merged":
		return nil, newError("ALREADY_MERGED", http.StatusConflict, "这个 PR 已经合并了。")
	case now.HeadSHA != headSHA:
		return nil, staleHead()
	case now.Merge == "blocked":
		return nil, newError("NOT_MERGEABLE", http.StatusConflict, "%s", now.Reason)
	case now.State == "closed":
		return nil, newError("NOT_MERGEABLE", http.StatusConflict, "PR 已关闭，不能合并。")
	}
	// pending: GitHub decides.
	_, _, err = client.PullRequests.Merge(ctx, owner, name, number, "", &gh.PullRequestOptions{
		SHA: headSHA, MergeMethod: mergeMethod(repo),
	})
	if err == nil {
		return g.mergedPull(ctx, client, owner, name, number, now)
	}
	status := statusOf(err)
	switch {
	case status == http.StatusConflict || (status == http.StatusUnprocessableEntity && strings.Contains(strings.ToLower(reasons(err)), "sha")):
		return nil, staleHead()
	case status == http.StatusForbidden || status == http.StatusNotFound:
		return nil, newError("MERGE_FORBIDDEN", http.StatusForbidden, "GitHub 拒绝合并：没有权限（%s）。", reasons(err))
	case status == http.StatusMethodNotAllowed || status == http.StatusUnprocessableEntity:
		return nil, newError("NOT_MERGEABLE", http.StatusConflict, "GitHub 拒绝合并：%s", reasons(err))
	case status == http.StatusUnauthorized:
		return nil, newError("MERGE_FORBIDDEN", http.StatusForbidden, "GitHub 不认这次的授权，没有合并。")
	}
	// No answer, or GitHub failed: it may have merged all the same.
	check, _, readErr := client.PullRequests.Get(ctx, owner, name, number)
	if readErr == nil && check.GetMerged() && check.GetHead().GetSHA() == headSHA {
		return view(check, repo), nil
	}
	return nil, newError("MERGE_UNKNOWN", http.StatusFailedDependency,
		"没有得到 GitHub 的合并结果，GitHub 上暂时也没显示已合并。请刷新确认后再决定是否重试。")
}

// mergedPull is the pull request after GitHub merged it; reading it again
// failing is no reason to report the merge as failed.
func (g *GitHub) mergedPull(ctx context.Context, client *gh.Client, owner, name string, number int, before *Pull) (*Pull, error) {
	if pull, _, err := client.PullRequests.Get(ctx, owner, name, number); err == nil && pull.GetMerged() {
		return view(pull, nil), nil
	}
	merged := *before
	merged.State, merged.Merge, merged.Reason = "merged", "", ""
	return &merged, nil
}

func staleHead() error {
	return newError("STALE_HEAD", http.StatusConflict, "PR 在你查看之后又有了新提交，没有合并。请刷新后再确认。")
}
