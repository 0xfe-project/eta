# ETA-CORE-PLAN — eta-core(TypeScript)实现计划

> 哲学:**battery included minimal**。pi 的 minimal = 一切电池赶进 extension;我们的 minimal = 电池全部预装在 core 里,每节可关。没有 extension 装载机制——电池是模块,编译期内建。
>
> 做法:**不从头写。fork `pi/packages/agent`(v0.85.1,MIT)做基线,regex 改名 pi→eta,然后做外科手术 + 装电池。** 上游的运行时状态机、session 存储、compaction、工具循环、整套 vitest/conformance 全部白拿。
>
> 范围:对标 packages/agent 层。不含 TUI/GUI、不含 kanban 分解 harness。
>
> 已读码参考(全在 `refs/`,是行为与局部代码的来源,不是依赖):
>
> | 包 | LOC | 真正抄的东西 |
> |---|---|---|
> | pi-loop | 13.4k | Trigger 四态、pump+心跳、filter 语法、过期/上限语义(~400 行的语义,包体 13k 别抄) |
> | pi-ask-user | 2.4k | tool schema、答案归一化、timeout/abort/headless 语义(TUI 组件 2k 全丢) |
> | pi-subagents | 20.9k | manager 并发池语义、schedule 格式、RPC 信封(UI/workflow-vm 全丢) |
> | pi-tasks | ~2k | task-store 文件锁、reminder-cadence 纯函数 |
> | pi-btw | 2.3k(单文件) | 旁路子会话原语:种子过滤、线程合成对回放、followUp 注入 |
>
> 每条 `- [ ]` 末尾是完成条件。

---

## 0. Fork 策略(替代原 Part A/B 的重写)

- [x] F0.1 vendor import:`cp -r pi/packages/agent packages/eta-core` + 它的 test/,单个 commit 落地(记录上游 commit 到 `UPSTREAM.md`,以后同步 = 3-way merge,目录结构不许动)。完成条件:包能 build、**上游测试原样全绿**。
- [x] F0.2 改名 codemod:**只改自有标识符**(`pi-agent-core`→`@eta/core`、导出符号、telemetry 前缀);依赖 scope `@earendil-works/pi-ai` / `pi-telemetry` / `chord` **不改**(它们是被 import 的库,regex 一刀切会把 import 全杀掉)。完成条件:`rg -i "\bpi\b" src --glob '!pi-ai'` 只剩依赖名。
- [x] F0.3 白拿资产清单确认(runtime 状态机 7.5k / session repo+fork 4.4k / compaction 1.3k / hooks+telemetry+skills+prompt-templates 3.5k / tools 一套;`faux` provider 来自 pi-ai,单测不联网)。完成条件:vitest 全绿 + sqlite-node 后端 conformance 全绿(vendor 它;决策 D1:存储后端**只留 sqlite**,jsonl 后端整体移除)。
- [x] F0.4 lane/drive 状态机(**定案:保留不拆**):M1-M4 全绿(732 测试)证明它是重试/backoff/persistence 正确性的本体,电池全部挂 hook 复用,不砍不重写。

---

## Part B:对 fork 的外科手术(真实 delta)

> **组装管线(已核实)**:pi 每次 generation 现算 `systemPrompt`(string 或 fn,`drive/generation.ts:58-65`),随后 `transform_context` hook 可改写 `{messages, systemPrompt}`,再 `before_payload`。fork 自带完整 `HookMap`(before_run / before_drive / before_run_end{followUp?} / transform_context / before_request / before_payload / after_response / before_tool / after_tool / before_compaction / before_navigation,`agent-harness.ts:430-502`)。
> **手术=挂 hook 优先**:S1 用 `before_run_end` 的 `followUp` 注入 driver;S3 用 `before_tool`(doom)+ `after_response`(tail/similar→下一 turn `transform_context` 注 RESUME_LOOP);S4 用 `before_tool` block(fail-closed);C4 reminder 用 `transform_context`(<system-reminder> 不落 transcript)。`<current_tasks>`/goal guidelines 一律走 `src/harness/composer.ts` 包的 systemPrompt fn,不碰 drive。只有 S2(空响应)必须动 `drive/response.ts`。
> **单一事件流(整合,反插件化)**:`HarnessEvent` 是唯一事件总线——不再有独立 dev bus / bridge / 第二订阅通道。事件 union 新增一等变体 `eta {category, action, data}`(电池直接发进主总线,与 turn/tool/usage 同流同序同 lane 标签)与 `prompt_assembled`(generation 原生发)。生命周期/turn/usage/tool/retry/compaction 类别 = 原生事件本身。`EtaAgent` 整合门面:电池(goal/tasks/loops/ask/btw/memory/persona)= agent 内部状态,由它统一构造并接线;对外只有一套 harness、一条事件流、一份 entry log(goal/ask/answer/btw 是一等 entry type,与 message/compaction 同列)。

