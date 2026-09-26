# REFACTOR: Eta Kernel + Plugin Architecture

> 本文档是重构的唯一规格。由 eta-agent 主仓 360 commit 的实战语义 + 架构讨论定稿。
> 工作目录：`~/Desktop/eta-agent-plugin`；参照目录：`~/Desktop/eta-agent`（功能语义的来源，测试搬家的地方）。
> 与上一版的差异：loop 踢出 kernel、SealedFlags 整体删除、runner 收进 kernel、drive/ 整层废弃、hook 系统废弃、sqlite 换 jsonl。

---

## 0. 不变量（每一步的验收标准）

1. **kernel 只含 runner 直接消费的原语**：goal / persona / tasks + 自动续杯 + `inject()` 入口 + `maxTurns`。
2. **正交判据**：runner 直接调用的 → kernel；通过 inject / 事件 / bus 间接驱动的 → 插件。没有第三类。
3. **runner 不 import storage / prompts / 任何插件**。bus 是唯一事件系统，不存在 hook。
4. **eta-core 里出现文件路径、jsonl、网络、prompt 文案 = 越界。**
5. 六个耦合裁决（§3.4）是纪律，违反即为 bug。

---

## 1. 架构总览

### 1.1 依赖方向

```
eta-core (kernel)
  │  提供：cordis Context + runner(纯 turn 循环) + 三原语 + 类型面 + service 接口
  │  不知道：磁盘、网络、插件加载、多 session、prompt 文案
  │  一个实例 = 一个 session 的完整运行时
  ▼
eta-server (harness)
  │  多 kernel 宿主：创建/销毁 kernel、注入 StorageService、加载插件
  │  磁盘 IO、WS transport、HTTP、全局配置、provider registry、SSH remote
  │  subagent / btw（都是"在父 session 旁边新建 kernel 实例"）
  ▼
eta-client (view)
  │  消费 transport 推送；渲染 UI 与插件 iframe
```

### 1.2 核心模型

一个 server 进程管理 N 个 kernel 实例。**cordis Context 天然是树**，直接利用：

```
server 进程（root cordis Context）
  │  全局层插件挂在 root：providers · config · remote · 插件扫描 · transport
  │  【搁置】driver agent：server 顶层的调度者（loop 的语义主体），见 §9
  │
  ├── session A → child Context A
  │     kernel: runner + goal + persona + tasks（Service 直挂，不进 plugin registry）
  │     插件: tools · ask · skills · compaction · drift · memory · prompts
  │     maxTurns: null
  │
  ├── subagent B（A 的子任务）→ child Context B
  │     maxTurns: N
  │     插件集 = 工具类插件；不装 subagent / goal 续杯
  │     → "封印" = 缺席，不是标志位（见 §1.4）
  │
  └── btw C（A 的侧请求）→ child Context C
        spawn 时快照 A 的 requestState（不是活引用）
        工具集排除 ask_user
```

### 1.3 共享 vs 隔离

**全局层（root ctx，所有 session 共享）：**
config（~/.eta/config.json）、provider registry（含自定义 headers 透传）、SSH remote、插件代码扫描、transport、HTTP。

**session 层（child ctx，每 session 独立）：**
runner 状态（内存 transcript）、三原语状态、StorageService 实例、tools（cwd/.agents/tools/）、skills、compaction、persona 发现（cwd/.eta/persona/）、用户插件实例。

cordis 的父子 Context 继承正好表达"共享层插件全局一份、session 层各自实例化"，不需要自造机制。

### 1.4 "封印"的统一表达：缺席

上一版有 `SealedFlags { goal, loop }`，是给错误分层打的补丁，整体删除：

| 旧概念 | 新表达 |
|---|---|
| seal spawn | 子 kernel 不装 subagent 插件（`spawn` 工具根本不存在）→ "只允许一层"零代码实现 |
| seal goal 续杯 | 子 kernel 的 runner 不带 goal driver（goal 没设置 = 无续杯 = single-shot） |
| btw 排除 ask_user | btw kernel 不装 ask 插件；若模型仍调用 → unknown tool，绝不阻塞 |

（loop 已不在 session 层，无需 seal —— 见 §9。）

### 1.5 核心约束

