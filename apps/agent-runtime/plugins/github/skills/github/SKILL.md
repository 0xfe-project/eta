---
name: github
description: Working with GitHub repositories in AXP. Use when cloning, pushing, creating a repository, opening or merging a pull request, or working with issues, pull requests or CI with gh.
---

# GitHub

`git` over `https://github.com/...` and `gh` are already logged in through
AXP's GitHub App, which the user connects and installs in AXP's settings,
under “连接”. `gh auth status` names who you act as:

- **the user** (their login), once they authorized the App: what you do
  shows as theirs, with the App's badge. You can do what both the user and
  the App can, in the accounts the App is installed on: push, open, review
  and merge pull requests, create repositories in their account
  (`gh repo create owner/name --private`), change settings, manage issues
  and CI.
- **the App's bot** (`<app>[bot]`) otherwise. It can do what the App was
  granted in the repositories it was installed on, but GitHub does not let
  it create a repository in a personal account (“Resource not accessible
  by integration (createRepository)”): ask the user to authorize the App
  under “连接”, or to create the repository.

Commits are authored by the App's bot either way.

To open a pull request, push the branch and call `open_pull_request`, not
`gh pr create`; give the user its link.

If gh is not logged in, a tool says GitHub is not connected, or GitHub
answers that a repository is not found, GitHub is not connected yet or the
App may not access that repository: tell the user to finish the setup in the
settings under “连接”; do not look for other credentials.
