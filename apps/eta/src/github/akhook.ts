import type { ConfigInput } from "@eta/plugin-akhook";

/**
 * The host's own akhook rules for GitHub (the rules of the original `akhook.yml`, the one that
 * mattered here): a pull request is opened with the `open_pull_request` tool, as the App and with
 * the transcript's card, not with `gh pr create`. It is a host layer, so neither the user's file
 * nor a project's `.akhook.yml` can disable or replace it, and it travels to daemons' sessions
 * with the other host layers.
 *
 * Rules guard against mistakes, not against an agent set on getting around them: whatever must
 * never happen is enforced by credentials instead.
 */
export const GITHUB_AKHOOK: Extract<ConfigInput, { text: string }> = {
  name: "eta:github",
  text: `version: 1
rules:
  - id: gh-pr-create
    on: shell_exec
    checks:
      - argv: [gh, pr, create]
    message: 推送分支后用 open_pull_request 工具开 PR。
`,
};