1. eta-core 不依赖 eta-server；不知道"多个 session"的存在。
2. server 起 kernel，注入 StorageService，装插件；kernel 不自己加载任何东西。
3. 事件总线在 session 内部，跨 session 通信只有 server 中转的两条消息通道（§5.5）。
4. subagent / btw 的创建路径与任何 session **完全一样**（server.createSession），区别只在插件集和 maxTurns。
5. 树形生命周期：父死 → 子 cascade delete。parent 是元数据，不是运行时依赖。
6. 插件装载/卸载不影响正在运行的 agent turn（cordis fiber dispose 等当前 effect 完成）。

---

## 2. eta-core（Kernel）

### 2.1 职责

一个 kernel 实例 = 一个 session 的运行时。

提供：
- cordis child Context（bus + service DI + fiber 生命周期）
- **Runner**：纯 turn 循环（§2.4）
- **GoalService / PersonaService / TaskService**：cordis Service 直挂（`Service` 子类走 reflect.provide，**不进 plugin registry**，`registry.delete()` 对它们天然 no-op —— 这就是"特权"的表达方式，不加标志位）
- `inject(message)` 入口：外部世界（用户输入、server 顶层唤醒、子 agent 输出）进入 turn 循环的唯一门
- `maxTurns: number | null`
- 类型面 + service 接口（StorageService / ToolService / Providers / Compaction）

不提供：文件系统、网络、插件加载、持久化实现、prompt 文案、多 session。

### 2.2 导出

```
@eta/core
  ├── Context, Service (from cordis)
  ├── Kernel                  实例：ctx + runner + 三原语 + inject + maxTurns
  ├── Runner                  turn 循环（§2.4）
  ├── GoalService             §2.3.1
  ├── PersonaService          §2.3.2
  ├── TaskService             §2.3.3
  ├── ToolService             接口；插件注册工具，runner 每轮现读
  ├── StorageService          接口；server 注入实现（§4）
  ├── Providers               = pi-ai Models 形状（不是新接口）
  ├── CompactionService       接口；默认实现是内置插件
  └── types/
        ├── entries.ts        Entry union：goal/ask/answer/btw/merge 一等类型
        ├── messages.ts       AgentMessage 等
        ├── events.ts         bus 事件词汇（type-only）
        ├── goal.ts / persona.ts / tasks.ts
        └── result.ts
```

### 2.3 三个原语

#### 2.3.1 GoalService

搬 `eta-agent: harness/goal.ts` 的 GoalManager 语义，**完整**：

- 状态机：`none → active → paused / achieved`，blockedReason（question-pending）
- anti-spin：连续 tool-free turn ≥ 3 自动 pause（`ANTI_SPIN_LIMIT = 3`）
- `maxContinuations = 12` 硬上限
- gate：`auto`（自驱续杯）/ `delegated`（外部信号驱动，master parallel phase）
- entry 重放恢复（`applyGoalEntries`）
- `lastMessageShowsIntent` 判定
- onChange 回调 → 改为 bus 事件：`goal:set / goal:changed / goal:achieved / goal:paused / goal:resumed / goal:cleared`

**纪律：goal 不得读 tasks。** 裁决只依据 GoalState；tasks 是给 agent 和人看的账本。

#### 2.3.2 PersonaService

搬 `harness/persona.ts` 纯内存部分：卡片存储、活跃 persona、missing 降级（session 不因 persona 卡丢失/大小写不匹配而消失，恢复时降级 + warn）。
文件发现、fs.watch 热重载 → server 侧。
事件：`persona:loaded / persona:switched / persona:missing`。

#### 2.3.3 TaskService

搬 `harness/task-store.ts`：四状态 + 依赖边 + renderTasks。
**工具（TaskCreate/List/Get/Update）不在 kernel** —— 那是 tools 插件的事；kernel 只出状态与事件。
事件：`task:created / task:updated / task:removed / task:completed / task:cancelled`。

### 2.4 Runner（kernel 的心脏，本重构最大改动）

纯 turn 循环。**drive/ 状态机（durable operation / reconcile / recovery / tool-placement）整体废弃**，约 4300 行不搬。

```
loop:
  1. 从内存 transcript 组装 context（persona 渲染、prompts 由插件注入 prompt 块）
  2. 现读 ToolService 拿当前工具集
  3. 调 Providers（pi-ai Models seam）生成
  4. 有 tool calls → 执行 → 结果进 transcript，bus 发 turn:* / tool:* 事件，回 1
  5. 无 tool calls → run boundary：
     a. empty-response guard：provider 空停 → nudge 重试（预算 2 次）
     b. goal.decide(currentRun)：active 且 evaluator 判未达成 → 续杯注入，回 1
        tool-free 的 run 喂 anti-spin 计数
     c. 否则结束；检查 inject 队列，有则开新 turn
  全程受 maxTurns 约束（null = 不限）
```

