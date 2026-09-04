# REFACTOR — eta-agent 重构计划

> 目标：把 `eta-core-dev-tui` 里所有"控制逻辑"下沉到 `eta-core-controller`，修好 config 读写，对齐 crabcode 对开发体验有用的特性，让 TUI 变成纯渲染 + 键盘层，为之后 Web / GUI 前端铺路。
>
> 原则：每项独立提交（cargo fmt + cargo test 过后单独 commit）；TUI 最终只依赖 `eta-core-controller` 暴露的 API，不直接碰 provider / sqlite / fs / mcp。

---

## 一、现状审计（2026-09-03）

### 已完成（近 5 个 commit）

| 项 | 状态 | commit |
|---|---|---|
| 填充 `context_window`（config limit + 已知模型前缀回退） | ✅ | 183a551 |
| adapter system prompt 注入环境上下文（session_id / agent / paths / cwd / model / tools） | ✅ | 183a551 |
| `eta-core-controller` crate 已建立，含 config 加载 / provider 解析 / adapter prompt / MCP tools | ✅ 部分 | f59fe2b |
| agentic auto-continuation（intent 信号检测 + 上限防死循环） | ✅ | e07bcc4 |
| thinking 分离（`AgentEvent::ReasoningUpdate` + Anthropic `thinking_delta` + OpenAI `reasoning_content`） | ✅ core+provider | 2ae920c |
| MCP 接线（`load_mcp_registry` + `mcp_tools` 注入 4 处 spawn 路径） | ✅ 未提交 | 工作区 |

### 仍然存在的问题

1. **TUI 仍然自己做控制器的活**——`app.rs` 920 行里全是 spawn session、开 sqlite、拼 system prompt、注册工具、event pump 翻译、model 解析调用。TUI 直接依赖 `eta-sqlite-storage` / `eta-io-tools` / `eta-system-prompts` / `eta-provider-*`，Web/GUI 前端要全部重写一遍。
2. **config 只读不写**——全仓库没有任何把 `Config` 写回 `~/.eta/eta.json` 的代码。`/model` 选择的模型只存到 session 的 KV（`eta.model`），重启丢失；import 来的 anycodingagent 配置只留在内存，从不落盘。
3. **event pump 在 TUI 里**——`App::pump` 手解 `AgentEvent` 流、合并 streaming、翻译 dev 事件，这部分是前端无关的会话状态聚合，应归 controller。
4. **TUI 里 `config/mod.rs` 与 controller 的 `model_entries` 等函数重复**（两份实现）。

---

## 二、重构任务清单（按顺序执行）

### R1. config 读写修正（✅ 60b6c41）（最优先，影响一切）

**问题**：`load_config` 每次启动从 `eta.json` + anycodingagent import 合并，结果只在内存；用户 `/model` 选完不写盘；没有 `eta.json` 时第一次启动全靠 picker 碰运气。

**做法**（全部在 `eta-core-controller`）：

- [ ] `save_config(config: &Config) -> io::Result<()>`：写 `~/.eta/eta.json`（pretty JSON，先写 tmp 再 rename，避免半写文件）。
- [ ] `import_and_persist()`：首次启动（`eta.json` 不存在）时跑 anycodingagent import，**合并结果立即落盘**，之后启动只读 `eta.json`，不再每次 import。import 是一次性迁移，不是每次启动的 merge。
- [ ] `set_active_model(model_id: &str) -> io::Result<()>`：读-改-写 `eta.json` 的 `model` 字段。TUI 的 `/model` 确认后调它，替换现在只写 session KV 的行为（session KV 保留作为 per-session override，但全局默认落盘）。
- [ ] `add_provider / upsert_provider_model`：为之后"添加自定义 provider"的命令留接口，同样落盘。
- [ ] 环境变量优先级文档化：`ETA_MODEL` > `eta.json.model`，env 只覆盖读取、不回写。
- [ ] 测试：tempdir 模拟 `ETA_HOME`，覆盖 首次 import 落盘 / 读写往返 / 损坏 JSON 不覆盖旧文件 / 并发写不撕裂。

### R2. controller 接管 session 生命周期（✅ d342447）（TUI 瘦身核心）

把 `app.rs` / `session/mod.rs` 里这些逻辑整体搬进 `eta-core-controller`，TUI 只拿句柄和快照：

- [ ] `Controller::spawn_session(SpawnRequest) -> SessionHandle`
  - 入参：`agent_name`、`persona`、`model_id`（可选，缺省走 config）、`resume_session_id`（可选）。
  - 内部完成：开 sqlite（session + agent memory）、`save_owner`、拼 system prompt（persona + DEFAULT + adapter prompt）、`builtin_io_tools` + `mcp_tools` 注册、调 `eta-core` spawn、接 `LoopManager`。
  - TUI 的 `spawn_session_for_agent` / `spawn_session_handle` / `switch_agent` / `respawn_with_model` / `attach_existing_session` 五处重复拼装全部删掉，换成一次调用。
