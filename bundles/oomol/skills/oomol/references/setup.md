# Setting up the oomol bundle

The bundle needs `node` and `oo` on the PATH of the machine the session runs on, and the
user's OOMOL key and team name. eta installs nothing; tell the user what to run and wait
for them to do it.

1. `oo`: install OOMOL's CLI from <https://oomol.com> (its page for the `oo` command line)
   and check `oo --version`. Do not run `oo install` for the agent: it syncs OOMOL's skills
   into `~/.agents`, which is the user's call.
2. The key: on <https://oomol.com/install/mcp/> generate an API key. The configuration shown
   there also names the team (`x-oo-team-name`).
3. Paste both in eta's settings → Bundles → oomol. They are stored encrypted and given only
   to the MCP server process (and the `oo` it starts), never to the shell. When OOMOL resets
   the key, paste the new one there.

Sessions that were open pick the change up at their next message.