**为什么废弃 drive/**：pi 把控制流和持久化焊死（每步先落盘再执行），是为了"kill -9 后半个 tool call 精确恢复"的承诺。我们的语义：**崩溃恢复到上一个稳定边界（最后一条完整 entry），半截 turn 当没发生过**。turn 幂等可重来，不需要 halfway operation 恢复。落盘变成 bus 订阅者（StorageService），不再是控制流的一部分。

**为什么废弃 hook/**：pi 的 hook（before_run_end / before_tool_call...）是没有 bus 的系统里凿的洞。替代方案：

| pi hook | 新机制 |
|---|---|
| before_run_end（goal/loop 续杯） | runner 直调 GoalService（机制，不是回调）。旧"单 followUp 槽静默覆盖"bug 的根除 |
| before/after_tool_call（门控/改写） | ToolService middleware 链，插件注册 |
| session:before_compact 等 | 换插件 |

### 2.5 inject()

外部世界进入 turn 循环的唯一入口。用户输入、server 顶层唤醒、子 agent 输出注入，统统是 `inject(message)`。循环内语义：当前 turn 结束后进入队列消费。

---

## 3. 耦合审查（定稿裁决）

架构定稿前逐对检查过耦合，以下 6 条是裁决结果，**违反即 bug**：

1. **runner → goal：刻意融合。** 接口窄到一个方法（`decide(currentRun) → continue | stop`）；goal 不得反向知道 runner。
2. **loop → kernel：零耦合。** kernel 里没有 loop 的任何痕迹。唤醒路径统一为 `inject()`（§9 driver 定稿后由 driver 调用）。（这条审查直接把 loop 踢出了 kernel，随后又被踢出了 session 层。）
3. **goal 不读 tasks。** 原语之间零依赖。
4. **compaction 对 runner 的权限收窄到两个方法**：`readContext()` / `replaceContext(summary)`。
5. **btw 拿父 lane requestState 的 spawn 时刻快照**，不是活引用 —— 两个 kernel 之间不存在共享可变状态。
6. **storage 订阅落盘：同 session 内有序（cordis emit 同步派发即可保证），runner 不等 ack。**

cordis 已知特性（别再踩）：
- `Service` 子类走 reflect.provide，不进 plugin registry —— 特权原语用它表达
- `ctx.get()` / `ctx.<key>` 返回 traceable 视图，测试断言共享状态，不断言引用相等
- cordis 的 `lib/*.d.ts` 是无扩展名 re-export → moduleResolution 必须 Bundler，不能 Node16

---

## 4. StorageService

### 4.1 接口（eta-core 导出）

```
abstract class StorageService extends Service {
  static provide = 'storage'
  // KV
  get / set / delete / list(prefix)
  // journal
  append(entry): Promise<Entry>
  readJournal(opts?): Promise<Entry[]>
  // 维护
  compactJournal(): Promise<void>   // 从活状态重写，fsync + 原子替换
  repairTornTail(): Promise<void>   // 扫全文件跳过坏行，绝不在第一个坏行 break 丢弃后续好历史
  flush(): Promise<void>            // fsync
  close(): Promise<void>
}
```

### 4.2 实现：@eta/storage-jsonl（sqlite 废弃）

- 每 session 一个 jsonl 文件；append 后 fsync（修复结果只进 page cache 不算修复）
- compactJournal 用活状态原子重写，避免无限 append 后重放百万行
- 崩溃恢复 = replay 到稳定边界（最后完整 entry），半截 turn 丢弃

---

## 5. eta-server（Harness）

### 5.1 职责与启动

root cordis Context。启动序列：config → provider registry → 插件扫描缓存 → HTTP/WS transport → SessionManager（恢复 session 列表，逐 session 起 child kernel）→ 热重载 watcher。

### 5.2 创建一个 session

```
1. 分配 ~/.eta/sessions/<id>/
2. Kernel.create({ maxTurns })           ← child Context + runner + 三原语
3. new JsonlStorageService(kernel.ctx)   ← 注入
4. 装 session 插件：tools · ask · skills · compaction · drift · memory · prompts
5. 注入全局引用（providers/remote，闭包传参）
```

### 5.3 Subagent

- `spawn` = server.createSession，**与创建任何 session 完全同路径**，区别：maxTurns=N、插件集无 subagent/goal 续杯
- 返回 handle；handle 只有两个操作：`abort`、`peek`
- spawn 调用的 tool_end 返回 handle；**子完成不产生 tool_end** —— 最终输出直接 `inject()` 进父的消息流
- 父死 → 子 cascade delete；子不知父，父不知子内部
- "只允许一层"：子 kernel 没装 subagent 插件，spawn 工具不存在

### 5.4 BTW

- 同为 createSession；**spawn 时刻快照**父 lane requestState（model/thinking/tools 配置），排除 ask_user
- 快速非阻塞；完成 → note `inject()` 进父消息流
- 遵守树形生命周期

### 5.5 跨 session 通信

bus 不跨 session。仅两条 server 中转通道：父→子 = 创建时写入初始 task；子→父 = 完成时 inject 输出。transport 推送是观察通道，不是 session 间通道。

---

## 6. Plugin 系统

### 6.1 接口与加载

```
interface EtaPlugin {
  name?: string
  inject?: string[]
  apply(ctx: Context, config?): void | (() => void)
}
```

- 全局插件：server 启动时装在 root ctx，一次
- session 插件 + 用户插件：每 kernel 实例创建时装在 child ctx，各自实例化
- 发现：`~/.eta/modules/`（内置）+ `~/.eta/plugins/`（第三方），启动扫描缓存
- 热重载：dispose 旧 fiber → 重载；正在运行的 turn 不受影响

### 6.2 内置插件清单（全部从 eta-agent 搬语义 + 测试）

| 插件 | 来源（eta-agent） | 语义要点 |
|---|---|---|
| tools | harness/tools/ | read/write/edit/**bash**（小写！）+ cron/KV；经 ToolService 注册 + middleware 门控 |
| ask | harness/ask.ts | eta.ask/answer entry 持久化、replay、timeout/abort→none、kill-restart-answer |
| prompts | prompts/ | friend-voice 模板库；模型可见文案唯一出处 |
| skills | harness/skills.ts | 向上扫 .agents/skills（cwd+home+git root+submodule，去重）、fs.watch 热重载、注入 system prompt |
| compaction | harness/compaction/ | ✅ **已完成**：`@eta/compaction`（`etaCompaction()`）——切点（tool pair 不拆）、25% tool-pair drop、按窗口折叠的增量摘要（每片都是对已有 notes 的 update）、max-min-fair digest 回退（永不返回空）、split turn 前缀摘要、`<read-files>`/`<modified-files>` 落进 compaction entry 的 details。ceiling 在 kernel 的 `shouldCompact`。**未搬**：`reducePromptBudget`（eta-agent 里只有它自己的测试调用，死代码）、`economics.decideCompaction`（全仓无调用点） |
| drift | harness drift | doom/tail/similar 检测，订阅 bus |
| memory | harness/memory.ts | scan/cache/幂等 extraction、注入 composer、压缩存活 |
| btw | harness/btw.ts | seed filter、Q/A replay、save 状态机、handoff、快照 |
| subagent | harness/subagent.ts | pool、ownership、usage rollup、turn limit、depth=1（缺席实现） |
| storage-jsonl | 新写 | §4.2 |

### 6.3 Plugin UI

后端插件注册 **panel 描述符**（纯数据）→ server 推 client → client 的 cordis context + slot（sidebar/panel/overlay/statusbar）挂载 iframe → postMessage 桥。前后端插件的唯一连接点是描述符。静态路由 `GET /plugins/:name/ui/*`。（细节沿用上一版 §7，无变更。）

---

## 7. 移植红线（别再踩的坑）

1. `erasableSyntaxOnly`：禁用 parameter properties
2. moduleResolution = Bundler（cordis d.ts 无扩展名 re-export，Node16 静默丢成员）
3. 工具名全小写（`bash`；报 "Tool 'Bash' is unavailable" 先查自己）
4. import 改写按"specifier 解析到目标文件再起名"，不做字符串匹配；改名按符号改，不 sed
5. 无 hook：模型可见文案收敛到 prompts 插件，server/harness 不散落硬编码英文
6. fork 不引 parentSessionId：fork 就是 fork，继承 lane config + meta，丢 loops 和 task list
   - core 只拥有 entry 链选择（`session/fork.ts` selectBranchFork/forkChain，position at/before）；复制 lane config / meta、丢弃 loops+tasks 是**目的 session 的装配方**（未来的 server session repo）在做，core 不预留 values store
   - `append` 一定推进 tip；写侧分支后要用 `setTip` 把分支视图移回去
7. queue pull-back 必须保住 image blocks（mime/base64 进 view，回填 attachment chips，不当文字塞回）
8. 每完成一个 task：打勾 + commit，工作树不留半成品

---

## 9. 搁置：server 顶层设计与 driver agent

本节是**未决设计**，先记录结论与开放问题，Kernel 阶段（K0–K5）不实现、不预留接口。

### 9.1 已定结论

1. **loop 不属于 session。** loop 的语义主体是"对全局有意志的东西"，不是某个 workspace 里的 agent。session 内的 agent 不该知道自己之外的 session，更不该持有跨 session 的调度意志。
2. **server 需要一个 driver agent**：住在 server 顶层（root ctx 附近），看得见所有 workspace / session / agent，loop 是它的闹钟 —— 到点由 driver 决定往哪个 session `inject()` 什么。personal agent 也只有在这个位置才成立（超越单个 workspace 的持久存在）。
3. **workspace 概念**：session 已有 working dir；同 workspace 下的 agent 共享消息是值得做的（同事建议），具体形态随 driver 一起定。
4. eta-agent 现有 loop 语义（pump/jitter/expiry/maxRuns/event filters、动态 nextDueAt、30s heartbeat，`harness/loops.ts` + `harness/drivers.ts`）是 driver 实现时的功能规格，届时搬语义不搬挂载点。

### 9.2 开放问题（定稿前必须回答）

1. **对话路由**：用户开口是跟 workspace agent 直接说，还是跟 driver 说、由 driver 分派？UX 主体是谁？
2. **指挥权冲突**：driver 与 workspace agent 的指令冲突时谁赢？driver 能否打断/改写正在跑的 session？
3. 初步倾向（未拍板）：driver 只做调度与观察、不做对话；用户始终跟 workspace agent 对话。

---

## 10. 执行计划（Kernel 阶段，K0–K5）

工作目录 `~/Desktop/eta-agent-plugin`（eta-agent 的 worktree），从 `ea23d65` 开分支 `refactor/kernel-plugins`。同事上一轮的 13 个 commit 不 cherry-pick（kernel 骨架的 cordis Service 模式可参考，其余是 pi 搬运工，扔）。完成一项勾一项 commit 一项。

- **K0 定稿清场**：本文件落盘；eta-core 削到骨架
- **K1 类型面 + bus 词汇**：Entry union 一等类型（goal/ask/answer/btw/merge）、事件词汇
- **K2 三原语**：GoalService（含 anti-spin/gate/重放）、PersonaService、TaskService + Kernel 装配（inject/maxTurns）。逐个 commit，测试从 eta-agent 搬家
- **K3 Runner**：纯 turn 循环 + 去 hook 化的 run boundary（goalDriver + emptyResponseGuard 变直调）+ inject 队列。假 provider 验收：多轮 tool 循环、goal 续杯真实发生、空回复 nudge、inject 中途生效
- **K4 session 语义**：fork（entryId）/ merge（双父 splice）/ rollback，纯 entry 图算法，storage 无关
- **K5 storage**：StorageService 接口 + @eta/storage-jsonl（append+fsync、compactJournal、repairTornTail）；kill-restart 恢复验收

后续阶段（server 插件批 / subagent / btw / transport / client）按 §6.2 清单推进，另行展开。

### 进度（Kernel 阶段）

第一轮 K0–K5 交付的是"能跑通的最小骨架"：接口是我手写的简化形状，语义深度不够（没有流式、重试、overflow、队列模式、usage 记账、abort）。第二轮按"该抄的必须抄够"重做，全部对齐 eta-agent 的源语义：

- [x] K0 定稿清场
- [x] K1 类型面 + bus 词汇（`types/entries.ts` `types/events.ts` `types/tasks.ts` `types/persona.ts`）
- [x] K2 三原语 + Kernel 装配（`kernel/goal.ts` `kernel/tasks.ts` `kernel/persona.ts` `kernel/kernel.ts`）
- [x] K3 Runner（`kernel/runner.ts` `kernel/tools.ts` `kernel/providers.ts`）
- [x] K4 session 语义（`session/graph.ts` `session/fork.ts` `session/merge.ts`）
- [x] K5 storage（`storage/types.ts` `storage/state.ts` `storage/memory.ts` `session/session-log.ts` + `@eta/storage-jsonl`）

第二轮（纠偏 + 补齐，逐项对齐 eta-agent 源码）：

- [x] A1 恢复语义改回"最后一条完整 entry"；A2 StorageService 用 eta-agent 的真实语义重定（commit 写批 / usage 行 / namespace KV / branch scan / stats，语义集中在 `InMemoryStorageState`）；A3 事件词汇对齐 `ETA_EVENT_CATEGORIES`
- [x] B1 `KernelConfig`（+ `validateRetryPolicy`/`validateCompactionSettings`/`validateToolNames`）；B2 流式 generation（`AssistantStreamObserver` + `OutputRate`）；B3 retry（分类 + 指数退避 + abortable wait）；B4 overflow recovery（一次 compaction + 重试）；B5 队列（steer/followUp/nextRun + QueueMode + 边界消费规则 + `InvalidMessage`）；B6 `toolExecution` 并行/串行 + `MutationQueue`；B7 abort（effect-gate）；B8 usage 记账（UsageRow 与 entry 同 commit）；B9 compaction seam + 纯函数（含 #40 的 window-independent ceiling）；B10 `requestState()`；B11 解析链（systemPrompt/toolContext/toProviderMessages/entryProjectors）
- [x] C1 Entry 保真（details / terminate 并真的生效）；C2 读 eta-agent 的 `{w,t}` journal（未知写入跳过并计数、orphan 断枝不失败）
- [x] D1–D3 三原语逐行对照补测；E1 端到端综合测试（stream/usage/retry/overflow/queue/abort/goal/persona/落盘/重放）

### 第三轮：把不该在 runner 里的东西拿出去（按你的 review）

runner 是 turn 循环，不是服务容器。这轮把四件事抽成 kernel service / 纯函数，并给 compaction 三个信号：

| 抽出的东西 | 现在的形状 | runner 剩下的耦合 |
|---|---|---|
| compaction 的 when/how | `CompactionService`（provide `compaction`）：`manual()` / `threshold()` / `overflow()`；host seam 只有 readContext/replaceContext/entries/request；每 run 一次 overflow 恢复由服务自己订阅 `turn:run-start` 重置 | 两行：run 首个 turn 前 `await threshold()`、overflow 分支 `await overflow()` |
| 落盘 | `JournalingService`（provide `journaling`）：订阅 message:end / turn:end / compaction:end / turn:run-end 驱动 SessionLog，发 `entry:added`（带 id）与 `usage:recorded`；commit 串行、不阻塞循环，只有 run 边界 `flush()` 等盘 | 零：runner 只发事件，不 import SessionLog |
| tokens/sec | `MetricsService`（provide `metrics`）：订阅 turn:run-start / message:update / message:end，`kernel.metrics.tokensPerSec` | 零 |
| task reminder cadence | `TaskReminderService`（provide `taskReminder`）：订阅 turn:start / tool:end 维护 CadenceState，due 时发 `task:reminder-due`；`drain()` 给 prompts 插件取 | 零（cadence.ts 仍是纯函数） |
| 空闲唤醒 | `RunPump`：订阅 inject:received + turn:run-end，runner 空闲且有活就开 run；`runner.running` 是只读事实 | 零（runner 不再有 autoPump/pumping） |
| generation 的 retry/overflow/backoff | `generateWithRetry()` 纯函数（不是 service：它需要调用方的 context 组装、observer、signal、compaction，包成 service 只是把四样东西再绕一遍 bus） | takeTurn 变成"组装 → 生成 → 记账" |

**第四轮：session 的可恢复性补完**（本轮，四件事）

| 补的东西 | 现在是什么 |
|---|---|
| session 语义落盘 | `SessionLog.merge/rollback/forkAt`：merge 是一条 entry（第二父），rollback 把分支 tip 写成 value（`eta.session.tip`，每次 tip 移动写一次），`load` 读它。之前这些操作只在内存里，reload 会把 rollback 撤销的东西又捞回来 |
| 工具流式中间结果 | `ToolCallInfo.update` + `tool:update` 事件；channel 只在调用运行期间开放（settle/抛错/取消即关闭），partial 是克隆过的快照且永不落 journal |
| config / tasks 值落盘 | `eta.session.config`（整个 KernelConfig）与 `eta.tasks.state`（StoredTask[]，与 eta-agent 真实 journal 同命名空间），订阅者整份写、last write wins |
| session 装配 | `openSession({storage, models, config?})`：一条通路同时服务"新 session"和"重启"——重放 graph + tip、goal 从其 entries、ledger 从 value、config 从 value、transcript 从分支视图，并顺手接上 goal 的落盘订阅 |

顺带修掉被发现的两个真 bug：`ConfigService.update` 先发事件后装状态（订阅者读到旧值）；`commit()` 空转早退导致 rollback 的 tip 写不进去。真实模型 smoke 现在整条走 `openSession`，并断言配置确实是从盘上恢复的。

**compaction 插件（@eta/compaction）**：kernel 侧只有 seam 与"何时"（threshold/overflow/manual 三信号），摘要本身（prompt、切点、折叠、digest）全在这个包里，所以 kernel 里没有任何模型可见文案。真实模型验证：`test/smoke-compaction.e2e.test.ts`（env 门控）用真 provider 对一段真历史做 manual compaction——模型按格式写出 notes（Goal/Constraints/Progress…），关键事实（项目代号 KUMQUAT-7）穿过切点保留，压缩后继续提问仍能答出它。

**真实模型验收**（`bun run smoke`，env 门控，不硬编码任何 provider/model）：
- `test/smoke.e2e.test.ts`（eta-core，内存 storage）：真 provider 的 stream delta、真 usage、真工具调用、真落盘、重放后回答
- `test/smoke.e2e.test.ts`（eta-storage-jsonl，真文件）：同一场景写进 jsonl，关掉重开仍完整（repairTornTail 报告零损坏）
- reader 读 `~/.eta/config.json`（`ETA_SMOKE_CONFIG` 可换路径，`ETA_SMOKE_MODEL` 可换模型，默认用文件里的 `defaultModel`）

首次真实跑通时抓出两个真 bug（已修，见下）：turn 计数漏掉干净收尾的 turn；threshold compaction 只在 kernel 的第一个 turn 检查。

**刻意留在 runner 里的**（抽了就是回到 hook 地狱）：goal 续杯（裁决 1 的窄接口 `decide`）、inbox 消费时序（checkpoint / terminal boundary）、tool batch 与 allTerminate、maxTurns、effect-gate 准入、context 组装与投影、empty-response guard 的机制（文案仍在 prompts 插件）。

这轮的三个自定裁决（都写进代码注释）：

1. **`message:end` 不再带 entryId**，改为订阅者落盘后发 `entry:added {entry}`（eta-agent 的 message_end 带可选 entryId；但 id 在写下去之前不存在）。
2. **commit 粒度是 message**（不是 turn），串行、循环不等 ack；只有 **run 边界 flush 等盘**——所以"run 结束"就等于"已落盘"，崩溃/抛错路径也走同一个 flush。
3. **compaction 的每-run-once 恢复预算归服务**（eta-agent 把它放在 durable operation 状态里）。

### 第二轮的两处刻意偏离（都写进代码注释）

1. **不加 `fromHook`**：hook 机制已删，这个字段永远是 false——不留死字段。`customType`/`custom` entry 同理：插件显式扩 union，不搬 stringly-typed 后门（§6 裁决）。
2. **`shouldCompact` 加绝对上限**：eta-agent 只看 `contextWindow - reserveTokens`，memory #40/#50 明确要求 window-independent ceiling（默认 64k，`settings.maxContextTokens` 可覆盖）。另外模型不报 window 时用 ceiling 兜底——否则 `Math.min(NaN, ceiling)` 会让压缩静默失效（测试抓到的）。

### K5 恢复规则（对齐 §4.2 原文）

**replay 到最后一条完整 entry，半截 turn 丢弃，完好的 turn 保留。** 没有 run 标记、没有"丢弃整个 aborted run"：一个 commit 落盘即是状态，journal 里只有完整 turn（每 turn 一个原子 commit；半截 turn 根本没机会写进去——写一半的字节被 repairTornTail 裁掉）。重启后宿主重新驱动未完成的事（goal 续杯 / 用户重发），turn 幂等可重来。这就是删掉 drive/ 状态机换来的东西：一条规则代替一本账。

（上一版我擅自加了 run.started/boundary 值标记和整 run 丢弃 + KV 回滚，与 §4.2 冲突，已废弃。教训：语义级文档改动必须先提案后落盘。）
