# eta-web 浏览器手测清单（Solid 移植）

对照 `GUI-PLAN.md` T3、`PORTING.md` §6 手测定义，以及这次「架构/testid/协议不变、真 LLM 可测」的要求。
跑法：`bun run dev`（:3000）+ `bun run dev:web`（:5173，测当前源码）。选择器用 `data-testid`。

判定：Pass / Fail / Blocked。Fail 必须写复现步骤。Blocked 只允许环境原因（无网、模型拒答、无 pty）。

## A. 壳与连接

| ID | 步骤 | 期望 |
| --- | --- | --- |
| A1 | 打开 `http://127.0.0.1:5173/` | 出 `shell`、`sidebar`、`welcome` 或已有 session；无白屏、无 React 报错 |
| A2 | 看 `conn-dot` | 连上后 class 含 `on`；断线为 `off` 且可出现 `connection-banner` |
| A3 | 控制台 | 无 `react is not defined` / `useState` / radix / wouter 报错 |

## B. 路由

| ID | 步骤 | 期望 |
| --- | --- | --- |
| B1 | 点 `nav-new` | URL `/new`，出现 `new-page`、`persona-grid` |
| B2 | 点 `nav-settings` | URL `/settings`，出现 `settings-page` |
| B3 | 从 settings 回 `/` | WS 不重连到丢状态（session 列表仍在） |

## C. 主题 / 语言

| ID | 步骤 | 期望 |
| --- | --- | --- |
| C1 | Settings 点 `theme-light` | `html` 有 `light`、无 `dark`；`localStorage eta.theme=light` |
| C2 | 点 `theme-dark` | `html` 有 `dark`；`eta.theme=dark` |
| C3 | 点 `locale-en` | 文案变英文；`eta.locale` 或等价持久化 |
| C4 | 点 `locale-zh-CN` | 文案回中文 |
| C5 | 刷新 | 主题/语言保持 |

## D. 新建向导（eta 独有）

| ID | 步骤 | 期望 |
| --- | --- | --- |
| D1 | `/new` 不选 persona | `create-session` disabled，有 `persona-required` |
| D2 | 点一张 `persona-card-*` | 该卡 `data-selected=1`，创建钮可点 |
| D3 | 填 cwd / 首条 prompt，点创建 | 发 `session.create`（带 personaId），回到 `/`，侧栏出现新 session |

## E. Welcome 首发（真 LLM）

| ID | 步骤 | 期望 |
| --- | --- | --- |
| E1 | `/` 无 session 时选 persona chip | `persona-*` 高亮；未选时 composer 发送 disabled |
| E2 | 选 persona 后发「用一句话介绍你自己」 | 出现 `user-message`；随后 `assistant-message` 或 `streaming-row` 有真模型字（不是空回声占位） |
| E3 | 流式过程 | `streaming-row` 出现再消失；最终 `message-markdown` 有内容 |
| E4 | 顶栏 | `active-session` 有名；`header-tokens` 在回复后可增长 |

## F. Composer 语义（移植合同）

| ID | 步骤 | 期望 |
| --- | --- | --- |
| F1 | 输入 `hello from solid` 回车 | 发出 prompt，timeline 出 user 行 |
| F2 | 跑着时空输入回车 | 停止/abort（发送钮变 Stop 时） |
| F3 | 输入 `@` 再打文件前缀 | 出 `mention-popup`；回车插入 `@path` |
| F4 | 输入 `/ab` | 出 `slash-abort`；回车 abort |
| F5 | `/goal 验证 Solid 移植` | 面板或 ContextBar 出现 goal |
| F6 | IME：中文未上屏回车 | 不误发（能测则测） |

## G. Context 面板

| ID | 步骤 | 期望 |
| --- | --- | --- |
| G1 | 有 view 后看右栏 | `context-panel`、`usage-donut`、`usage-row` |
| G2 | 点 `prompt-open` | `prompt-overlay` + 至少一个 `prompt-section-*`（含 persona 稳定块） |
| G3 | 点 `tools-open` | `tools-overlay` 列出工具 |
| G4 | 点 `json-open` | `json-overlay` / `json-body` 是当前 view |
| G5 | `persona-switch-open` | `persona-switch-dialog`，可切另一张卡 |
| G6 | 任务：`task-new` 回车 | 出现 `task-row-*` |
| G7 | loop：`loop-note` + `loop-add` | 出现 `loop-row-*` |
| G8 | `panel-compact` | 按钮进入 compacting，epoch 或文案变化后恢复 |

## H. 命令面板 / 快捷键

| ID | 步骤 | 期望 |
| --- | --- | --- |
| H1 | ⌘K / Ctrl+K | `command-palette`、`palette-input` |
| H2 | 输入 theme / 点 `palette-item-theme-light` | 主题切 light |
| H3 | 过滤无结果 | `palette.empty` 文案 |
| H4 | ⌘B / Ctrl+B | 侧栏开合（`drawer-left` `data-open`） |
| H5 | ⌘⇧O | 进 `/new` |

## I. 侧栏

