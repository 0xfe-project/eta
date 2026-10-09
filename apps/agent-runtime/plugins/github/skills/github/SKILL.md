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

## Attachments

If attachments are needed, create the PR first, then try the customer's local
GitHub CLI with its existing login and `--attach`, for example:

```sh
gh pr edit <PR-URL> --attach './before.png#Before' --attach './after.png#After'
```

Run this where the image files exist, preserve the PR's current body, and use
plain `gh` rather than `axp gh` for uploads. If App tokens are injected through
`GH_TOKEN` or `GITHUB_TOKEN`, use `env -u GH_TOKEN -u GITHUB_TOKEN gh ...` for
this command to use the local login. If the CLI, `--attach`, or login is
unavailable, report it and keep the PR. Check the PR after an upload attempt
before retrying, since a failure can still leave some attachments uploaded.
