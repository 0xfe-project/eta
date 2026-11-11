# Access control

The WebSocket channel executes commands and reads and writes files on this machine as the user running the host, so it is **something that must never be stumbled upon by accident**. Access control lives in `apps/eta/src/access.ts`, running as the transport layer's `authorize` **before** any routing and WebSocket upgrade. Two independent checks.

## Origin check

Applies only to `/ws`. The browser attaches the page's origin during the WebSocket handshake, and a page cannot forge it, so a handshake from another page means some random website is trying to use the user's browser to operate the host — always 403.

- A handshake **without an `Origin`** is not a browser (scripts, daemons), and passes this check.
- The page's origin equals the origin it requested (`Host` header, plus `X-Forwarded-Proto` from a reverse proxy), or is in `--allow-origin` (repeatable). During development the page is served by vite on another port, so `bun run dev` passes vite's address to the host.
- "The origin it requested" is only trusted when it cannot be spoofed by DNS rebinding: an attacker's domain resolving to 127.0.0.1 would turn the attacker's page into "its own origin". So when **on a loopback address and without a token gate**, the requested hostname must also be a loopback address.

## Token gate

Enabled when `--token-file` is given, **or** the host listens on an interface other than loopback (`--host 0.0.0.0` etc.) — because then anyone who can route to this port can use it. If the token file does not exist, it is created on first start (random 24 bytes, base64url; file 0600, directory 0700); when `--token-file` is not given, it defaults to `<data directory>/access-token`. Tokens must be at least 16 characters.

Once enabled, **all requests except `/up`** require a token, in one of two ways:

- Scripts: `Authorization: Bearer <token>`.
- Mobile app: `X-Eta-Token: <token>`. Its runtime does not let the WebSocket handshake carry credential headers, so this custom header is used; it is compared the same way as bearer.
- Browser: open `/?token=<token>` once; the host responds with a 303 redirect to the address without the token and sets a cookie (`HttpOnly`, `SameSite=Strict`, plus `Secure` under https, 30 days). The cookie holds a hash derived from the token, not the token itself, so leaking the cookie is not the same as leaking the token. Token comparisons always compare hashes, and timing does not reveal the token's contents. `/ws` does not accept `?token=` (a socket cannot follow redirects); it carries the cookie, bearer, or `X-Eta-Token`.

This is the token gate from the upstream development gateway (`scripts/dev/gateway.ts`) moved into the host.

## Capability routing

Some pages carry their own credentials and cannot rely on cookies:

- `/preview/<capability>/…`: artifacts are previewed in a sandboxed iframe; a sandboxed iframe is an opaque origin and sends no cookies, so **the address itself is the credential**: `<version>.<expiry>.<signature>`, signed with a key that exists only on the host (`artifacts/.preview-key`), can open only one version, and expires after an hour.
- `/share/<token>/…`: public sharing for people who are not users; the path contains a secret token. Revoking the share invalidates it permanently; sharing again generates a new token.

- `/mcp/oauth/callback`: after an MCP server OAuth login completes, the browser jumps back from the authorization provider without our cookie. The credential is the `state` in the URL: only logins initiated by the host itself that are still waiting are accepted; everything else (no `state`, wrong `state`, already used) just returns an informational page and changes nothing. It only allows GET on this one path, see [MCP](mcp.md).
- `/github/manifest/callback`, `/github/authorization/callback`: after a GitHub App is created or a user finishes authorization, the browser jumps back from github.com, likewise without a cookie. The credential is a one-time `state` issued by the host (valid for one hour for creation and 15 minutes for authorization, invalidated after one use): if it is missing, wrong, already used, or expired, nothing changes; the browser is only redirected back to “settings → Connections” with a reason. When an App has just been installed, GitHub comes back with `code` and `setup_action` and without `state`; this case additionally requires that the authorizing account can access some installation of this App, and a personal App only accepts its owner. It only allows GET on these two exact paths, see [GitHub](github.md). When the host has not loaded GitHub (the default, see below), these two paths are still exempt from the token gate; nothing answers them and they fall through to the page.

These categories are **read-only** (GET/HEAD) and exempt from the token gate for no other reason. Everything else, including the app's own `/artifacts/<id>/<version>/archive.zip` downloads, remains behind the token gate. Every preview and share file carries `Content-Security-Policy: sandbox` (without `allow-same-origin`), so someone else's HTML runs in an opaque origin, cannot read cookies or storage, and cannot call the host as the user; there is also `Referrer-Policy: no-referrer`. For an invalid capability or token, it does not say why it is invalid.

## daemon entry points

`/machines/enroll` and `/machines/connect` likewise bypass these two checks: the daemon has no cookie and sends no origin. They each verify what they carry (enrollment code, device credential), see [Machines and daemons](machines.md).

## Running behind a reverse proxy

The proxy needs to: upgrade WebSocket (`/ws`, `/machines/connect`), forward `Host` and `X-Forwarded-Proto`. If the proxy rewrites `Host`, add the page's external URL to `--allow-origin` (e.g. `--allow-origin https://eta.example.com`). The token gate is managed by the host itself, so the proxy doesn't need to duplicate it, but after terminating TLS don't expose the host directly to the public internet.