| ID | 步骤 | 期望 |
| --- | --- | --- |
| I1 | 多 session 时点另一行 | `active-session` 变、timeline 换会话 |
| I2 | 行 `⋯` 重命名 | 标题变，id 仍是 `session.name` |
| I3 | 置顶 / 归档 | 出现 pinned 或 `group-archived` |
| I4 | `sidebar-search` 打 ≥2 字 | 可出 `search-hits`（有索引时） |
| I5 | 删除 | 该行消失；必要时回 Welcome |

## J. Dev rail

| ID | 步骤 | 期望 |
| --- | --- | --- |
| J1 | 点 `tab-dev` | 出 `dev-rail` |
| J2 | 点一条 `dev-frame` | 出 `dev-frame-dialog`，JSON 完整 |
| J3 | `dev-filter` 过滤 | 列表变少 |
| J4 | `dev-pause` | 新帧不再刷进列表（resume 后恢复） |

## K. 终端抽屉

| ID | 步骤 | 期望 |
| --- | --- | --- |
| K1 | 点 `term-toggle` | 出 `terminal-drawer`、`term-host` |
| K2 | `terminal-new` | 新 tab `terminal-tab-2` |
| K3 | `terminal-hide` | 抽屉关掉 |
| K4 | 有 cwd 时 | `terminal-cwd` 显示路径 |

## L. 模型 / thinking / 附件

| ID | 步骤 | 期望 |
| --- | --- | --- |
| L1 | `model-picker` | 打开 `model-menu`，当前模型可见（pro6000 / qwen） |
| L2 | `thinking-chip` 或 toolbox thinking | 发出 `thinkingLevel`，chip 文案循环 |
| L3 | `composer-plus` | 出 `composer-toolbox`（上传 / 图片 / 命令 / 文件搜索） |

## M. 真模型能力（API 已配）

| ID | 步骤 | 期望 |
| --- | --- | --- |
| M1 | 「只回复：SOLID_OK」 | assistant 文本含 `SOLID_OK`（证明不是 faux 回声乱套） |
| M2 | 「用 bash 执行 `echo eta-solid-probe` 并报告 stdout」 | 出现 `tool-row-bash`（或等价），结果含 `eta-solid-probe` |
| M3 | 「用 markdown 写一个带标题和列表的三行说明」 | `message-markdown` 渲染出标题/列表，不是纯转义文本 |
| M4 | 跑着再发一条 follow-up | 排队 pill 或第二条 user 行；不丢第一条 |
| M5 | 如模型提问 | 前台出 `ask-modal`；后台只 badge 不弹 |

## N. 响应式

| ID | 步骤 | 期望 |
| --- | --- | --- |
| N1 | 视口 375×812 | 主区是聊天；`toggle-left` / `toggle-right` 在 |
| N2 | 开左抽屉再点 `drawer-scrim` | 抽屉关 |
| N3 | 无横向滚动条 | `scrollWidth <= clientWidth` |

## O. 回归（移植语义）

| ID | 步骤 | 期望 |
| --- | --- | --- |
| O1 | 换 session 再换回来 | composer 草稿按 `eta.draft.*` 恢复；timeline 不丢 |
| O2 | `@` mention 每个字符 | `/api/files` 不每个键都打（网络面板） |
| O3 | 流式时滚离底部 | 出 `new-activity`；点回钉底 |
| O4 | 杀 server 再起 | 自动重连，`conn-dot` 回 on，session 还在 |

## 手测结果（2026-09-10，agent-browser + 真模型）

跑法：`npx agent-browser --session eta-solid-port --args "--no-sandbox"`，对 `http://127.0.0.1:5173/`（Vite 源码）+ `:3000`。模型为配置里的 OpenAI 兼容端点，不是 faux echo。

