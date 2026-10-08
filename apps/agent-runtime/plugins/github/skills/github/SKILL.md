---
name: github
description: Working with GitHub repositories in AXP. Use when cloning, pushing, opening a pull request, or working with issues, pull requests or CI with gh.
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