- [~] S1 **driver 队列**(goal driver 与 loop driver 均走 `before_run_end.followUp`,`src/harness/run-end.ts`):goal 续命与 loop 触发是「turn 边界优先消费的 driver」,不是普通 inbox 消息;dequeue 顺序 driver > had_tools > break(老 B2 语义)。完成条件:两个 driver 各一条集成测试。
- [x] S2 **空响应重试**:不动 `drive/response.ts`(well-formed 空答上游不重试是正确的);`src/harness/run-end.ts emptyResponseGuard` 挂 `before_run_end`,空 stop → RESUME_EMPTY followUp,预算 2 次,真实回答即复位。完成条件:已测(含复位)。
- [x] S3 **漂移检测**:平移老 `loop_detect.rs`(doom 指纹≥3、tail_repetition、similar 三指标)为纯函数模块,接入 loop reminder,再犯抛 `LoopDetected`。完成条件:Rust 单测全数平移。
- [x] S4 ~~fail-closed 权限~~ **已删除(用户决定)**:eta 一切工具默认最高权限,无审批门;`permission.ts` 移除。
- [x] S5 **ask_user 拦截 + answer 通道**(见 C3),S6 **新 entry 类型**(一等 entry type,不是 customType 寄生;ask/answer 通道见 C3 已落):`goal / ask / answer / btw` 进 entry union(两后端 conformance 绿);loops 走 session Value(`eta.loop.state/<id>`),tasks 走 KV Value。完成条件:重放后 store 语义完整。

---

## Part C:内建电池(`src/batteries/`,每节一个模块 + config 开关)

 > **单一整体**:`src/harness/` 一棵树一个命名空间——fork 的 runtime/session/compaction 与电池(goal/loops/ask/tasks/btw/subagents/agent/session-view)平铺同级,没有 src/eta、没有第二 barrel;模型可见字符串(loop follow-up、btw handoff、merge summary)与系统提示一样全部收在 prompts。
> **Prompt 仓库**:全部系统提示集中在 `packages/eta-core/src/prompts/`(按主题一文件,`index.ts` 总出)。上游 v0.85.1 自带的 5 条 compaction/branch 提示已重写成 eta 口吻收进 `src/prompts/compaction.ts`(EXACT 格式模板逐字保留=输出契约),harness 两处改为 import。文风规则:markdown 只用于保格式;不提 AI/assistant/LLM 这类词,用对朋友说话的口吻;代码与文档中不出现 pi 字样(npm 包名与 UPSTREAM.md 溯源除外)。

### C1 goal(built-in,自研,Rust 语义平移)

- [x] 状态机 + anti-spin(3 轮无工具→Paused)+ 复活 + `gate:"auto"|"delegated"` + intent 续命(老 agent.rs:467)+ 独立 evaluator(YES/NO,有界尾部)+ `MAX_CONTINUATIONS`。完成条件:Rust B8 的用例全平移;goal 经 `goal` entry 跨重启恢复(`applyGoalEntries`,测过)。

### C2 loop 调度器(built-in,抄 pi-loop 的语义不抄它的架构)

