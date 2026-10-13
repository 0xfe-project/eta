# OOMOL

内置环境包 `oomol` 让智能体用 OOMOL 的 [oo CLI](https://oomol.com/docs/agents/cli.md) 使用用户在 OOMOL 里连接的应用（邮件、日历、文档等）和 OOMOL 的托管能力。它是[环境包配置](bundles.md#配置)的第一个使用者，没有专门的服务代码。

## 使用

1. 登录 OOMOL 的 [MCP 配置页](https://oomol.com/install/mcp/)，生成 API key。页面上给出的配置里，`x-oo-team-name` 就是团队名。
2. AXP 设置 →「连接」→ oomol：填写 API key 和团队名，保存。
3. 新建的智能体默认载入所有内置环境包，包括 `oomol`；已有的智能体需要在编辑器里勾选它。保存配置后，智能体会在空闲时重启，之后就能用 `oo`。

修改团队只需要改团队名，key 留空表示不替换。在 OOMOL 重置 key 后，在这里填新的。「清除配置」会删除保存的值，智能体随后失去 `oo` 的 skill。

## 实现

- `bundles/oomol/bundle.json` 声明两项配置 `OO_API_KEY`（机密）和 `OO_TEAM_NAME`，它们正是 oo CLI 自己读取的环境变量：有 `OO_API_KEY` 时 oo 用它认证，不用登录也不读已保存的账号；`OO_TEAM_NAME` 是默认团队。
- 插件 `plugins/oomol` 只在构建镜像时运行 `setup`：下载固定版本的 oo（1.9.8），校验 sha256。OOMOL 不发布 checksum，校验值是固定版本时算出的。二进制放在 `/usr/local/lib/oomol/oo`，`/usr/local/bin/oo` 是一个包装脚本，设置 `OO_NO_SELF_UPDATE` 和 `OO_SKILLS_SYNC_DISABLED`：镜像不可变，不自更新；oo 每次运行默认都会把它自带的 skill 同步到 `~/.agents/skills`，关掉后就不会绕过插件的开关。setup 再把 oo 自带的 skill（`oo`、`oo-find-skills`）复制进插件，所以配置不完整时这两个 skill 和插件一起被禁用。AXP 不另写 skill，也不复制工具定义。
- key 作为环境变量进入智能体的容器，智能体执行的命令能读到它。这是这种方式的代价：凭据交给了智能体自己用（见[环境包配置](bundles.md#配置)）。

## 验证与缺口

- 在 AXP runtime 镜像里实际运行了 `axp-plugins chat`：oo 1.9.8 装好，插件的 skill 编译进去（Codex 插件缓存 188K）。Codex 0.162.1 的 `skills/list` 只列出 `oomol:oo` 和 `oomol:oo-find-skills`，运行 oo 后 `~/.agents/skills` 依然为空。在 Codex 的 shell 里，oo 用的是环境变量里的 key 和团队（用假 key 测试，OOMOL 返回 key 无效）。
- 没有用户的真实 key，所以没有验证 MCP 配置页生成的 key 能否直接当 oo 的 `OO_API_KEY` 使用。
- 远程电脑：AXP 不向远程电脑注入环境包或配置，服务器上的 key 不会下发。需要在那台电脑上按 OOMOL 文档安装 oo 并 `oo login`。
