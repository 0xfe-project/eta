# PLAN — eta-agent SDK 架构设计

目标:一个纯 trait + 纯逻辑的 agent SDK。核心原则:**core = 纯 trait + 纯逻辑,零 IO(runtime 统一用 tokio);真实 IO 全部在 adapter 层**。

设计偏好(贯穿全文):**能不强类型就不强类型**。core 只吃 trait,具体类型由 adapter 自己写。

---

## 1. crate 清单

| crate | 内容 |
|---|---|
| `eta-llm` | `Provider::stream` + `Event` + `Context` + `Usage` + `ProviderError`(内容 opaque)。不带吞吐计量。 |
| `eta-core` | core agent 引擎:`Agent` + `Tool` + `drive_loop` + 内置 state/工具 + goal 续命 + loop 调度 + self-mgmt(loop-detection/self-summary/compaction/进化)+ **seam traits**(`SessionStorage` / `MemoryStore` / `SkillStore`)+ `SessionState` 信封。**完全不感知多 agent**。 |
| `eta-kanban` | **纯逻辑看板**:task / KanbanDAG 模型 + deps 拓扑排序 + 就绪计算 + 状态转移 + 终态判定(空 / 全 question)+ **看板操作是一组 skill/tool**(`CreateTask`/`SetDeps`/`AssignOwner`/`UpdateStatus`/`FinalizeBreakdown`),不是 agent、没有 actor/loop。**零 IO、零 agent 概念**——板面数据经 seam trait 持久化,任意 agent 通过 `Tool` trait 调用这些 skill。 |
| `eta-session` | `SessionStorage` 实现(强类型 `SessionState` 持久化)+ **context 拼装**(渐进式披露 + 每 turn `build_context`,从 `eta-context` 并入)+ 时间旅行/并行分支(fork/commit/checkout/rollback/history/merge/search)。 |
| `eta-agent` | 多 agent 层:主从(子 agent 共享主 context + 自己 skill/memory)+ 挑选优先/犯错学习 + kanban 指派 + send+response/fire。提供 agent 专属的 `MemoryStore`/`SkillStore` 实现(按 agent 存)。 |
| `eta-config` | eta 自己的 model/provider 配置 schema(供 config-reader 迁入的目标格式)。 |

adapter 层:`eta-provider-anthropic` / `eta-provider-openai`、`eta-io-tools`、`eta-sqlite-storage`(通吃所有存储:session-state、context、compaction、**kanban**、commits)、`eta-mcp`、`eta-anycodingagent-config-reader`。

**嵌入入口是 `eta-core-controller`(refactor 之后)**:spawn/resume/config/MCP/watch/projection 全在这一个 crate,TUI 与 `eta-core-web` 骨架都只依赖它 + `eta-core`(事件类型)。任何新前端(TUI/GUI/Web)从这里拿 `SessionHandle` + `SessionViewState`,不直接碰 sqlite/provider/fs。

tests-helper:`eta-llm-test-providers`(mock providers + 单测)。

扩展点(seam):`SessionStorage`、`AgentHooks`(hook 回调)、`ControlPlanePrompt`(permission gate,fail-closed)。看板数据复用 `SessionStorage`(存 session state),`eta-kanban` 经它读写板面。

**分层(严格从上往下依赖,无环)**:

```
eta-llm   (无 seam,叶子)
   ↑
eta-core  (定义 trait + 纯逻辑;只依赖 eta-llm)
   ↑
eta-kanban (纯逻辑看板:状态模型 + skill 定义;依赖 eta-core,但零 agent 概念、零 IO)
   ↑
eta-session (实现 SessionStorage + context 拼装 + 分支;依赖 eta-kanban)
   ↑
eta-agent  (多 agent 工具 + 按 agent 的 MemoryStore/SkillStore 实现;依赖 eta-core + eta-session + eta-kanban)
```

adapters 各自只依赖它们实现的 trait 所在 crate。`eta-config` 被 `eta-anycodingagent-config-reader` 依赖。`eta-sqlite-storage` 依赖它实现的所有 trait 所在 crate(core / kanban / session)。

`eta-core` 是最核心的 agent 引擎(loop + tool + session + cache + goal + self-mgmt + 内置工具),**定义所有 seam 但不实现任何 IO**。`eta-agent` 是架在它上面的多 agent 层——「创建 agent」本身就是 agent 的一个工具任务(agent 调 `CreateAgent` = spawn 另一个核心 agent,递归);主从只是组织约定,不是新引擎。

> 插件系统(WASM/wasmi)暂缓,不在本期。

---

## 2. 核心设计

### 2.1 `eta-llm` — 流式 Provider,内容弱类型

core 不定义 `Message`/`Part`/`StreamDelta`/`MediaKind`。消息、模态、thinking、签名全部由 adapter 自己写,core 只吃 `Provider` trait + 一个 `Event` 枚举:

```rust
pub trait Provider: Send + Sync {
    /// 流式跑一轮(model / context / options 三参)。
    /// Item 是 Result:流创建后的中途错误(rate limit / 网络中断 / API 错误)以 Err 冒出。
    fn stream(&self, model: &str, context: &Context, opts: Option<&Value>)
        -> Pin<Box<dyn Stream<Item = Result<Event, ProviderError>> + Send>>;
}

/// SDK 自己的事件格式,adapter 把 provider 原生流翻译成它
pub enum Event {
    Content(Value),                              // {type: text|image_url|input_audio|video_url}
    ToolCall { name: String, arguments: Value },
    End { usage: Usage, stop: StopReason },      // 带 stop reason,区分「自然结束」vs「撞 max_tokens」
}

pub enum StopReason {
    EndTurn,      // 自然结束(模型说完/停)
    MaxTokens,    // 撞输出 token 上限被截断
}

pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

pub struct Context {
    pub system_prompt: Option<String>,
    pub messages: Vec<Value>,                    // 内容 opaque,弱类型
    pub tools: Vec<ToolSchema>,                  // {name, description, schema}
}
```

