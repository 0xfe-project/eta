<p align="center">
  <img src="public/Eta-Banner.png" alt="Eta" width="900" />
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<h2 align="center">
  统帅你的编码 Agent 舰队，跨机器持续交付。
</h2>

<p align="center">
  把 <strong>Claude Code</strong>、<strong>Codex</strong>、<strong>Antigravity</strong>、<strong>OpenCode</strong>、<strong>Pi</strong>、<strong>ACP</strong> 和原生 Eta Agent 拉进同一个协同作战室 —— 配备基于 <code>git worktree</code> 与依赖编排的任务看板、<strong>Captain</strong> 自治舰队总控、跨机器分布式执行，以及覆盖桌面、移动、Web 与终端的全端体验。
</p>

<p align="center">
  <a href="#一个控制台统管所有编码-agent">多运行时</a> ·
  <a href="#快速安装">快速安装</a> ·
  <a href="#多-agent-协同作战室">作战室</a> ·
  <a href="#captain-舰队总控">Captain</a> ·
  <a href="#任务看板与依赖编排">任务编排</a> ·
  <a href="#跨机器分布式执行">多机扩展</a> ·
  <a href="#架构总览">架构</a> ·
  <a href="#相关文档">文档</a>
</p>

---

## 一个控制台，统管所有编码 Agent

把不同的编码 Agent 拉进**同一个群聊**，让它们一起讨论方案、写代码、做审查与接力交付 —— 共享同一套任务看板、可视化产物、MCP 工具与审批门禁：

<p align="center">
  <img
    src="public/screenshot-war-room.png"
    alt="Eta 群聊页面：展示 Claude Code、Codex、Antigravity 与 OpenCode 在同一个项目群里通过 @提及 实时协作，以及内联产物卡片与成员状态面板"
    width="900"
  />
</p>

