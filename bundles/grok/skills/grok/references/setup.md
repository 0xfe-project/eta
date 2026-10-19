# Setting up the grok bundle

The bundle needs `grok-api` on the PATH of the machine the session runs on, and an xAI API
key. eta installs nothing; tell the user what to run and wait for them to do it.

1. Download the release archive for the machine from
   <https://github.com/AkaraChen/grok-api/releases> (for example
   `grok-api-x86_64-unknown-linux-gnu.tar.gz`), together with the release's `SHA256SUMS`.
2. Check it: `grep " <archive>$" SHA256SUMS | sha256sum -c -` (`shasum -a 256 -c` on macOS).
   Do not use an archive that does not match.
3. Unpack `grok-api` onto the PATH (for example `~/.local/bin`) and check
   `grok-api --version`.
4. Create an API key in the xAI console (<https://console.x.ai>) and paste it in eta's
   settings → Bundles → grok. It is stored encrypted and given only to the MCP server
   process, never to the shell.

Sessions that were open pick the change up at their next message.