- [ ] `Controller::bootstrap_sessions() -> Vec<SessionMeta>`：把 `app.rs::bootstrap_sessions` 搬过去（扫 sessions 目录、恢复 owner/model、attach 不重启）。
- [ ] `SessionHandle` 暴露 `event_rx` / `dev_rx` broadcast receiver + `send(AgentInput)` + `cancel()`，TUI 不直接持有 `Agent`。
- [ ] `SessionManager`（attach 模型、current 指针、Picker 无关部分）搬到 controller；TUI 侧只保留"当前 attach 哪个 id"的选择状态。
- [ ] 依赖反转：TUI 的 `Cargo.toml` 删掉 `eta-sqlite-storage` / `eta-io-tools` / `eta-system-prompts` / `eta-provider-*` / `eta-mcp` / `eta-config` / `eta-anycodingagent-config-reader`，只留 `eta-core`（事件类型）+ `eta-core-controller`。
- [ ] 测试：controller 层用 mock provider 覆盖 spawn/resume/respawn/model 切换后 session 存活（现在 `two_sessions_run_concurrently` 这类测试应能搬到 controller 层、不依赖 ratatui）。

### R3. event pump / 会话状态聚合下沉（✅ d3ff323）

- [ ] controller 新增 `SessionView`（纯数据）：`answer_blocks`、`dev_lines`、`goal`、`todos`、`memory`、`skills`、`stable_prompt`、`adaptive_prompt`、`usage`、`working`、`pending_ask`——就是现在 `App::pump` 每次算出来的那一堆。
- [ ] `SessionHandle::poll(&mut view)` 或独立 `ViewProjector`：把 event 流翻译成 `SessionView` 增量（streaming 合并、空 turn 提示、AskUser 状态都在这层做）。
- [ ] TUI 每帧只做 `view.render(focus, scroll)`；Web/GUI 之后复用同一个 `SessionView`，serde 序列化即可走 WebSocket。
- [ ] `SessionView` 加 `serde::Serialize`，为 remote 前端做准备（dev 事件里注意别塞不可序列化类型）。

### R4. slash 命令与输入路由下沉（✅ 5612858）

- [ ] `commands/mod.rs` 419 行里与 UI 无关的命令语义（`/model`、`/agent`、`/session`、`/loop`、time-travel 命令的校验与执行）搬到 controller，TUI 的 command 层只剩 keybinding → command 映射和 picker 展示。
- [ ] `apply_time_travel`、`register_loop`、`list_loops`、`remove_loop` 这些纯转发函数从 `App` 删掉。

### R5. 渲染层补强（✅ f7b3b11 + 7e23c2f）（参考 crabcode，只取对开发有用的）

crabcode 里值得抄的（消费级特性如主题商店/音效/upgrade 不抄）：

- [ ] **语法高亮**：answer 面板代码块用 `syntect`（参考 `crabcode/src/ui/syntax.rs`），dev events 的 JSON payload 也着色。
- [ ] **diff 渲染**：工具调用里 edit/patch 类结果按 diff 着色（`crabcode/src/ui/diff.rs`）。
- [ ] **Unicode 感知折行**：替换 ratatui 默认折行（`crabcode/src/ui/wrapping.rs`），CJK 不断字。
- [ ] **markdown 流式渲染 + thinking 折叠块**：answer 面板按 block 渲染；`ReasoningUpdate` 已分离（2ae920c），渲染成可折叠的 "thinking … (N chars)" 块，默认收起——现在 thinking 虽然不进 transcript 了，但 answer 面板还没独立展示。
- [ ] **滚动条**（`crabcode/src/ui/scrollbar.rs`）：长输出时知道自己在哪。
- [ ] **thinking 统计**：status line 显示 thinking chars/chunks 独立计数。

### R6. agentic loop 健壮性（✅ 4cac675(doom/tail);StreamRollback 回归、权限 seam 未完）（参考 crabcode）

- [ ] **doom loop 检测加强**：现有 `LoopDetector` 只数工具调用重复（`repeat_count >= 2`）。crabcode 还有 `tail_repetition:N@thinking`（输出尾部重复检测）。在 core 的 loop_detect 里补 content 尾部重复检测，触发后注入 corrective reminder。
- [ ] **reasoning StreamRollback**：crabcode 在流回滚时连 reasoning 一起回滚，防止 thinking 污染历史。检查我们 compaction / retry 路径里 reasoning block 是否会被误带进下一次请求的 messages（2ae920c 做了隔离，需补一个 retry 场景的回归测试）。
- [ ] **工具权限系统**：crabcode 有 `AutoApprove` / `AllowList`。我们目前 io tools 全放行。加 `ToolPermission` seam（core 已有 `ControlPlanePrompt`，把 io tools 的写操作接到这个 gate，dev TUI 默认 auto-approve 但留配置口）。
- [ ] **空响应/截断重试可见性**：`StopReason::MaxTokens` 的重试现在静默发生，dev events 里加 `retry::max_tokens` 类别，方便调试。