- **内置 Eta Agent** —— 接上任意 API Key、订阅账号或私有端点即可开箱使用。
- **主流编码 CLI（由 OAR 统一驱动）** —— **Claude Code**、**Codex**、**Antigravity**、**OpenCode**、**Pi**、**Grok Build** 与 **Qwen Code**。
- **任意 [ACP](https://agentclientprotocol.com) Agent** —— 在任意机器上按需接入自定义或社区的 Agent Client Protocol 兼容 Agent。

---

## 快速安装

可以把安装手册直接交给你的 AI Agent 全自动部署，也可以下载原生客户端零终端起步，或将 `eta-host` 部署在常驻服务器上，让 Agent 舰队在合上笔记本后继续工作。

### 方式一：让你的 AI Agent 帮你安装（最省心）

把下面这段提示词直接发给 **Claude Code**、**Codex**、**Antigravity**、**Cursor**、**OpenCode** 或任意编码 Agent —— 它会先依据 [INSTALL.md](INSTALL.md) 检测你的系统环境，自动选择最合适的方案，并妥善处理 macOS 隔离属性、Windows SmartScreen、Linux Flatpak 与 `.tar.gz` 选型、常驻宿主 + Web UI 及移动端配对：

```text
请阅读 https://raw.githubusercontent.com/0xfe-project/eta/main/INSTALL.md 并帮我在本机安装 Eta。先检测我的系统环境，推荐最合适的安装方式，自动处理平台签名/依赖问题，并在完成后验证运行正常。
```

### 方式二：原生客户端（桌面端 & 移动端，零终端即开即用）

前往 [GitHub Releases](https://github.com/0xfe-project/eta/releases) 下载对应平台的 `desktop-v*` 客户端安装包（与 `v*` 宿主版本独立发布），打开后选择 **Run on this computer**（自动托管本地宿主）或 **Connect to an existing host**（连接已有宿主）。

| 平台                          | 安装包                                                            | 说明                                                                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS** (Apple Silicon)     | `eta-desktop-darwin-arm64.dmg`                                    | 拖入 Applications；安装包暂未签名，首次运行前请执行 `xattr -dr com.apple.quarantine /Applications/Eta.app`                                                                                                  |
| **Windows** (x64)             | `eta-desktop-windows-x64.zip`                                     | 解压后运行 `Eta.exe`（若弹出 SmartScreen 提示，请点击 **More info → Run anyway**）                                                                                                                          |
| **Linux** (x64)               | `eta-desktop-linux-x64.tar.gz`<br>`eta-desktop-linux-x64.flatpak` | `.tar.gz` 支持应用内热更新与本地宿主托管；`.flatpak` 可通过 `flatpak install --user` 跨发行版安装（推荐搭配系统或远程 `eta-host` 并选择 **Connect to an existing host**；升级需重新安装新版 `.flatpak` 包） |
| **Android** (8+, arm64/armv7) | `eta-android.apk`                                                 | 侧载安装 APK，支持地址直连或扫码配对                                                                                                                                                                        |
| **iOS** (15+)                 | `eta-ios.ipa`                                                     | 可通过 AltStore / Sideloadly 或自签证书安装                                                                                                                                                                 |
| **HarmonyOS**                 | `eta-harmonyos.hap`                                               | 安装至真机前请先使用个人开发者证书签名                                                                                                                                                                      |

习惯浏览器或终端？所有 `eta-host` 均自带完整的 **Web UI**（默认端口 `:8787`），独立的终端 **TUI**（`eta`）也让你在命令行中顺滑操控。桌面端（`.dmg`、`.zip`、`.tar.gz`）与 Android 客户端还可在 **Settings → Update** 直接接收带签名的 **应用内 / OTA 热更新**。

### 方式三：常驻宿主（7×24 小时舰队与多设备协同）

`eta-host` 是发布在 [Latest Releases](https://github.com/0xfe-project/eta/releases/latest) 的单文件可执行程序，集成了 Web 界面与完整编排能力，全部数据保存在 `~/.eta`。

**Linux（通过 Tailscale 部署 systemd 用户服务）：**

```sh
curl -LO https://github.com/0xfe-project/eta/releases/latest/download/eta-host-linux-x64
chmod +x eta-host-linux-x64
mkdir -p ~/.local/share/eta/host
mv eta-host-linux-x64 ~/.local/share/eta/host/eta-host
~/.local/share/eta/host/eta-host install-service --host tailscale
```

- 去掉 `--host tailscale` 则仅监听 `127.0.0.1`；无头服务器请执行 `loginctl enable-linger`，确保退出 SSH 后用户服务继续常驻。
- 监听非回环地址会自动开启 Bearer Token 门禁（密钥存于 `~/.eta/access-token`，权限 `0600`）。浏览器首次访问 `http://<this-machine>:8787/?token=<token>` 即可写入凭证，也可在设置中扫码配对桌面与手机端。
- 想先免安装体验？直接在终端运行 `./eta-host-linux-x64` 即可。

**macOS 与 Windows：**

```sh
# macOS (Apple Silicon) —— 清除未签名二进制的隔离属性
curl -LO https://github.com/0xfe-project/eta/releases/latest/download/eta-host-darwin-arm64
chmod +x eta-host-darwin-arm64
xattr -d com.apple.quarantine eta-host-darwin-arm64
./eta-host-darwin-arm64 install-service --host tailscale
```

Windows 用户可下载 `eta-host-windows-x64.exe`，在管理员终端执行 `eta-host-windows-x64.exe install-service` 注册为系统服务，并以当前用户身份运行（让 Agent 直接继承本机的 `git`、`gh`、`claude` 与 `codex` 登录态）。

**Docker Compose：**

```sh
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml exec eta cat /data/.eta/access-token
```

### 上手前 60 秒

1. **接入模型或本地 Agent：** 打开 **Settings → Model services**，使用设备码登录 ChatGPT/Codex 或 Grok 订阅，或填写 OpenAI / Anthropic / Gemini / 任意自定义端点 API Key；本机已安装的 **Claude Code**、**Codex**、**Antigravity**、**OpenCode**、**Pi** 和 **ACP** Agent 会自动识别。
2. **组建多 Agent 项目群：** 把不同专长的编码 Agent（例如 `Claude Code`、`Codex`、`Antigravity`、`OpenCode` 或内置 Eta Agent）拉进同一个项目群组，各自配置指令、模型与技能。
3. **派发 Worktree 隔离任务：** 在作战室 `@` 点名协同，或将工作送上任务看板 —— 每个任务都会签出独立的 `git worktree`（`eta/task-<N>`），实时上报进度并在完成后交付验收。

---

## 多 Agent 协同作战室

把每个代码仓库都变成多人协同的工程作战室，让专职 Agent 与你在同一条时间线上自然配合：

- **一室多角，分工协同：** 把 `Claude Code`、`Codex`、`Antigravity`、`OpenCode` 与内置 Eta Agent 放进同一个项目群聊；用 `@` 点名指定成员，或设置默认 **Steward** 统一接管，Agent 之间也能主动互相交接任务。
- **并行推进，随时纠偏：** 多个 Agent 可以同时开工互不等待；运行途中随时插话引导方向，或先把下一条指令排进队列。
- **决策与产出同屏直达：** 在对话流里直接确认任务草案、追踪实时任务卡进度，并一键打开 Agent 交付的交互式网页预览。

---

## Captain 舰队总控

**Captain** 是你的自治舰队总管，帮你盯紧所有项目群组、远程机器与后台任务，不遗漏任何状态变化：

<p align="center">
  <img
    src="public/screenshot-captain.png"
    alt="Eta Captain 视图：展示舰队巡检汇总、任务 #51 派发卡片以及定时例程待审批提案"
    width="900"
  />
</p>

- **全局巡检，一眼掌握进度：** 自动汇总各个群组与机器上刚完成的交付、卡住的工作以及需要你拍板的事项。
- **只管定目标，细节交给 Captain：** 说明你要的结果，Captain 会自行拆解任务、分发给合适的专职小队并全程跟进直到完成。
- **关键变更始终由你批准：** 新建 Agent、群组或定时例程，以及执行高敏工具操作，都会先呈上清晰的审批卡片等你一键确认。
- **定时例程（Routines）：** 把基准测试、每日巡检、变更摘要等周期性工程事务交给定时任务自动执行；看到报告后直接回复点评，就能让例程按你的要求不断迭代改进。

---

## 任务看板与依赖编排

群聊用于快速对齐方案，正式实现则交给**任务看板** —— 每个任务都在独立隔离的工作区里干净推进：

<p align="center">
  <img
    src="public/screenshot-tasks-dag.png"
    alt="Eta 任务 Plan 视图：展示父子任务拆解、依赖 DAG 曲线、关键路径与跨机器协同执行"
    width="900"
  />
</p>

- **每个任务自带独立 `git worktree`：** 并行开发多个任务时各自拥有独立分支与工作目录（`eta/task-<N>`），绝不踩踏主工作区，也不会互相冲突。
- **可视化依赖编排：** 将复杂需求拆成子任务并连线设定前置依赖；上游任务进入验收或完成后自动放行下游 —— **Plan**（DAG 依赖图）、**Board**（看板）与 **List** 视图随时切换。
- **带着完整上下文继续返工：** 验收任务时直接在任务下留言提出修改意见，Agent 会沿着同一份记忆无缝接着改，无需从头再来。
- **执行全程透明可见：** 在任务卡片里直接查看工具执行记录、文件 Diff、终端输出与 Token 用量统计。

---

## 跨机器分布式执行

通过轻量的 `eta-daemon`，把算力从随身笔记本平滑扩展到 Linux 构建机、GPU 工作站与远程服务器：

- **无需开放入站端口：** 工作节点通过一次性密钥指纹核验后主动外拨连回主节点，免去防火墙开端口与 SSH 密钥分发的麻烦。
- **在代码与硬件所在地直接运行：** Worktree 签出、编译测试和本机 CLI 都在目标机器原地执行，你只需在一个界面统管全部仓库。详见 [自托管指南](docs/self-hosting.md#more-machines-the-daemon)。
- **远程节点免维护升级：** 配对注册为服务的守护节点会随主节点自动保持版本同步。

---

## 全端原生体验，随时随地指挥

- **原生桌面端（`macOS`、`Windows`、`Linux`）：** 支持本机托管或连接远程宿主，`.dmg`、`.zip`、`.tar.gz` 提供签名校验的应用内自动更新（Linux `.flatpak` 搭配宿主机或远程 `eta-host` 使用，更新需重新安装新版 `.flatpak`）。
- **原生移动端（`Android`、`iOS`、`HarmonyOS`）：** 支持扫码配对，随时在手机上跟进作战室、验收任务与审批操作；Android 端支持签名 OTA 热更新。
- **内置 Web UI（`:8787`）：** 由 `eta-host` 直接提供，打开浏览器即可使用。
- **终端 TUI（`eta`）：** 为键盘流准备的极速终端界面，本地与远程宿主同样流畅。

---

## 架构总览

```text
  原生桌面端 · 移动端 · Web UI (:8787) · 终端 TUI (eta)
                           │
                  实时 WebSocket + HTTP
                           ▼
┌───────────────────────────────────────────────────────────┐
│  eta-host（单文件宿主 + ~/.eta/eta.sqlite）               │
│                                                           │
│  作战室 · Captain · 任务 DAG · 例程 · 产物 · 收件箱       │
│  模型与订阅 · 插件市场 · 每 Agent 独立 MCP · 审批门禁     │
└──────────────┬───────────────────────────────┬────────────┘
               │ 工作节点安全连接              │ 可选
               ▼                               ▼
     eta-daemon 远程节点                  Memory Sidecar
     （远程 worktree、本地 CLI、MCP）      （语义记忆增强）
```

---

## 插件、MCP 与交互式产物

- **插件与连接器生态：** 支持从本地目录、Git 仓库或 **Composio** 市场一键接入技能与工具，敏感配置全程加密保存。
- **按 Agent 独立配置 MCP：** 为不同角色分配专属 MCP 工具，远程服务的 OAuth 登录态集中托管，跨机器工作也无需重复授权。
- **可交互可视化产物（Artifacts）：** Agent 可以直接发布交互式 HTML/React 报告、性能看板与原型页面，支持应用内安全预览、ZIP 打包下载以及可随时撤销的公开分享链接。
- **关键节点由你把关：** 对敏感工具启用审批门禁，无论在电脑前还是手机上，都能随时回答 Agent 的提问或放行操作。

---

## 而且，完全自托管、100% 属于你

- **一个二进制，一个 SQLite 文件：** 全部 Agent、任务、审批、例程与加密凭证都存在 `~/.eta/eta.sqlite`，会话记录以可读文本保存；复制 `$HOME/.eta` 即可整套备份或迁移。
- **100% BYOK，无任何锁定：** 自带 API Key、ChatGPT/Codex 或 Grok 订阅，或者指向私有集群端点；没有席位费、没有积分抽水、没有云端黑盒。
- **全过程透明：** 每一步思考、每一次工具调用、文件改动与 Token 消耗都完整保留在你自己的数据库与时间线里。

---

## 升级维护

直接在界面 **Settings → Update** 一键升级，或在宿主机终端执行：

```sh
eta-host upgrade
```

`eta-host upgrade` 会自动校验 `SHA256SUMS`、等待正在执行的任务平滑收尾、将 `~/.eta/eta.sqlite` 备份至 `~/.eta/backups`、重启服务，并在新版本未能正常启动时自动回滚；已连接的 `eta-daemon` 节点会在重连时同步更新。桌面端（`.dmg`、`.zip`、`.tar.gz`）与 Android 客户端同样可在 **Settings → Update** 原地升级，Linux `.flatpak` 包则会在该页提示新版本并通过 `flatpak install --user` 安装更新。

## 相关文档

- [安装指南（Agent 可执行手册）](INSTALL.md) — 面向 AI Agent 的全平台自动化安装手册（macOS、Windows、Linux、Docker 与移动端）
- [自托管指南](docs/self-hosting.md) — 启动参数、Token 门禁、反向代理、`eta-daemon` 与版本升级
- [架构总览](docs/architecture/overview.md) — 进程模型、管道协议、数据目录与插件分层
- [开发指南](docs/development.md) — 仓库结构、Bun / Node 24 环境配置、源码启动与 CI 校验
- [发布流程](docs/release.md) — 版本打包流水线、校验和、OTA 清单与跨版本升级测试

## 开源协议

Eta 基于 [MIT 协议](LICENSE)开源。仓库内随附的第三方组件保留其各自许可条款 —— 其中 Eta Sans / AKR DWG 字体不适用 MIT 协议，编译后的宿主机二进制内嵌了以 `AGPL-3.0-or-later` 授权的 SearXNG。完整声明请参阅 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