- **stop reason 是 retry 的前提**:`End { stop: MaxTokens }` 让 core 知道「这轮是被截断的」,从而注入「切小块继续」reminder 重试;`EndTurn` 且无 Content / 无 ToolCall 就是「空响应」。两条重试路径都靠这个判别,而不是猜。
- **内容约定**(adapter 遵循的 wire 格式,core 不强类型):
  ```json
  { "type": "text",         "text": "..." }
  { "type": "image_url",    "image_url": { "url": "url or base64 data url" } }
  { "type": "input_audio",  "input_audio": { "data": "base64 data url", "format": "wav/mp3/..." } }
  { "type": "video_url",    "video_url": { "url": "..." } }   // 同 image_url
  ```
- **输入和输出都多模态**:image / responses API 会返回文字+图片,`Content` 的 Value 双向通用。
- core 不限制、不校验输入模态;模型不支持时由 provider 报错。
- `Model` 退化成 `&str`(或 `Value`),具体模型解析/兼容在 adapter。

### 2.2 `eta-core` — 简化 Tool + channel 对

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn schema(&self) -> serde_json::Value;   // 输入 JSON Schema
    async fn execute(&self, input: serde_json::Value, cancel: CancelToken)
        -> Result<serde_json::Value, ToolError>;
}

pub struct Agent { input: Sender<AgentInput>, output: Receiver<AgentEvent>, state: RwLock<AgentState> }

pub enum AgentInput {
    UserMessage { content: serde_json::Value },   // 多模态;排队等当前 turn 结束
    Steer { message: serde_json::Value },          // 打断当前 turn + 注入新指令(保留 context)
    Loop { loop_id: String, prompt: serde_json::Value },  // 来自 loop 调度(2.7),打断 + 注入
    Resume, Abort { reason: String },
    SetGoal { objective: String }, PauseGoal, ResumeGoal, ClearGoal,
    Answer { tool_call_id: String, answer: serde_json::Value },  // 响应 ask_user(2.3)
    Custom(serde_json::Value),
}

pub enum TurnDriver { UserMessage(serde_json::Value), GoalContinuation, Resume }

pub enum AgentEvent {
    TurnStart { request_id: String }, TurnEnd { request_id: String },
    MessageStart { agent_id: String, message: serde_json::Value }, MessageUpdate { .. }, MessageEnd { .. },
    ToolExecutionStart { id: String, name: String, args: serde_json::Value },
    ToolExecutionEnd { id: String, result: serde_json::Value, is_error: bool },
    GoalStateChange { status: GoalStatus },
    Compaction { tokens_before: u64 }, LoopDetected,
    AskUserStarted { req_id: String, question: serde_json::Value },  // UI + 上层据此改 task 状态
    AgentEnd,
    Custom(serde_json::Value),
}
```

- **queue(驱动队列)**:内部一个 `TurnDriver` 队列,外部输入(`AgentInput`)和内部事件(goal 续命)都转成 driver 入队;drive_loop 每个 turn 边界 `dequeue_driver()`。
- **steer**:`AgentInput::Steer` 打断当前 turn(cancel)+ 把 steer 消息作为新 `TurnDriver::UserMessage` 注入(保留 context);区别于普通 `UserMessage`(排队等 turn 结束)。
- **agent_id 归属**:每个消息事件带 `agent_id`(说话者身份)。GUI(embedder)按 `agent_id` hash 出稳定颜色,同一 agent 永远同色、不同 agent 不同色——上色是 embedder 的事,SDK 只给稳定身份。
- **单 agent 边界**:core 里**没有** `BackgroundComplete`(那是多 agent 概念)、也没有 per-agent 之外的输入来源。多 agent 的「子 agent 完成唤醒主」由 `eta-agent` 层把一个普通 `UserMessage`/自定义输入投进主 agent 的队列,不引入新的 TurnDriver 变体。

#### hooks(生命周期扩展点,`AgentHooks` trait)

不列零散函数名,给一个带默认实现的 trait。embedder / 上层(`eta-agent`)实现它来接入;每个方法给默认空实现,**不实现 = 不改行为**(除 `on_control_plane_prompt` 默认 fail-closed Deny)。

```rust
#[async_trait]
pub trait AgentHooks: Send + Sync {
    // 生命周期观察(只读,不可改流程)
    fn on_spawn(&self, agent: &AgentId) {}
    fn on_stop(&self, agent: &AgentId) {}
    fn on_turn_start(&self, ctx: &TurnContext) {}
    fn on_turn_end(&self, ctx: &TurnContext) {}
    // 决策(返回值影响流程)
    fn should_stop_after_turn(&self, ctx: &TurnContext) -> bool { false }
    fn prepare_next_turn(&self, ctx: &mut TurnContext) {}          // 可入队 driver / 改 plan
    // queue
    fn on_queue_in(&self, ev: &AgentInput) {}
    fn on_steer(&self, ctx: &TurnContext) {}
    // tool
    fn before_tool_call(&self, call: &ToolCall) {}
    fn after_tool_call(&self, call: &ToolCall, result: &ToolResult) {}
    // context / compaction
    fn transform_context(&self, context: &mut Context) {}          // 拼装后、stream 前
    fn before_compaction(&self, ctx: &TurnContext) {}
    fn on_compaction(&self, ctx: &TurnContext) {}
    // goal
    fn on_goal_change(&self, goal: &GoalState) {}
    /// goal 续命 gate:决定 goal 管理器在 turn 结束时是否自主为当前 goal 入队 GoalContinuation。
    /// 默认 AutoContinue(现有契约);Delegated 表示「goal 保持 active 但不自主续命」,
    /// 推进交给外部信号 —— 上层(eta-agent)在 master 进入并行执行阶段时用它「hook 掉」master 的 goal(见 2.6 / 2.10)。
    fn goal_continuation_gate(&self) -> GoalContinuationGate { GoalContinuationGate::AutoContinue }
    // permission(唯一 async 的 gate,fail-closed)
    async fn on_control_plane_prompt(&self, prompt: &ControlPlanePrompt) -> ControlPlaneDecision {
        ControlPlaneDecision::Deny      // 默认拒绝 = fail-closed
    }
}
```

- **turn 内顺序**:`on_turn_start` →(stream,tool call 进出 `before/after_tool_call`)→ `on_turn_end` → `should_stop_after_turn`(true 则停)→ 否则 `prepare_next_turn`(可能在 queue 入 driver / 布置下一 turn)→ 下一轮。
- **`on_turn_end` 只有一个**;goal 续命不是靠第二个 `on_turn_end`,而是 goal 管理器在 turn 结束时用自己的判别(`on_goal_change` + 内部评估)决定是否入队 `GoalContinuation`。
- **`ControlPlanePrompt` 是 permission gate**,定义见 2.4。

#### observability(store 为唯一真源 + 事件日志是投影)

**store(SessionStorage)是唯一的 source of truth**;每次状态变更都经 `store.append(entry)` 落盘,同时对外发一个同 id 的索引事件——**不存在两套状态**。`SessionState` 是这些 append-only entry 的**物化投影**(每次写后刷新),不单独持权威态。

entry type:
```
user_message / assistant_message / tool_result / usage / turn
/ goal / compaction / state_write / error_retry / ask_user / answer
```
每个 entry = `{ id 自增, type, data }`,落进 session 日志,查询走 `search`/`history`。

- 消息:user / assistant(text、thinking、tool call)/ tool result
- token 用量:每 turn input / output / cache_read / cache_write
- turn 边界:request_id、start / end、duration
- goal 状态变化
- compaction:summary、tokens_before
- state 变更:kv_state
- 错误/重试:loop detection、empty response、token limit
- ask_user:提问 / 回答

**显示**:UI 从 store 读(实时 = 尾部新 id,历史 = `search`/`history`);store 即真源,无双写、无漂移。

**外部状态 → `tracing`**:agent 边界之外的东西,走 tracing span/event(只记录;**导出/订阅是 embedder 的事,eta 不管**):
- provider 的 HTTP 调用、延迟、rate limit、网络错误
- 工具执行(shell / file / MCP 的实际开销与错误)
- IO

#### 对接(integration)

- **core ↔ llm**:core 调 `provider.stream(model, &context, opts)`,消费 `Event` 流(Content / ToolCall / End);`Context`(system_prompt + messages + tools)由 session 拼。
- **core ↔ session**:core 调 `store.build_context()` / `store.append(entry)` / `store.commit(msg)` / `store.search(q)`;session 提供 `SessionState`(消息、kv、goal、custom)。
- **core ↔ memory/skill**:`MemoryStore`/`SkillStore` 是 core 里的 **trait**(真源所在,adapter/eta-agent 实现);session 的 `build_context` 经这两个 trait 读 memory/skill,做渐进式披露(2.9)。写 memory/skill 由 eta-agent 的 `UpdateAgent` 调同一 trait。

### 2.3 内置 state + 内置工具(每个 session 都有,经 system prompt 解决)

`ask_user` 是 **special case**,不走 `Tool` trait——因为它的 execute 要等用户答案,而 `Tool::execute(&self, input, cancel)` 拿不到回答通道,塞进 trait 会把它从「纯 trait 对象」里逼出来。所以:**模型照样在 tool 列表里看到 `ask_user` 并能调它,但 drive_loop 按名字拦截(core 识别),不路由到 `run_tool`**。

```rust
// 内置 state(经 SessionStorage 持久化)
pub struct SessionState { /* id: uuidv7 + kv + goal + custom + ...,信封强类型、内容 Value */ }