### R7. context 注入补全（✅ 7f8fa7c）

- [ ] **`AGENTS.md` 自动注入**：spawn 时从 cwd 向上找 `AGENTS.md`，内容附到 adapter prompt（crabcode 有，我们没有）。注意缓存——每 turn 重读太贵，spawn 时读一次 + mtime 失效。
- [ ] **工具参考卡注入**：crabcode 把工具描述摘要注入 system prompt。我们 adapter prompt 只列了工具名，补上每个工具的一句话 description。
- [ ] **MCP 服务列表注入**：`mcp.json` 里配置了哪些 server 也写进 adapter prompt（现在只注入了 mcp.json 的路径）。
- [ ] **compaction 摘要前缀**：crabcode 有 `SUMMARY_PREFIX` 告知模型"这段是另一个 LLM 写的摘要"。检查我们 compaction 写入的摘要是否有类似标记，没有则加。

### R8. MCP 体验（✅ 3a39121）

- [ ] **mcp.json 热重载接入 TUI**：`McpRegistry::watch` 已实现（`notify` watcher），但没接进任何地方。controller 起 watcher，registry 变更时给现有 session 推送工具列表更新（或至少在新 spawn 生效 + dev event 提示）。
- [ ] MCP server 启动失败/dev event：现在 server 挂了静默，`CallTool` 失败才报错。spawn 时探测一次 server 可用性，失败发 dev event。

### R9. provider 层对齐（✅ ad77a5b）

- [ ] **`reasoning_effort` 透传**：`ProviderConfig.options` 里的 `reasoningEffort` 传到 API 请求体（OpenAI `reasoning_effort` / Anthropic `thinking.budget_tokens`）。crabcode 每个 provider 有独立 reasoning 路径，我们 openai/anthropic 已各有一条，补参数透传即可。
- [ ] **model→provider 反查**：给一个不带 provider 前缀的 model id 时按已知前缀推断 provider（crabcode 有）。低优先级——我们强制 `provider/model` 格式，只在 config import 迁移时有用。
- [ ] **prompt caching 标记**：Anthropic `cache_control` 标记（system prompt + 长前缀），crabcode 有。我们 anthropic provider 检查是否已发 `cache_control`，没有则加（stable system prompt 天然受益）。

### R10. 收尾：TUI 最终形态（✅ a2a1661）

完成 R1–R4 后，TUI 应该只剩：

```
main.rs      — 终端初始化、事件循环、按键分发
tui/         — 纯渲染（answer/context/dev/goal/screen/scrollbar/syntax/markdown）
app.rs       — UI 状态（focus、scroll、textarea、picker），持有 Controller 句柄
commands/    — keybinding → controller 调用
```

- [ ] TUI 依赖收敛检查：`cargo tree -p eta-core-dev-tui` 里不再出现 sqlite/io-tools/provider/mcp/config。
- [ ] 新增 `bin/eta-core-web`（或 examples/）骨架验证：用同一个 controller 起一个 axum WebSocket echo `SessionView`，证明前端无关性——**这是这次重构的验收标准**。
- [ ] 更新 PLAN.md / README，标注 controller 是官方嵌入入口。

---

## 三、执行顺序与提交计划

| # | 任务 | 依赖 | 验收 |
|---|---|---|---|
| 1 | R1 config 读写 | 无 | 改 `/model` 后重启仍生效；import 只跑一次 |
| 2 | R2 session 生命周期下沉 | R1 | TUI 删掉 5 处 spawn 拼装；测试在 controller 层跑 |
| 3 | R3 SessionView 下沉 | R2 | `App::pump` < 50 行 |
| 4 | R4 命令下沉 | R2 | `app.rs` 只剩 UI 状态 |
| 5 | R7 context 注入 | R2 | AGENTS.md 出现在 stable prompt |
| 6 | R6 loop 健壮性 | 无（core 独立） | doom loop 触发有 dev event |
| 7 | R8 MCP 热重载 | R2 | 改 mcp.json 后新 session 生效 |
| 8 | R9 provider 参数 | 无 | reasoning_effort 到达 API |
| 9 | R5 渲染补强 | 无（纯 TUI） | 代码块高亮、thinking 折叠 |
| 10 | R10 验收 | 全部 | axum 骨架能驱动同一 session |

每行一个 commit；2/3/4 可合并为一个大提交系列但分开 commit。

## 四、明确不做的

- 插件系统（WASM/wasmi）——PLAN.md 已暂缓。
- crabcode 的消费级特性：主题商店、音效、自动升级、OAuth 登录流、remote-client 全家桶。
- kanban / 多 agent 编排（`eta-kanban`、`eta-agent` 层）——等 controller 稳定后再接。
