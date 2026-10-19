# 开一个 dev 实例给别人看

在本机起一个 host，再用 Cloudflare 的临时隧道给它一个公网地址。不需要域名，也不需要 Cloudflare 账号。

## 1. 构建

```sh
bun install
bun run setup                 # 编译 LLM 网关（需要 Go）
bun run --cwd apps/web build  # 网页，产物在 apps/web/dist
```

## 2. 起 host

```sh
bun apps/eta/src/main.ts \
  --data-dir ~/eta-demo \
  --port 18800 \
  --web-dir apps/web/dist \
  --token-file ~/eta-demo/access-token
```

- 只监听 127.0.0.1，外面的流量只能经隧道进来。
- 给了 `--token-file` 就会开令牌门禁：令牌在第一次启动时写进这个文件，`cat ~/eta-demo/access-token` 可以看到。
- 数据都在 `--data-dir` 里，删掉这个目录就清空了。

## 3. 开隧道

```sh
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:18800
```

输出里会打印一个 `https://<随机词>.trycloudflare.com` 地址。隧道进程不退出，地址就一直有效；重启隧道会换一个新地址。

## 4. 打开

```
https://<随机词>.trycloudflare.com/?token=<access-token 的内容>
```

只需要带一次令牌：host 会把它换成 cookie，之后访问根地址即可。

## 可选：OAuth 回调

要在这个实例上登录 MCP 的 OAuth 或者连接 GitHub App，启动 host 时加上公网地址，让回调落回隧道：

```sh
ETA_PUBLIC_URL=https://<随机词>.trycloudflare.com bun apps/eta/src/main.ts ...
```

## 更新和停止

- 更新：拉代码，重新做第 1 步，然后只重启 host（第 2 步）。隧道不用动，地址也不变。
- 停止：按 PID 结束 host 和 `cloudflared` 两个进程，不要用 `pkill -f`。不再需要的话，删掉 `--data-dir` 目录。

令牌等于这个实例的访问权限，只发给要看的人。