// 前台内置工具(直接面向用户 / 写 session state),system prompt 描述:
//   ask_user     { question, kind: "single"|"multi"|"fill", options?: [..], allow_custom?: bool }
//   update_state { action, key?, value? } → 写/删 session KV(set/delete)

// 通用内置工具(读 / 列出 session state):
//   check_state  { key? } → 读某个 key(只读)
//   list_state   {} → 列出所有 key
```

**`ask_user` 的 special-case 流程(drive_loop 内)**:

```
Event::ToolCall { name: "ask_user", args }
  → had_tools = true
  → emit(AgentEvent::AskUserStarted { req_id, question })     // UI 弹窗;eta-agent 把当前 task 置 `question`
  → 阻塞等 AgentInput::Answer { tool_call_id, .. }            // 当前 step 到此结束,不再消费流
  → store.append(assistant tool_use) + store.append(tool_result = 用户答案)
  → 下一 turn 的 build_context 自带「ask_user + 答案」,模型看到结果
  → emit(AskUserResolved 或经 store);eta-agent 把该 task 置回 `in_progress`
```

- **多 agent**:`AskUserStarted` 时 eta-agent 把「正在执行的 task」的 status 移到 `question`;答案回填时移回 `in_progress`,并解开 `question` 状态的任务等待。
- `ask_user` 覆盖单选+自定义 / 多选+自定义 / 填空。
- **`update_state` 只碰 session KV**;agent 的 `memory`(decision/preference/lesson)走 eta-agent 层的 `UpdateAgent`(写 registry),不在这。
- system prompt 里描述这些工具,AI 自己决定何时用 state 工具(跨轮记忆)、`ask_user`(澄清)。
- **system prompt 必须明确提及 state 工具**(否则 agent 总忘记)。
- 工具校验 3 次失败 → 走 ask_user 让用户纠正(双向交互)。

### 2.4 Tool 校验 + 重试 + 控制面权限(纯逻辑 hook)

```rust
// SDK 侧,不在 Tool trait 里:
// 1. 模型产出 tool args → jsonschema 校验 schema
// 2. 不合法 → error 反馈回模型重试(最多 3 次)
// 3. 仍失败 → 调内置 ask_user 抛给用户
```

依赖:`schemars`(工具作者 derive schema)+ `jsonschema`(SDK 校验)。两者纯。

**控制面权限(`ControlPlanePrompt`,fail-closed)**:

```rust
pub struct ControlPlanePrompt {
    pub request_id: String,
    pub action: ControlPlaneAction,  // 想做的事:ExecuteTool / CreateAgent / SendToAgent ...
    pub tool_call: Option<ToolCall>, // 被授权的 tool(若涉及)
    pub context: Value,              // 给人看的一行摘要
}

