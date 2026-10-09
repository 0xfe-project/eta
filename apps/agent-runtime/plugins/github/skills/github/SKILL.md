---
name: github
description: Working with GitHub repositories in AXP. Use when cloning, pushing, opening a pull request, adding screenshots, or working with issues, pull requests or CI with gh.
---

# GitHub

You act on GitHub as AXP's GitHub App, which the user connects and installs
in the AXP workspace's “能力” page. `git` over `https://github.com/...` and
`gh` are already logged in as the App; commits in GitHub repositories are
made as the App's bot.

To open a pull request, push the branch and call `open_pull_request`, not
`gh pr create`; give the user its link.

If gh is not logged in, a tool says GitHub is not connected, or GitHub
answers that a repository is not found, GitHub is not connected yet or the
App may not access that repository: tell the user to finish the setup in the
“能力” page; do not look for other credentials.

## Screenshots and attachments after creating a PR

Create the PR as the App first. `open_pull_request` has no attachments
parameter. If screenshots are needed, you may then try the customer's local
GitHub CLI, if available, with its existing local login. This is an explicit
exception to the App-only credential guidance above for uploading attachments
to that PR. Use plain `gh`, not `axp gh`, which injects an App installation
token that GitHub's native attachment endpoint currently rejects.

Run these commands on the customer's computer where both `gh` and the actual
screenshot files are accessible. A file in a remote agent's `/tmp` must first
be transferred to that computer using an available file-transfer mechanism;
a path alone does not transfer the image. Do not send local paths to forge.

Check `command -v gh`, `gh pr edit --help` for `--attach`, and the local login
with `gh auth status --hostname github.com`. If the runtime injects
`GH_TOKEN` or `GITHUB_TOKEN`, unset them only for these local commands using
`env -u GH_TOKEN -u GITHUB_TOKEN gh ...`, so they use the customer's stored
login. Do not print tokens, change global authentication, or search for other
credentials. If the CLI, flag, or login is unavailable, report that attachment
upload could not be attempted; keep the already-created PR and its link.

For an existing PR, fetch its current body and add local image references to
that body in a temporary file. For example, after setting `PR_URL` to the
returned PR URL and transferring `before.png` and `after.png` into the current
directory on the customer's computer:

```sh
PR_BODY=$(mktemp) || exit 1
if gh pr view "$PR_URL" --json body --jq .body > "$PR_BODY"; then
  cat >> "$PR_BODY" <<'MARKDOWN'

### Screenshots

![Before: login form showing the error](./before.png)
![After: login form showing the corrected state](./after.png)
MARKDOWN
  gh pr edit "$PR_URL" --body-file "$PR_BODY" \
    --attach ./before.png --attach ./after.png
fi
rm -f "$PR_BODY"
```

Use the same local-login environment for every `gh` command in this example.
Read the existing body before adding images, preserve its content, and check
for screenshots already present. GitHub CLI replaces matching local image
references with actual uploaded GitHub URLs and keeps their alt text. An
attachment without a matching reference is appended; its alt text can be set
with `--attach './after.png#After: corrected login form'`. Repeat `--attach`
for multiple images. Images must meet GitHub's supported types and 10 MB limit.

After the attempt, read the PR body again and verify the uploaded URLs and
visible images. A nonzero exit can still leave some uploads and body edits
completed. Report successful URLs and failed files; inspect the current PR
before retrying only missing files. For an interrupted or unknown result,
reconcile the PR first rather than replaying all uploads or creating a new PR.
If authentication or permission is rejected, report the failure without
repeated attempts or automatically logging in as another account. Local GH
CLI upload is best effort, not guaranteed by AXP's App connection.

See [GitHub's attachment guide](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli)
for supported commands and Markdown replacement behavior.