| ID | 判定 | 备注 |
| --- | --- | --- |
| A1 | Pass | `shell` / `sidebar` / 已有 session；无白屏 |
| A2 | Pass | 连上 `conn-dot on`；杀 :3000 后 `off` + `connection-banner`「已断开 — 正在重连」 |
| A3 | Pass | 控制台无 react / useState / radix / wouter |
| B1 | Pass | `/new` + `persona-grid` |
| B2 | Pass | `/settings` |
| B3 | Pass | 回 `/` 后 session 列表仍在，WS 仍连 |
| C1–C5 | Pass | light/dark 与 en/zh-CN 写入 `eta.theme` / `eta.locale`，刷新保持 |
| D1–D3 | Pass | 未选 persona 时创建钮 disabled；选卡后创建 `eta-mtvc5njc` 回 `/` |
| E1 | Untested | 环境已有 session，未回到零会话 Welcome 选 chip；persona 选择由 D2 覆盖 |
| E2–E4 | Pass | 首发「只回复：SOLID_OK」出 user/assistant，流式后 markdown 有字，token 增长（非 faux） |
| F1 | Pass | 多次 composer 回车/发送，timeline 出 user 行 |
| F2 | Pass | 跑着时空输入回车，发送钮回「发送」，`streaming-row` 消失 |
| F3 | Pass | `@` 出 `mention-popup` |
| F4 | Pass | `/ab` 出 `slash-abort` |
| F5 | Pass | `/goal 验证 Solid 移植` 面板/ContextBar 有 goal |
| F6 | Blocked | agent-browser 无法驱动真实 IME 未上屏回车 |
| G1 | Pass | `context-panel` + `usage-donut` + `usage-row` |
| G2–G5 | Pass | prompt/tools/json overlay、persona 切换框 |
| G6–G7 | Pass | task / loop 用 focus + `keyboard type`（纯 `fill` 经常写不进 Solid signal） |
| G8 | Pass | `panel-compact`：压缩 → 压缩中… disabled → 恢复 |
| H1 | Pass | Ctrl+K 出 palette |
| H2 | Pass | 中文「浅色」命中 `palette-item-theme-light`，`html`/`eta.theme` 变 light。英文 `light` 在 zh-CN 下无匹配（滤的是本地化文案） |
| H3 | Pass | 无匹配文案 |
| H4 | Pass | Ctrl+B 切 `drawer-left` `data-open` |
| H5 | Pass | Ctrl+Shift+O → `/new` |
| I1 | Pass | 点另一行，`active-session` 变 |
| I2 | Pass | `window.prompt` 重命名为 SOLID_RENAMED，testid 仍是 `session-row-eta-mtvc5njc` |
| I3 | Pass | 置顶出 `pinned-*`；归档出 `group-archived`「已归档 (1)」，可取消归档 |
| I4 | Pass | 搜 `SOLID` 出 `search-hits` |
| I5 | Pass | 删除 `eta-mtvcjs62` 后该行消失 |
| J1–J3 | Pass | `dev-rail`、点帧出 JSON dialog、过滤 `zzzz-no-frame` → 0 条 |
| J4 | Fail | 停在 `tab-dev` 点 pause（钮变 resume）后列表仍从 48 增到 53。`frozen.current = props.frames` 拿的是 store 同一份数组，Solid `reconcile` 会就地改写。切走 `tab-dev` 还会卸载 DevRail，pause 状态丢失 |
| K1–K3 | Pass | 抽屉 + `term-host` + `terminal-tab-2` + hide 关掉 |
| K4 | Pass | 带 cwd 的 session 显示 `/home/akrc/Developer/eta` |
| L1 | Pass | `model-menu` 可见 `pro6000:qwen3.8-flash-next-uncensored` |
| L2 | Pass | `thinking-chip` off → minimal |
| L3 | Pass | `composer-toolbox`：上传/图片/BTW/模型/思考/文件/命令 |
| M1 | Pass | assistant 含 `SOLID_OK` |
| M2 | Pass | `tool-row-bash` + 页内 `eta-solid-probe`（该 session 模型后来还连打了很多 bash，属模型行为） |
| M3 | Pass | `message-markdown` 渲染 `<h2>SOLID_MD</h2>` + 3 个 `<li>`（solid-streamdown，不是转义文本） |
| M4 | Pass | 跑着再发 follow-up：出现第二条 user 行（`FOLLOWUP_OK` / `QUEUE_PILL`）。`queued-bar` 多数时候来不及看到（模型很快吃掉队列） |
| M5 | Pass | 前台 `ask-modal` 问题含 ASK_PROBE；切走后 modal 关、侧栏「待答」badge 仍在 |
| N1 | Pass | 375×812：主区 composer 在，`toggle-left` / `toggle-right` `display:block` |
| N2 | Pass | 开左抽屉后点 `drawer-scrim`，左右 `data-open` 都回 0 |
| N3 | Pass | `scrollWidth === clientWidth === 375` |
| O1 | Pass | `eta.draft.eta-mtvcyg9i=DRAFT_KEEP_ME`，切走再回来 textarea 恢复，timeline 仍 6 条 user |
| O2 | Pass | `@` `p` `a` `c` 四次按键只打了 **1** 次 `GET /api/files` |
| O3 | Pass | 滚离底部出「下方有新内容」，点后钉回底、按钮消失 |
| O4 | Pass | 杀 :3000 → `conn-dot off` + banner；再起 server → `on`、5 个 session 都在 |

### 环境笔记

- Linux 必须 `--args "--no-sandbox"`，否则 Chrome 起不来。
- 不要 `AB="npx ..."` 再 `$AB`（zsh 会当成一个命令名）。用函数：`ab() { npx --yes agent-browser --session "$AGENT_BROWSER_SESSION" --args "--no-sandbox" "$@"; }`
- Composer / task / loop 的 `fill` 经常不更新 Solid signal，要用 click + `keyboard type`。
- WS 写盘后至少等 1.2–1.5s 再断言。
- `window.prompt` 重命名要先点再 `dialog accept '新标题'`。
- server 日志里的 `(model: faux echo)` 只看 `ANTHROPIC_API_KEY`，会误导；真模型以 `~/.eta/config.json` / UI picker 为准。

### 唯一 Fail 的修复方向（未改代码）

`packages/eta-web/src/features/sessions/dev-rail.tsx`：pause 时应 `frozen.current = props.frames.slice()`（拷贝），不要保存 store 数组引用。