pub enum ControlPlaneDecision { Allow, Deny { reason: String } }
```

- 需要授权的 tool(在 system prompt / registry 里标 `requires_approval`)在执行前,core 调 `AgentHooks::on_control_plane_prompt`。
- **fail-closed**:hook 返回 `Deny`(默认就是 Deny)→ 拒绝执行,把 `tool_result = "permission denied"` 反馈给模型,模型自行换路。
- 没有 hook 实现、或超时无响应 → `Deny`。**默认拒绝,不默认放行**。

### 2.5 `drive_loop`(队列 + steer + 模型级重试 + mid-loop summarization)

```rust
loop {
    if cancel.is_cancelled() { break; }
    emit(TurnStart);
    let context = store.build_context();                  // 每 turn 从 store 拼 context(前缀稳定)
    let mut stream = run_step_with_retry(model, &context, opts).await?;
    let mut had_tools = false;
    while let Some(ev) = stream.next().await {
        match ev {
            Ok(Event::Content(c)) => store.append(c),
            Ok(Event::ToolCall{name, args}) => {
                if name == "ask_user" { /* 2.3 special case,阻塞等答案 */ }
                else { store.append(run_tool(name, args).await); }
                had_tools = true;
            }
            Ok(Event::End{usage, stop}) => { self.usage.merge(usage); /* 截断处理由 run_step_with_retry 接管 */ }
            Err(e) => { /* 流中错误:记 store,交给 run_step_with_retry 决定重试/上报 */ }
        }
        maybe_summarize_mid_loop();                        // 逼近上限异步、严重超限阻塞
    }
    emit(TurnEnd);
    if should_stop_after_turn(...) { break; }

    // 结束条件(只 dequeue 一次,不重复):
    if let Some(next) = dequeue_driver() { push(next); continue; }   // driver(goal 续命/loop/steer/resume)优先
    if had_tools { continue; }                                       // 喂 tool 结果回模型(结果已在 store)
    break;                                                           // 无 driver 且无 tool → 停
}
```

**模型级重试**(`run_step_with_retry`,包住**整个消费循环**,一次重试 = 重新发起一次 provider 调用):
- **中途错误**(`Err(e)`,rate limit / 网络 / API):记录到 store 后重跑,最多 N 次;重试时注入 continuation marker。
- **output token 超限**(`End{stop: MaxTokens}`):注入「切小块继续」reminder,重试。
- **空响应**(`EndTurn` 且无 Content / ToolCall):注入 continuation,重试(带 turn 预算上限)。
- **single-message loop**:注入 loop reminder,重试一次(再 loop 抛)。
- 配套单测覆盖这三条重试路径。

> 关键:因为 `Item = Result<Event, _>` 且 `End` 带 `stop_reason`,这三条重试路径**可判别**——截断不再依赖猜,token 撞限不再和自然结束混淆。

**mid-loop summarization**:每个 step 检查 token/image 用量,逼近上限异步开 background summarization,严重超限阻塞等完成。它是**轮内、临时的应急压缩**(见 2.8 的 summarizer 边界),结果可能被 compaction 覆盖。

### 2.6 goal 自我续命(`eta-core` 模块)

- **goal 是 turn 内的续命**——一个 goal 跑到完成(turn 内 `GoalContinuation` 续命 driver 入队)。
- **续命 gate(`GoalContinuationGate`)**:goal 管理器在 turn 结束时不再无条件续命,而是先问 `AgentHooks::goal_continuation_gate()`:
  - `AutoContinue`(默认):契约照旧——goal active 且未达成且未反spin → 入队 `GoalContinuation`。
  - `Delegated`:goal **保持 active(不 Pause、不 Clear)**,但**自主续命被 hook 掉**——goal 管理器不再入队 `GoalContinuation`,goal 处于「等待外部推进」状态。
- **终止契约**:drive_loop 的 `dequeue_driver()` 分支即 goal 的出路,`break` 只发生在「无 active goal 且无 driver」(真正空闲)。`Delegated` 下因为 gate 不再入队,若无外部 driver agent 自然回到 idle——**这正是 master 并行阶段的期望态**(见 2.10)。
- `GoalState{objective,status,continuation_count,idle_without_tools,active_duration_ms,last_accrued_at}` + `build_goal_pursuit_guidelines()` + anti-spin(连续 3 轮空转无工具 → 自动 Paused,停止续命)+ streak reset + 复活;可选 evaluator。
- **从 AutoContinue → Delegated 的转换(外部信号)**:上层在 master 进入并行执行阶段时(发出 `/goal` 并 spawn 完子 agent 后)把 gate 切到 `Delegated`;master 的 goal 从此只由外部信号推进。
- **GoalState 加一字段 `blocked_reason`**(可选,`: question-pending | none`):「全 question」时标记成 `question-pending`,master 保持在 `Delegated`(等待用户),不作为「自然完成」综合。其余情况见 2.10 的收纳终态判定。

### 2.7 loop(turn 外触发器,独立调度器)

- **loop 从 TurnDriver 里独立出来**,是**自带持久状态的不同子系统**——不是「往队列塞一条 driver」的语义。
- **`LoopManager`(core 模块,独立于 goal)**:
  - registry:`loop_id`、`trigger(Cron{schedule} | Hook{event_filter})`、`enabled`、`last_fired_at`、`run_count`、`state`,持久化在 store。
  - 触发:cron 到点 / hook 事件命中 → `LoopManager` 发 `AgentInput::Loop { loop_id, prompt }`(打断当前 turn + 注入 prompt,区别于用户 `Steer`)。
  - `LoopManager` 拥有自己的调度评估(下一次触发时间、订阅哪些事件),**不依赖 goal 状态机**;和 goal 唯一的交集是都会把一个输入投进 agent 队列。
- **区别**:goal = turn 内自我续命(模型驱动,直到完成);loop = turn 外按时/按事件的触发器(时钟/事件驱动,独立评估)。
- **多 agent 模式:只有主有 loop**;子 agent 不设 loop。

### 2.8 self-mgmt(`eta-core` 模块)

`LoopDetector`(单消息周期检测、code-fence、fail-open)+ 摘要 + compaction。

**三个 summarizer 用一个,不做三套**(消除边界重叠):
- **mid-loop**(已有,2.5):轮内、被动的**应急**压缩,只为了当下这一步别溢出;产出是**临时的**,会被 compaction 覆盖。
- **compaction**:turn 间、**权威**的裁剪,重写前缀、丢 tool 噪音、重注入 durable 块、bump `compaction_epoch`(invalidate cache)。**它是唯一的真摘要器**。
- **self-summary**(原来的第三套):不是独立机制,而是 **compaction 的归档输出**——compaction 在压缩时顺带产一份 durable summary 写进 `summary_archives`,供后续 `build_context` 和跨 session 记忆使用。预算压力和解耦都没有自己的触发源。

#### compaction(去 tool call 临时 context + 摘要)

- **分区**:`system` + `user_info` 原样保留;最后一个 user 消息作切分点,尾部(最近 user query + 后续)保活不摘要。
- **LLM 摘要**:中部上下文折成 `[Previous conversation summary]`;重试 + 「写短点」重试 + 预算减半兜底。
- **丢 tool 临时 context(最小化,保证配对完整)**:`TOOL_MESSAGE_DROP_THRESHOLD = 0.25`——中部 tool 消息占比 ≥25% 时,**只整轮丢弃**:一个 assistant tool_use 消息连同它配对的 tool_result 消息,只有在**两者都完全落在切分点之前**才丢;任何一对里有一半在保留区,整对都保留。绝不拆半对。于是重拼出的对话在 provider 侧永远不会出现悬空 tool_use / tool_result。
- **durable blocks 重注入**:plan / todos / skills / mode-prompt 等关键块在摘要前后重新注入,不丢。
- **deterministic 兜底**:LLM 摘要失败时,max-min-fair 截断到 char 预算,并标注「untrusted / informational」(防 prompt injection)。
- **阈值触发**:约 80% context window(`keep_recent_tokens` 保尾),每 turn 前检查。

#### 进化(evo,compaction 后后台 job)

compaction 完成后起后台 job,agent 回顾本次会话犯错的地方(tool call 失败等),自行修正/新增 `memory.lessons`(走 `UpdateAgent`,写 core 的 `MemoryStore` trait)。

- **工具/技能提升**:compaction 时统计高频调用的 tool/skill,被反复调用的写进该 agent 的 `skill`(registry,走 `UpdateAgent`),下次默认直拉、不再搜索。

### 2.9 session state / context 拼装 / cache 纪律

- **session state 进 store**:`SessionStorage` 存强类型的 `SessionState`(信封强类型,内容 `Value`):`id`(uuidv7,每个 session 唯一)+ `prefix`(append-only 稳定前缀)+ `turns`(粒度化 turn 边界)+ `summary`/`summary_archives` + `compaction_epoch`/`prefix_invalidated` + `usage` + `kv_state` + `goal` + `custom`。
- **context 拼装(并入 session,无 ContextPlugin)**:每 turn `context = store.build_context()`,显式函数按序组装 —— `persona + role + memory`(稳定块)+ `skills 目录` + `mcp/tool 目录`(自适应块)+ 全量 messages + tools,交给 `Provider::stream`。渐进式披露的逻辑就写在这几个组装函数里。
- **cache 机制**:`compaction_epoch` 计数器 + 内容寻址 blob + 前缀 passthrough:
  - 每条 message 序列化成 **content-addressed blob**(哈希寻址),相同 message 复用同一 blob。
  - `build_context` 复用已持久化的 root-prompt 前缀 blob,只序列化新追加的 message(passthrough)。
  - 只有 compaction 才置 `prefix_invalidated`、bump `compaction_epoch`,重算前缀。
- **cache 纪律与渐进式披露(1.3 的定案)**:system prompt 分两部分——
  - **稳定块**(persona + role + memory):byte-stable,只有「进化」改 memory/skill 才重渲染 + bump version;**它是 cacheable 前缀的主体**。
  - **自适应块**(skills 目录 + mcp/tool 目录):**按预算降级**(全量 → 截断 desc(`MAX_TRUNCATED_DESCRIPTION_LENGTH=480`)→ 只留 path → 整个省略(`OmittedSkillsNotice`)),放在 system prompt **尾部、cache 边界之后**——它降级会改字节,但不碰已缓存前缀,不 invalidate cache。
  - 真正的 cache 大头是 **append-only 的 messages 前缀**(每 turn 只加 suffix,前缀逐字节稳定),这由 compaction_epoch 纪律保证,与自适应块无关。
  - 降级是**单调、turn 边界发生**的(每 turn 前查预算,过阈值才降一级,且不回退);一次降级 = 一次 assembly version bump,之后又 byte-stable 直到下次降级。
- **cache 核算**:`Event::End` 带 `Usage`(input/output/cache_read/cache_write),core 累加算「真实 cache rate」。

#### 渐进式披露 (progressive disclosure)

核心:**目录进 prompt,body/schema 按需拉**。

- **skills(grok 设计)**:system prompt 的自适应块放 `<skills>` 目录(name + description),body 按需拉(走通用 read 工具)。
  - **预算**:目录占 ~2% token budget;4 级降级(见上)。受保护 skill 名(loop 等)不省。
  - **默认直拉列表**:registry 的 `skill` 字段 = 该 agent 的默认 skill(always-on,body inline 直拉、不走搜索);其余走 catalog 搜索 + 按需读。
- **mcp / tools 一体化**:静态工具(原生 core 工具)常驻 prompt 稳定块;动态工具(MCP + 长尾)走「目录 → 拉 schema → call」。
  - system prompt 的自适应块只放**无 schema 的 server 目录**(`name` + tool 名列表 + 截断 desc)。
  - `GetTools`(discovery:catalog = 截断 desc 无 schema / 单 server = full schema / regex 搜索)+ `CallTool`(invocation);强制「先 discover 再 call」,没读 schema 就 call 报错指回。
- **memory(无 RAG,指令式懒读)**:只注入「name + overview + path」,指示模型「分段读、别一次读全」;不上向量检索。手动 attach 的 skill/memory 全文 inline。

#### 时间旅行 / 并行分支(git-like,手写)

核心是 **commit DAG + branch 指针**:

```rust
async fn fork(&self, name: &str) -> BranchId;      // 新 branch 指向当前 HEAD(不复制)
async fn commit(&self, message: &str) -> CommitId; // 存当前状态快照
async fn checkout(&self, branch_or_commit);        // 切换到某 branch/commit
async fn rollback(&self, to: CommitId);            // 回退到某 commit
async fn history(&self) -> Vec<CommitInfo>;        // commit log(沿 parent 链)
async fn merge(&self, other: BranchId);            // 合并分支
```

- **merge 强硬覆盖,新盖旧按 key**(kv key / goal,及 `custom` 里的 task id);消息拼接。
- **存储模型**:`commits(id, parents[], message, snapshot)` + `branches(name, head_commit_id)`。
- **snapshot = 全量 `SessionState` JSON**(先简单;后续优化成「append-only 消息 + 可变态快照」)。
- `checkout`/`rollback` 都是「把 HEAD 设到某 ref」;`fork` 只加指针不复制;`merge` 产生双 parent 的新 commit。

**SQLite 实现**(`eta-sqlite-storage`,唯一存储实现):`commits` 表(id 自增、parents、message、snapshot JSON blob)+ `branches` 表(name 主键、head_commit_id)。

**search**:`search(query) -> Vec<id>` —— SQLite 走 BM25(FTS5)。(JSONL 已砍,不再有 regex 分支。)

### 2.10 主从 agent 协作(`eta-agent` 层)

- **主 agent(master)**:分两阶段。
  - **前台 / 规划阶段**:唯一对用户的接口,所有问题主 agent 回答(规划、综合、日常对话)。
  - **并行执行阶段**:**进入契机 = `/goal`**——主 agent 发出 `/goal`(即创建大 task)并把子 agent spawn 出去后,立即把 goal 续命 gate 切到 `Delegated`(见 2.6),退为**后台协调者**:只吃 `loop`(cron + 看板状态转移 hook)+ `@` 协调指令 + 子 agent 上报,不再跑用户驱动的对话 turn;**master 自己的 goal 被 hook 掉、不自主续命**,推进只由外部信号(子 agent 完成 → 看板状态转移 → 综合作答)驱动。
  - **master goal 的完成判定(eta-agent 层,看板状态转移时检查)**:看板处于**收纳终态**即判完成——
    - **看板空**(所有 task `done`):master goal done,切回 `AutoContinue`,前台综合作答。
    - **所有 task 停在 `question`**(ask_user 全未决、无任何可推进项):master goal 也判完成,但 master **block 在等待用户**——不回 `AutoContinue`、不综合,保持 `Delegated`;直到用户答完某个 ask_user,看板重新流动(解锁 → 重排 → 继续 spawn),再次评估。两种情况都算「master goal 的当前阶段收尾」,不是必须全 success。
- **persona(人设)= 4 个内置 preset**(**on hold**):每个 agent 出生时从 `思考者` / `提倡者` / `落地者` / `艺术家` 选一个(内置 4 个 system prompt),随交互靠 memory + evo 成长为用户想要的角色。**4 个 prompt 的内容暂缓,需和心理学家一起写**——本期先只留结构占位,不落内容。
- **角色注入(role prompt,不进 persona)**:leader / follower 是运行时按当前角色**临时注入**的 system prompt,**不存进人格**:
  - **leader(领导)**:单 agent 升级成 master 时注入(带团队),同时**卸载 worker tools/skill**(只留协调工具),不可降级。
  - **follower(跟随者)**:任何 agent 被拉进当 subagent 时注入(听主调度、只报结果)。
- **子 agent(slave)**:共享主的 context,但**有自己的 skill/memory**(专事专版,不搞类型枚举)。
  - **来源**:之前的 task、主 agent 之前创建的、用户后续追加的(持久累积)。
- **挑选优先**:主 agent 需要帮手时,**优先挑选**合适的已有子 agent(按 skill/memory 匹配),没有才 `CreateAgent`。
- **犯错学习(自进化)**:进化放在 compaction(见 2.8)——compaction 后后台 job 让 agent 回顾犯错处,自行修正/新增 skill / memory.lesson。
- **loop 归属**:只有主 agent 有 loop;子 agent 不设 loop。
- **master 在并行阶段只吃 loop + @**:主 agent 进入并行执行态后,除 `loop`(cron / 状态转移 hook)与 @ 协调指令外不再驱动对话;用户协调主 agent(新增人员、调整任务、暂停子 agent)通过 `@主agent` 或看板状态转移 hook 实现,同一机制。
- **@mention(临时聊天,定案)**:可 `@某个 agent` 定向它发言。
  - **@ 子 agent**:该子 agent 把主 agent 的 loop/回合 context 和自己的 skill/memory/历史合并,直接跟用户聊一次。这是**临时会话**——独立于它的持久 goal/task 历史,回完即回到原任务;不写入子 agent 的持久消息流。
  - **@ 主 agent**:并行阶段主 agent 不在前台,`@主agent` 以协调指令投喂 —— 新增人员 / 调整任务 / 暂停某个子 agent 等,主 agent 收到后执行相应协调动作(改 kanban / 暂停 goal),不产生用户可见对话 turn。
  - 主 agent 仍是 task/goal 层面的唯一回答者;@ 是用户主动发起的一次性侧聊 / 协调,不改变任务归属。

#### system prompt 与 cache

- **system prompt = 分 section 拼**:`[persona(4 preset 之一)] + [role(leader/follower 临时注入)] + [memory(decision/preference/lesson)] + [skills(技能目录)]`。
- **稳定块**(persona + role + memory)组装一次后快照(byte-stable),**自适应块**(skills 目录)按预算降级(见 2.9)——两者边界即 cache 边界。
- **cache 保证**:子 agent 的 prompt = `[稳定 system prompt] + [共享的主 context(append-only)] + [本次任务]` → 前缀字节稳定 → 命中 provider prompt cache。
- **失效时机**:只有「进化」改 memory/skill 才重渲染 system prompt + bump epoch(稀有);skills 目录降级只改自适应块、不碰缓存前缀。

#### 通信两模式

- `send+response`:主 agent 发任务,阻塞等结果。
- `fire`:主 agent 发任务不等,子 agent 完成以消息唤醒主 agent——**唤醒是 eta-agent 层往主 agent 队列投普通输入**(`UserMessage`/自定义),core 不感知「后台完成」。图省事也允许用 `steer` 打断主 agent 当前 turn 注入结果。

#### 主 agent 工具

`CreateAgent` / `UpdateAgent` / `ListAgents` / `SendToAgent` + kanban `owner` 指派。

- **`UpdateAgent` 独立于 core 的 `update_state`**:`update_state`(core 内置)只写调用者自己的 session(`state`);`UpdateAgent`(eta-agent 工具)改 agent 的 `persona`/`memory`/`skill`——真源在 core 的 trait(按 owner key 存),registry 只存 `id`/`name` 索引(供挑选)。`persona`/`memory`/`skill` 不进 session。
- **`memory` 三分类**:
  - `decision`:用户强指令(如「前端框架一律用 react + wouter + tailwind + shadcn」)。
  - `preference`:用户弱偏好(如「比起 pg 我更喜欢 sqlite」)。
  - `lesson`:从犯错/失败学到的教训(如 toolcall 失败、被骂的原因)。

#### 生命周期(单 agent → master,不可降级)

- 一开始:用户从 4 个 preset(`思考者`/`提倡者`/`落地者`/`艺术家`)选一个,单 agent 用它回答。(preset 内容 on hold,结构先行。)
- **升级 master**:注入「领导」system prompt + 卸载 worker tools/skill(只留协调工具),不可降级。
- 需要帮手:主 agent **优先挑选**合适的子 agent,没有才创建,kanban 指派任务。
- 子 agent 共享主 context、用自己的 skill/memory 干活,报结果。
- 主 agent 综合后回答,始终是唯一回答者。

#### 任务 / kanban(多 agent 层)

- **kanban board**:`task = { id, desc, status, deps?, owner, progress }`,存 session state;`status` 四个 stage:
  - `todo`(backlog)
  - `in_progress`
  - `question`(需要用户回答,ask_user 答完 → 进 `in_progress`)
  - `done`
- **task = goal**:每个 task 就是一个 `/goal`,子 agent 把它塞进自己的 queue,挨个续命跑。
- **大 task / 子 task 平级**:都是 kanban 里平级 task,不嵌套;子 task 创建后,大 task 自动挂 `deps`。物理上一条共享 board(在 master session)。
- **管理权分层(看板权限)**:
  - **master 有全部管理权**:读所有 task + 增删改所有 task / deps / owner / 状态 / 重排 / 暂停。
  - **slave 只有自己的管理权 + 所有 task 的阅读权**:可读全部板面(获知上下文、看依赖在哪),但只能改 **owner == 自己** 的 task(状态、progress、拆自己的大块);不能建/删/改别人的 task,不能碰别人的 deps,不能重排。
  - **同一批 skill,靠 `owner` 字段判权**:调用 `CreateTask`/`SetDeps`/`AssignOwner`/`UpdateStatus` 时按调用者身份 + 目标 task 的 `owner` 校验——不是「谁都能调」,而是「master 全权、slave 读全写自己」。越权调用返回权限错误,反馈给模型自行更正。
- **完成规则(扁平 DAG)**:一个 task 的 deps 全部 done → 它自己 done(自动向上传播,无需专门上报);没有 deps(叶子)→ 由 owner agent 报告完成(仅 owner 能标 done)。父 task done 完全由 deps 边推出——就是「重算一遍 done-status」,不构造消息传播链。
- **分解 = 一种 turn 模式,不是两套机制**:master 的第一轮 `/goal` 和子 agent 的第一轮 `/goal` 是**同一个机制**——区别只在「这一层分解完是 `Delegated` 交出去(编排),还是保持 `AutoContinue` 自己接着干(执行)」。每一层 agent 把分解当成自己当前的一个 goal,跑 goal-continuation turn,直到一个 **signoff** 结束(见「分解 / 指派 harness」)。
- **调度 = deps 拓扑排序 + 就绪并行 spawn(master 专属,不在看板 skill 内)**:
  - **重排 + spawn 是 master 的职责**,不是看板 skill 的职责。master 的 `loop` 消费「板面状态转移事件」(hook)→ 重新拓扑排序 → 计算就绪集合 → 并行 spawn。slave 只负责「把 owner==自己的 task 状态改对 + 发状态转移事件」,不做调度决策。
  - 看板按 `deps` 做拓扑排序;**每次任务状态转移都重新拓扑排序**,重新计算就绪集合。
  - **就绪任务(所有前置依赖已完成)并行 spawn 对应子 agent**;有依赖未完成的任务继续等待,不提前执行。
  - 任务完成 → 状态转移 → 重排 → 可能解锁新的就绪任务 → 继续 spawn。主 agent 的协调指令(新增 / 调整 / 暂停任务)同样触发重排 + 状态转移。
- **级联控制**:`/cancel` → 级联暂停(当前 turn + 所有子 task 的 goal);`/continue` → 全体重启。
- **用户手动调节 task**:session 提供接口,用户可手动加 / 删 / 改 / 重排 / 挂 deps(和 agent 共用同一套 kanban)。
- **ask_user 联动**:子 agent/主 agent 触发 ask_user(2.3 的 `AskUserStarted`)→ 当前 task 移到 `question`;答案回填 → 移回 `in_progress`。

#### 分解 / 指派 harness(编排层)

核心:**让「分解」本身成为一个 goal 模式的 turn**,靠一个 signoff skill 结束并切成两态。这不是多 agent 的新引擎,就是 harness 层对「同一 core goal 机制」的编排。看板**不是 agent**——它是一组对共享板面数据动手的 **skill(`Tool` trait)**,由 `eta-kanban` 定义;调用权限按「管理权分层」校验(master 全权、slave 读全写自己)。

- **signoff = `FinalizeBreakdown`(一个特殊 skill,不进通用 `Tool` 分发)**:
  ```
  FinalizeBreakdown { subtasks: [T1, T2, ...]; assign: [owner?] }
    → 非空:分解完成 → 本 agent gate → Delegated,子 task 交给调度器
    → 空  :这是叶子 → 本 agent 保持 AutoContinue,直接执行该 task
  ```
  一个 skill 调用,两个分支。`subtasks: []` = agent 说「我直接干」。这是分解完成与否的**唯一确定性信号**——不靠 agent free-run 到「不想分解了」,可调试、可校验。
  - **signoff 受管理权约束**:master 的 signoff 可 `assign` 给任意子 agent(它全权);slave 的 signoff 只能 `assign` 给自己或自己名下 task 的 owner,拆出的小 task 必须落进自己**有权管理**的子树——越权 assign 被拒。
- **分解模式(decompose mode)**:该 agent 进入一个有界目标:一段 decompose 指令 + 受限工具面 —— kanban 技能(`CreateTask` / `SetDeps` / `AssignOwner`)+ agent 管理工具(`CreateAgent` / `ListAgents`)+ `FinalizeBreakdown`。成功谓词 = 产出合法子 task 集,以 signoff 收尾。
- **两级流程(同一机制,两种 role 策略)**:
  - **master 第一轮 `/goal`(orchestrator)**:进入分解模式,gate = `AutoContinue`;建大 task T1..Tn,`AssignOwner` 给子 agent;`FinalizeBreakdown{ non-empty }` → master gate → `Delegated`;调度器看到 T1..Tn 就绪 → 并行 spawn 子 agent,master 只剩 loop/@ 在听。
  - **子 agent 第一轮 `/goal`(worker)**:收到 Ti,进入分解模式;拆成小 task Ti.1..Ti.m(Ti.deps = 这些),assign 给自己或留空;`FinalizeBreakdown`:
    - 非空 → 调度器 spawn 执行;子 agent 要么当这些叶子的执行者(worker),要么也 `Delegated`(更深)。
    - 空 → 子 agent 保持 AutoContinue,直接干 Ti。
- **「叶子」判断权**:agent 推理为主(它最清楚这 task 能否直接干,`FinalizeBreakdown{[]}` 就是它声明「这是叶子、我自己来」),harness 加 `max_depth` 兜底——到深度上限还没 signoff 空列表,强制「不许再拆、直接执行」。两者合起来保证不会无限递归分解。
- **默认两档、策略可加深**:master 分解到大块就交出去、子 agent 分解到小块自己执行;机制是递归的(子 agent 就是递归的 core Agent),想更深(coder agent 团队常见 3 层)只需调 `decompose_policy`,不是换 harness。
- **传播复用 loop hook**:子 agent 叶子 done → 看板状态转移 hook 触发 master 的 `loop` 来重排 + 传播,不引入第二种驱动源。

#### observability / 对接

- **子 agent 事件进主 session 事件日志**:spawn(CreateAgent → agent id/name/memory)、completion(结果)、消息(SendToAgent,fire/send+response)——这些是普通 tool call,落 `tool_result` entry(eta-agent 工具,不需要专门的 `subagent` entry)。
- **主从关系持久化**:agent registry(CreateAgent / UpdateAgent / ListAgents)跨 session 存,挑选子 agent 时读它。
- **犯错学习**:compaction 后写子 agent 的 skill / memory.lesson(经 `MemoryStore`/`SkillStore` trait)。
- **外部走 tracing**:子 agent 是独立 agent loop,自己的 provider / 工具执行各自走 tracing。
- **对接**:`eta-agent` = `eta-core` 上的一层**工具**(CreateAgent / SendToAgent = `Tool` impl),不碰 core loop;子 agent 就是递归的 `eta-core::Agent`。

---

## 3. 实施顺序

- **Phase 1(已完成)**:workspace 骨架 + `eta-llm`(`Provider`/`Event`/`Context`/`ProviderError` + 错误面)+ mock providers + 测试。(`ThroughputMeter` 已删,不入 eta-llm。)
- **Phase 2 — core agent(单 agent,完整)**:`Agent` 句柄 + `Tool` trait + `drive_loop`(驱动队列 + steer + 模型级重试 + mid-loop summarization)+ 校验/重试/权限 + 内置 state 工具(ask_user/update_state/check_state/list_state)+ goal 续命 + self-mgmt + session 的 build_context/compaction。里程碑 = 单 agent 跑通一个完整 turn。
- **Phase 3 — 多 agent 层(主从 + kanban / task)**:在 `eta-core` 上搭 `eta-agent`——kanban board(task = goal、deps、owner)、大 / 子 task 分解、agent 创建/挑选/通信工具(`CreateAgent`/`UpdateAgent`/`ListAgents`/`SendToAgent`)、级联 pause / resume、犯错学习。
- **Phase 4 — adapters**:`eta-provider-*`、`eta-io-tools`、`eta-sqlite-storage`、`eta-mcp`、`eta-anycodingagent-config-reader`(+ `eta-config`)。

---

## 4. 依赖清单

**core(纯,零 IO)** —— `eta-llm`:`serde` / `serde_json`。
`eta-core`:`serde` / `serde_json` / `tokio` / `tokio-stream` / `tokio-util` / `async-trait` / `thiserror` / `tracing` / `uuid`(v7)/ `schemars` / `jsonschema`,依赖 `eta-llm`。

**`eta-session`**:依赖 `eta-core`;`etagere`... 以实现存储(无额外重型依赖,存储实现本身走 adapter)。
**`eta-agent`**:依赖 `eta-core` + `eta-session`。

**adapter(按需)**:`reqwest`、`rusqlite`(bundled)、`toml`。
`eta-anycodingagent-config-reader` 依赖 `eta-config`。

---

## 5. 范围外(out of scope)

沙箱/box/VM、redaction/protobuf、Electron/gateway/host-lock、37 个 context-processing 模块、HTTP/SSE/OAuth/AWS provider 实现、桌面 auth、cloud agents、teach recording、**4 个 persona 的具体内容(与心理学家一起写,on hold)**。

---

## 6. 一句话总结

> 纯 trait + 纯逻辑的 core:主从 agent;主 agent 唯一回答、优先挑选合适的子 agent 指派;子 agent 共享主 context、用自己的 skill/memory 干活、犯错学习自进化;@ 是一次性临时侧聊。core 只吃 trait、能不强类型就不强类型、零 IO(runtime=tokio);session 负责 context 拼装 + 分支;插件系统暂缓。
