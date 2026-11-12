# Spin up a dev instance for others to see

Start a host on the local machine, then use a Cloudflare temporary tunnel to give it a public address. No domain or Cloudflare account is needed.

## 1. Build

```sh
bun install
bun run setup                 # Compile LLM gateway (requires Go)
bun run --cwd apps/web build  # Web page, artifacts in apps/web/dist
```

## 2. Start host

```sh
bun apps/eta/src/main.ts \
  --data-dir ~/eta-demo \
  --port 18800 \
  --web-dir apps/web/dist \
  --token-file ~/eta-demo/access-token
```

- Listens on 127.0.0.1 only; outside traffic can come in only through the tunnel.
- Passing `--token-file` turns on the token gate: the token is written into this file on first start, and `cat ~/eta-demo/access-token` shows it.
- All data lives in `--data-dir`; delete this directory and it's wiped.

## 3. Open a tunnel

```sh
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:18800
```

The output prints a `https://<random-words>.trycloudflare.com` address. As long as the tunnel process keeps running, the address stays valid; restarting the tunnel gives you a new address.

## 4. Open it

```
https://<random-words>.trycloudflare.com/?token=<contents of access-token>
```

You only need to pass the token once: the host exchanges it for a cookie, after which you can just visit the root address.

## Optional: OAuth callbacks

To sign in to MCP's OAuth on this instance, also pass the public URL when starting the host so callbacks land back on the tunnel:

```sh
ETA_PUBLIC_URL=https://<random-words>.trycloudflare.com bun apps/eta/src/main.ts ...
```

## Updating and stopping

- Update: pull the code, redo step 1, then restart only the host (step 2). The tunnel doesn't need touching, and the address stays the same.
- Stop: kill the host and `cloudflared` processes by PID, not with `pkill -f`. If you no longer need it, delete the `--data-dir` directory.

The token is access to this instance — only give it to people who need to look.
