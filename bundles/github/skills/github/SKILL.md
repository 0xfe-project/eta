---
name: github
description: Working with GitHub repositories. Use when cloning, pushing, creating a repository, opening or merging a pull request, or working with issues, pull requests or CI.
---

# GitHub

Two ways in, and they are separate:

- **`gh` and `git` in the shell** use the login of the machine this session runs on
  (`gh auth status` says who). Use them for anything on disk: clone, branch, commit,
  push, `gh pr create`, `gh run watch`.
- **The `github__*` tools** (GitHub's MCP server) use the access token the user set in
  eta's settings → Bundles → github. Use them to read and change things on GitHub itself:
  issues, pull requests and their reviews, repositories, workflow runs, code search.

If the `github__*` tools are missing, the token is not set or `github-mcp-server` is not
installed on this machine; read [references/setup.md](references/setup.md) and walk the
user through it. Do not look for other credentials and never ask the user to paste a token
into the chat: it goes in the settings page.

If `gh` says it is not logged in, ask the user to run `gh auth login` on this machine.

Keep pull requests small and say what changed and how to check it. Do not say an issue
exists, or give a number, unless GitHub returned one.
