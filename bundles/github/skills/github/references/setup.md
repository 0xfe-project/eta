# Setting up the github bundle

The bundle needs three commands on the machine the session runs on (settings → Bundles
shows which machine lacks which): `git`, `gh` and `github-mcp-server`. eta installs
nothing; tell the user what to run and wait for them to do it.

1. `git` and `gh`: from the system package manager, or <https://cli.github.com>.
   Then `gh auth login`.
2. `github-mcp-server`: a release binary from
   <https://github.com/github/github-mcp-server/releases>. Pick the archive for the
   machine's OS and architecture, check it against the release's checksums, and put the
   binary on the PATH (for example `~/.local/bin`). `github-mcp-server --version` should
   answer.
3. The access token: create a personal access token
   (<https://github.com/settings/personal-access-tokens>), limited to the repositories the
   agent should reach, and paste it in eta's settings → Bundles → github. It is stored
   encrypted and given only to the MCP server process, never to the shell.

Sessions that were open pick the change up at their next message.
