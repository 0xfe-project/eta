---
name: github
description: Working with GitHub repositories in AXP. Use when cloning, pushing, opening a pull request, or reading issues, pull requests or CI with gh.
---

# GitHub

You act on GitHub as AXP's GitHub App, which the user connects and installs
in the AXP workspace's “能力” page. Credentials are already set up:

- `git clone`, `git fetch` and `git push` over `https://github.com/...` just
  work for repositories the App may access. Commits in GitHub repositories
  are made as the App's bot.
- `gh` works for reading (pull requests, issues, checks, runs, files). Do not
  use it to write anything: such commands are refused.

To propose a change:

1. Commit on a new branch, never on the default branch.
2. `git push -u origin <branch>`.
3. Open the pull request with the `open_pull_request` tool, not
   `gh pr create`, and give the user its link.

Pushing to the default branch, `main` or `master` needs the user's approval:
the push is blocked with instructions to call `request_approval`.

If git or a tool says GitHub is not connected, or the App cannot access a
repository, tell the user to finish the setup in the “能力” page; do not
look for other credentials.
