/**
 * The host's command line as words: the flags of a run and what `--help` says about them.
 *
 * Apart from `main.ts` because `eta-host upgrade` reads the same flags out of an installed service
 * to know which port to ask.
 */
import type { ParseArgsConfig } from "node:util";

/** The flags of a run, and of `install-service`, which keeps them for its runs. */
export const RUN_OPTIONS = {
  port: { type: "string", default: "8787" },
  host: { type: "string", default: "127.0.0.1" },
  "web-dir": { type: "string" },
  "token-file": { type: "string" },
  "allow-origin": { type: "string", multiple: true },
  "memory-url": { type: "string" },
  "public-url": { type: "string" },
  "no-llm": { type: "boolean", default: false },
  // The GitHub chain is opt-in; `--no-github` overrides an environment that turns it on.
  github: { type: "boolean", default: false },
  "no-github": { type: "boolean", default: false },
  // web_fetch and web_search are on; the search runs on the host's own SearXNG unless given one.
  "no-web": { type: "boolean", default: false },
  "searxng-url": { type: "string" },
  version: { type: "boolean", default: false },
  // With --version: the build as JSON, with the oldest desktop app its page works in.
  json: { type: "boolean", default: false },
  // What the build carries, for the `eta-host upgrade` that is about to run it. Not in the usage.
  migrations: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} satisfies NonNullable<ParseArgsConfig["options"]>;

export const USAGE = `Usage:
  eta-host [flags]                    run the host
  eta-host install-service [flags]    run it with these flags at login, and now
  eta-host uninstall-service          remove that service; the data stays
  eta-host upgrade [version]          replace this file with a release (eta-host upgrade --help)
  eta-host --version [--json]         print the build
  eta-host --help                     print this

Flags:
  --port <n>              port, default 8787 (0 picks any free port)
  --host <addr>           interface to bind, default 127.0.0.1; tailscale is this computer's
                          tailnet address. Anything beyond loopback asks for a token
  --web-dir <dir>         built web to serve instead of the page inside this file
  --token-file <path>     turn the token gate on with this file (created if missing)
  --allow-origin <o>      another page origin that may open the socket, repeatable
  --public-url <url>      the address the browser reaches this host at
  --memory-url <url>      the memory sidecar
  --github                load the GitHub chain
  --no-github             do not, whatever the environment says
  --no-llm                do not load the LLM gateway
  --no-web                do not give agents web_fetch and web_search
  --searxng-url <url>     the SearXNG web_search asks

The data directory is $HOME/.eta.
`;

/** What the parser said, without its advice about `--`; the usage is printed after it. */
export const parseFailure = (error: unknown): string =>
  error instanceof Error
    ? (error.message.split(". ")[0] ?? error.message)
    : String(error);