- [x] Trigger:`event | interval | cron(6 段 UTC,`src/harness/cron.ts`)已落(`src/harness/loops.ts`:contains/regex:/equals filter 语义照抄);cron/dynamic 后续补。**event filter 语法原样抄** `trigger-system.ts:141-155`(substring / `regex:` / JSON 等值)。事件源 = 进程内 bus(`turn_end/tasks_updated/subagents:*`),对应它 `pi.events.on`。
- [x] **pump 模型照抄**:调度器不自主定时,`pump(now)` 由 turn 边界 + **30s unref 心跳**驱动(session-runtime.ts:13 的注释就是理由:idle 时不 pump 的 loop 永不触发);**jitter** 抄 `loop-parse.computeJitter`;**session generation 计数器**防跨 session 陈旧回调。
- [x] 生命周期语义:`expiresAt`(默认 7d `DEFAULT_LOOP_TTL_MS`)过期即 dispose;**fire 上限→pause**(controller_limit 语义);trace 深度 ≤8(`MAX_TRACE_DEPTH`)。完成条件:pump/jitter/expiry/cap/event 各一条测试(已达)。
- [x] 持久化**不抄它的 event-sourced reducer store(956 行)**:registry 进 session KV,纯函数 CRUD + 文件锁即可;`loop-events.ts` 的恢复语义(resume_event_stale)要有。完成条件:未 attach session 到点火、重启全恢复、过期/上限/去重各一条测试。

### C3 ask_user(built-in,读码结论:schema 抄、UI 丢、持久化我们补)

- [x] 落地:`src/harness/ask.ts` AskRegistry(pending/answer/timeout/abort→none、`replay()` 重启重挂未决)+ `createAskUserTool`(questionId=invocationId,onAsk 先写 `ask` entry);kill-重启全链路集成测试随 M4 harness。

- [x] core 按名拦截,发 `AskUserStarted` 挂起 step 等 `answer()`。**它的 execute 本质 = await UI 组件的 Promise**(index.ts:2211-2260):抄 abort signal→null、timeout→`done(null)`、finally 发 blocked/unblocked(= 我们的 dev 事件)。
- [x] schema 抄:`question/context/options[{title,description}](扁平避 anyOf)/allowMultiple/allowFreeform`;别名键归一化(`normalizeAskOptions`:label/text/value/name→title,测过);结果信封 `AskResponse = {kind:"selection",selections,comment?} | {kind:"freeform",text}`。timeout 参数并入 AskRegistry.ask opts。
- [x] headless 语义抄它:无交互 UI 时降级为简单 select/input 协议(`AskRegistry({headless})`,`EtaAgentOptions.askHeadless`),null/抛错回文本 tool_result(No answer),测过。
- [x] **它没有的,我们加**:`ask` entry 持久化 pending,kill→重启→重发未决问题→回填续跑。完成条件:四路单测(选择/填空/超时/取消)+ kill-重启集成测试。

### C4 tasks(built-in,抄 pi-tasks lite)

- [x] `TaskCreate/List/Get/Update` 已落(`src/harness/task-store.ts`+`tools.ts`):deps 双向边、环/自依赖警告仍存、四态、id 不复用、加载归一化守卫(测过)。共享文件模式锁:lite 先只做 session KV,文件锁后续随多 agent 共享再平移。
- [x] **transient reminder 整模块抄** `reminder-cadence.ts`(纯函数 CadenceState:turn 计数、工具闲置判定、每周期一次):挂 `after_tool`+`transform_context`(`createReminderHooks`),不落 transcript 不破 cache 前缀。完成条件:cadence 单测已平移;注入不落 transcript(测试只查 hook 输出)。
- [x] 丢:widget/settings-menu/auto-clear 管理器/subagent RPC 联动(工具面 `Agent/get_subagent_result/steer_subagent` 已落,`createSubagentTools`)。

### C5 memory / evo(轻量:`.eta/MEMORY.md`)

- [x] 读:pwd 向上 + git 感知 + `~/.eta`(`scanMemoryPaths`),合入稳定块 `<memory>`(`renderMemoryBlock`);`MemoryCache` 按 mtime 签名失效,未变字节稳定;写:固定三段 + id 标注 + 20k 上限(`memory.ts`,测过)。
- [x] evo:`extractMemory`/`applyExtraction`(幂等去重 + `remove_memory_ids`,垃圾输出静默)mock provider 测过。

### C6 state 工具:`update_state/check_state/list_state` → 后端 Value/List KV;system prompt 显式描述。完成条件:往返测。

### C7 subagents(built-in lite,抄 pi-subagents 的 manager 语义,20.9k 里抄 ~800)

(工具面见 C7)### C6:
- [x] `update_state/check_state/list_state` 已落(`src/harness/tools.ts createStateTools`,后端 = `StateKV` 接口,生产接 session Value;往返测过)。

工具面 `Agent / get_subagent_result / steer_subagent`;子 = 独立 EtaAgent session(parent 指针、自带 tools/prompt/model)。工具裁剪抄它的做法:`setActiveToolsByName` + `beforeToolCall` 覆盖(agent-runner.ts:282-300)。
- [x] **并发池语义照搬**(后台池默认 10、前台单独计、嵌套 bypass 队列、深度 cap——全测过)。
- [x] depth cap 2 + ownership-scope(越权拒绝、父终态停孙、usage 上卷,测过)。
- [x] `Schedule` 工具复用 C2 的 `every`/`cron`/`expiresAt` 格式(`src/harness/tools.ts createScheduleTool`,一次性 maxRuns=1)。**RPC 信封抄它的 requestId+reply-topic 模式**(`subagents:rpc:spawn|stop|consume` 客户端/服务端两半 + steer/steered 事件,`src/harness/subagent.ts`,测过)。
- [x] 完成/失败发 `subagents:completed|failed` 总线事件;turn-limit「警告→硬停」测过。丢:widget/FleetView/@mention/SubagentWorkflow/worktree/memory 三 scope。

### C8 btw 旁路通道(built-in,抄 pi-btw 的机制,丢它的 overlay)

- [x] **core 原语 `SideSession`**(`src/harness/btw.ts`:seed 过滤 + fallback 两分支平移,Q/A 合成对回放):独立 in-memory 子会话,与主 loop 并发跑(它靠真 AgentSession + 事件流驱动 UI,我们用 fork 的第二个会话实例,事件走 SessionView);`contextual` 种子 = `buildSessionContext(entries, leafId)` **过滤 btw 可见消息**(btw.ts:263 整段逻辑平移,连 fallback 分支一起),`tangent` = 无种子;线程连续性 = 把已答的 Q/A 作**合成 user/assistant 对话对回放进 messages**(btw.ts:299-355),不建第二套 transcript 模型。完成条件:seed 不含 `eta.btw` 可见消息(测过);主 context 重放查不到 side 消息(side 消息只存 btw entry)。
- [x] 持久化:`btw` entry 存线程(`replay()`);save 态机 `not-saved|queued|saved` + `flushQueued()` run 边界落盘(测过)。
- [x] **handoff = S1 driver**:`BtwManager.handoff()` 产 followUp(测过);summarize 强制 thinking off = `setOverride({thinking:"off"})` 由调用方保证,失败不丢线程(线程与 save 态独立)。
- [x] per-thread override:`setOverride` 变更 bump `assemblyVersion`(=dispose+重建信号)、exchanges 保留(测过)。丢:overlay/modal/焦点快捷键/UI split。

---

## Prompt 资产(old/eta-system-prompts 全量平移,按此修)

- [x] P1 `base/goal/evo/todo/resume` 原样搬(行为契约都是对着真实失败模式写的,不许重写);persona 独立成电池,见 C9。完成条件:老 prompt 文本逐字进 TS 常量,有快照测试锁文本。
- [x] P2 摘要改**双 prompt 增量模式**:抄上游 `UPDATE_SUMMARIZATION_PROMPT`(compaction.ts:455+)——首次全量 + 后续只喂新消息 delta 更新,替换现在每次从头重摘(机制在 prepareCompaction→previousSummary→UPDATE prompt,增量测于 test/eta/summary-incremental.test.ts)。
- [x] P3 三处修正:SUMMARIZE_SYSTEM_PROMPT 补上游那句反延续 guard("Do NOT continue the conversation…");evaluator 从 "YES or NO only" 升级为要求先给一条 evidence 再判;`SUMMARIZE_REQUEST` 吸收上游的 "(none)" 逃生舱写法防硬凑。完成条件:guard/evidence/(none) 三处已进常量,快照已更新锁文本。

### C9 persona 系统(built-in,老 persona.rs + PROMPT_GUIDE.md 的 TS 化)

- [x] **4 个内置 preset 原样平移**:`Thinker`(INTP)/`INSIGHTER`(INFJ)/`Executor`(ISTJ)/`Artist`(ISFP)。卡是**第一人称散文体,无标题无 bullet**("read like a person, not a spec" 是设计约束,不许改写成 spec);每张卡内嵌三件行为约定:模糊性处理(做合理假设并声明,只在答案会改变工作时才问)、提问形态(选项列表,不 open-ended)、升级框架(共同担责,不是警告)。完成条件:四卡逐字节快照测试(已锁 Thinker 卡 + 无标题/bullet 结构断言)。
- [x] **自定义卡**:`.eta/persona/*.persona.md`(pwd 向上 + git 感知,同 C5 扫描规则)+ `~/.eta/persona/`;与内置**同一命名空间,同名自定义覆盖内置**;卡内容按 untrusted 处理。完成条件:`discoverPersonas` 测过(项目卡覆盖内置,untrusted)。
- [x] **注入位置 = 稳定块**:composer slots persona → goal/tasks → memory(`EtaPromptState.persona/memory`),同输入字节恒等测过;失效重扫复用 `MemoryCache` 的 mtime 签名;assembly version bump 归 GUI 侧。
- [x] **槽位与装配**(占位达成:`renderPersonaBlock(names, cards)` 名字列表;owner 绑定留给 multi-agent):`AgentConfig.personas: string[]`(按序拼),core 只认名字列表不管来源;`persona → agent → weak-bind session` 的绑定(owner 归属、复用旧 agent 带 memory)**留给 multi-agent 阶段**,本期只在 session meta 存 `owner` 槽。完成条件:不带 persona 时行为与现在一致(占位)。
- [x] 编辑契约:`old/PROMPT_GUIDE.md` 核心要素表已平移进 `docs/PROMPT_GUIDE.md`(五列总表 + Must-Have 要素),作为新卡 spec。

## Part D:session 与 context(fork 基本白拿)

- [x] D1 sqlite 后端 + conformance 全绿(F0.3);重放/fork/navigation 白拿。
- [x] D2 compaction 补两点上游没有的:tool **整对丢弃**(ratio≥25%、绝不劈半对)+ **max-min-fair 确定性兜底** + untrusted note(平移老 `compaction.rs` 纯函数,已测)。完成条件:配对完整性测试(`src/harness/compaction/eta-compaction.ts` + test/eta/compaction-eta.test.ts,失败兜底带 untrusted note)。
- [x] D3 durable 再注入:`buildContext` 时 goal/tasks 摘要/memory 稳定块重注,自适应块(skills/工具目录)放 cache 边界后可降级。完成条件:compaction 后语义块不丢(EtaAgent systemPrompt fn 每次 generation 现组:goal 指南+current_tasks+memory 稳定块,测于 D3 用例;自适应块在 cache 边界后由上游控制)。
- [x] D4 **SessionView 投影器**:基于上游已有 reducer 快照(reduceLaneSnapshot)+ telemetry 流,产出 `{messages,thinking,goal,tasks,loops,sideThread,usage,cacheRate,branch,pendingAsk}` 可序列化;attach = 重放 + 增量。完成条件:双前端并行 attach 一致(`src/harness/session-view.ts` SessionViewProjector.snapshot/attach;test/eta/session-view.test.ts 双 projector 收敛一致 + detach 后静默)。

## Part E:observability

- [x] telemetry category 对齐老 14 类 + 电池扩展(重构:类别走主事件总线 `eta` 变体,无独立 bus/bridge;`EtaAgent` 统一接线)(`loop: fired/paused/expired/suppressed`、`ask: asked/answered/expired`、`btw: opened/injected/summarized/saved`)。完成条件:混合 turn 全类别可观测,内存实现测过。

## Part F:验证(GUI-PLAN.md 的 G 系列并入,day-0 起 GUI 就是 harness)

- [ ] F1 ~~dev-cli~~ **退役**:自 G0 起验证在 GUI 内做(`TestGpuixRenderer`/screenshot/automation tree),headless CI 用测试渲染器跑同一条;readline 壳只留作 no-GPU 兜底。
- [x] F2 SessionView + AgentEvent + telemetry 三通道过 WebSocket 给第二前端(packages/eta-gui/src/ws.ts;test/ws.test.ts 两个裸 WebSocket 对等消费+回驱全部 op;session-tagged view/agent frames)——**总验收**(老 R10 等价物;GUI 与远端前端吃同一契约,见 GUI-PLAN G0.2)。

## 明确不做

extension/plugin 装载;widget/fleet/workflow-vm/monitor;kanban 分解 harness;persona preset(留槽);provider/auth(pi-ai 全权);pi-loop 的 task-backlog/workflow 状态机。

## 里程碑

| # | 内容 | 验收 |
|---|---|---|
| M0 | F0 fork + 改名 + 上游测试/conformance 绿 | 基线可信 |
| M1 | S1-S3 driver/空响应/漂移 | 手术各有测试 |
| M2 | C6+C4 tasks(含锁与 cadence 平移) | DAG + transient reminder |
| M3 | C1 goal | 状态机全语义 |
| M4 | S4+S5+C3 ask_user | kill-重启-回答续跑 |
| M5 | D2-D3 compaction 补齐 | 配对完整 |
| M6 | C2 loop(心跳/pump/过期/bootstrap) | 重启恢复+过期+上限 |
| M7 | C5 memory/evo + C9 persona(P1-P3 prompt 资产) | 带外抽取 + persona 稳定块生效 |
| M8 | C7 subagents | followUp 唤醒 + 池语义 |
| M9 | C8 btw 旁路 | 主忙时 side 跑通、inject 回灌 |
| M10 | D4-D5 + F1/F2 | 双前端总验收 |
