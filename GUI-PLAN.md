# GUI-PLAN — eta GUI(GPUIX,gpuix)+ Day-0 交付

> 原则:**GUI 不是 core 稳定后的外壳,是 core 的观测仪器**。继承老 CORE_PLAN Part E 的铁律——「不留任何只有引擎知道、UI 看不到的功能」,每节电池上线的同一个里程碑必须带它的面板,否则不算完成。渲染层与 core 的唯一契约 = `SessionView` 快照/增量 + 两条流(`AgentEvent` + telemetry);
>
> 产品形态抄 pi-gui(Codex 式 thread timeline + 侧栏 + diff 面板 + composer),引擎暴露面抄老 E3/E4(Context 面板 + dev rail),渲染栈换 gpuix(native GPUI,无 Electron/webview)。前置结论沿用已读码分析:terminal 用 gpui-terminal 挂 CustomElement,图片粘贴给 gpuix 补 `paste-assets`(~30 行,`input.rs:1084` 只取了 `.text()`)。
>
> 每条 `- [ ]` 末尾是完成条件。

---

## 0. 进程与数据契约(day-0 就定死,以后不许旁路)

- [x] G0.1 单 bun 进程:`@eta/core` in-process + gpuix 窗口。三条通道:**SessionView**(真值快照+增量 patch)、**AgentEvent**(交互投影)、**telemetry dev events**(引擎内部,per-session ring buffer 最近 N 条)。**GUI 除这三样外不许碰 core 内部对象**。完成条件:类型上 GUI 只 import 这三类。
- [x] G0.2 三条通道全 JSON-safe。完成条件:序列化 roundtrip 测试(`test/channels.test.ts` encode/decode roundtrip + DevRing 容量/过滤);attach = `replay(store)` + 订阅增量,后台 session 重 attach 用 SessionView 重放 + dev ring 回填(老 E6 语义)。
- [x] G0.3 线程模型:N 个 session = N 个 agent 并发,GUI 只有一个 attach 指针;后台 goal/loop 照常跑,GUI 断连不影响。完成条件:后台 session 的 loop 到点火、GUI 无窗口时 core 不退出(`src/host.ts` Host;test/host.test.ts:attach 指针在 A、B 的 loop 点火进 ring/帧流;detach 后 B 视图照常更新)。

 ** gpuix/examples/chat.tsx 可以大量借鉴 **

---

## 1. 布局

```
┌────────┬──────────────────────────────┬─────────────────┐
│ 侧栏    │  timeline(主列)             │ tab: Context     │
│ thread │  消息=流式 <markdown>         │ tab: Dev rail   │
│ +badge │  工具=折叠 <code>/<diff>      │ (14+类事件 tail  │
│ +archive│  系统行=compaction/goal/     │  +category 过滤) │
│        │  loop/ask/btw                ├─────────────────┤
│        │                              │ diff 侧挂(⌘D)  │
├────────┴──────────────────────────────┴─────────────────┤
│ composer:textarea + @mention(anchored)+ 图片 chips       │
│ ask_user 内联弹窗 / 排队消息条 / btw 模态(Alt+/)          │
└─────────────────────────────────────────────────────────┘
终端底部面板(⌘`,gpui-terminal 元素,默认收起)
```

- [x] L1 侧栏:session 列表 + 状态 badge(`running / goal / ask-pending / loop`)+ archive;数据 = 各 session SessionView 摘要行。完成条件:切 attach 不丢任何 session 状态。(Host 常驻 agent+projector+DevRing,sidebar() 每次现算 badge;focus 只挪指针;test G0.3 后台 loop 在指针离开后照常触发)
- [x] L2 timeline 行类型:在 pi-gui `activity|tool|summary|turn-marker`(timeline-types.ts)基础上扩 `goal-change / loop-fire / compaction / ask / btw-note / retry`。工具行内嵌 `<code>`(参数/结果)+ `<diff>`(edit 类)。完成条件:virtual-list 变高行 + 尾部锚定(chat 语义),历史重放与直播同一渲染路径。(app.tsx `<virtual-list followTail>`;工具行内嵌 `<code>` args/结果;loop/retry 瞬态行来自 dev 通道;test L2 timeline rows)
- [x] L3 Context 面板:system prompt 拆**稳定块/自适应块**两段 + `compactionEpoch`;usage 表(input/output/cache_read/write + `cacheRate` + tokens/sec,速率用 dev ts);goal 卡、tasks、loops、memory 水位(20k)、subagents fleet 行、btw sideThread。完成条件:跑一个 turn 每块都实时刷新。(prompt 拆 stable(base+persona)/adaptive(goal+tasks+memory):composer.splitEtaPromptSections,agent 每次 generation 上报 prompt.blocks 观测;tokens/sec 由 agent 单一 usage 追踪器算,投影器只搬运;Context usage 行+prompt 行有 testId,app.test/G2-G6 与 session-view.test 断言)
- [x] L4 dev rail:全 category 着色 tail,`/` 过滤、暂停/恢复;环满丢最旧。完成条件:14+类各有颜色且能过滤。(CATEGORY_COLORS 覆盖 15 eta 类+badge 类;dev-filter 过滤;pause 冻结快照;DevRing 满则丢最旧;test L4 dev rail / all-category rail)
- [x] L5 composer:textarea(minRows/maxRows)+ @mention 弹层(`<anchored>` 侧挂,数据 Host.listFiles())、排队消息条(queued-bar,等 turn 边界 = S1 driver)、`ask_user` 内联弹窗(单选即点即答、多选勾选+confirm、freeform 输入、timeout 倒计时来自 AskRegistry.deadline→SessionView.pendingAskDeadline)。完成条件:kill-重启后未决 ask 在 GUI 重弹 ✅(G4);paste-assets 图片 chips 仍是给 gpuix 的原生补丁(计划内上游项),eta 侧 chip 渲染待其落地。