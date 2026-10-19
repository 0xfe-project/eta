# Setting up the grok bundle

The bundle needs `grok-api` on the PATH of the machine the session runs on. eta installs
nothing; tell the user what to run and wait for them to do it.

1. Download the release archive for the machine from
   <https://github.com/AkaraChen/grok-api/releases> (version 0.1.1, for example
   `grok-api-x86_64-unknown-linux-gnu.tar.gz`), together with the release's `SHA256SUMS`.
2. Check it: `grep " <archive>$" SHA256SUMS | sha256sum -c -` (`shasum -a 256 -c` on macOS).
   Do not use an archive that does not match.
3. Unpack `grok-api` onto the PATH (for example `~/.local/bin`) and check
   `grok-api --version`.

There is no key to create. The tools use the Grok account of eta's LLM gateway, with a key
eta gives this agent itself. If the tools fail with an authorization or account error, Grok is
not signed in: ask the user to sign in under settings → Model services → subscriptions.

Sessions that were open pick the change up at their next message.
