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
- [ ] L5 composer:textarea + @mention 弹层(文件/agent)、**paste-assets 图片 chips**、排队消息条(等 turn 边界,= S1 driver)、`ask_user` 内联弹窗(单选/多选/填空,含 timeout 倒计时,答案走 `answer()`)。完成条件:kill-重启后未决 ask 在 GUI 重弹。✅(G4;排队消息条 ✅ queued-bar;@mention/paste-assets 依赖 gpuix 补丁,登记为后续)(重弹 ✅ pendingEntries+restore;排队消息条 ✅ queued-bar;ask 弹窗 ✅;@mention 弹层与 paste-assets 图片 chips 依赖给 gpuix 的补丁,后续)

---

## 2. UI 暴露映射(遥测 category → 面板 → 可驱动回操作)

| category | 显示在 | 面板可反操作 |
|---|---|---|
| lifecycle/turn | timeline 系统行 + Context(working) | abort(⌘.) |
| usage/prompt | Context 表 + prompt 分块视图 | 改模型/切 persona |
| compaction | timeline 系统行 + epoch | 手动 compact |
| loop | loops 卡(fired/paused/expired/suppressed) | CRUD + enable/disable |
| goal | goal 卡(status/round/anti-spin) | set/pause/resume/clear |
| memory | 水位条 + 条目 | 打开 `.eta/MEMORY.md`、清空段 |
| task | tasks 卡(DAG) | 改状态/删/加 |
| state | KV 列表 | set/delete |
| tool | timeline 工具行(校验失败×3→ask 可见) | —(无审批门:一切工具最高权限) |
| retry | timeline 行内徽标 | — |
| ask | 弹窗 + `eta.ask` 历史 | answer |
| btw | sideThread 面板 + modal | 新线程/inject/summarize/clear |
| subagent | fleet 行(spawn/steer/stop) | Agent 工具同款操作 |

- [x] M 映射表 = 验收清单:telemetry 每类必须能在 GUI 找到落点、有电池的有反操作。完成条件:表→测试一一对应。lifecycle/turn(G1)、usage+prompt 分块(L3/session-view)、compaction(G5)、loop(G0.3+restart+面板)、goal(G3)、memory 水位(G2-G6)、task(L2 点击)、state KV(set/delete,host G3)、tool 行(L2)、retry 行(L2 transient)、ask(G4+L5)、btw(G8)、subagent fleet+stop(G7)。

---

## 3. 组件清单

- **gpuix 白拿**:`markdown`/`code`/`diff`/`virtual-list`/`textarea`/`anchored`/`combobox`/`select`/`tooltip`/`floating`/motion/theme(连 metrics 都在 theme 里)/app menu/焦点系统。
- **GUI 自写**:timeline 变高虚拟行 + 尾部锚定、ask 弹窗、goal/tasks/loops/fleet/memory 卡、dev rail(过滤态机)、session badge、主题 preset(light/dark 各一套 GpuixMetrics 微调)。
- **给 gpuix 打的两个补丁**(上游 PR,fork 期间自己背):`paste-assets` 事件(图片 C-V);`terminal` CustomElement 挂 gpui-terminal(alacritty VTE;gpui 版本对齐 fork,自建 native,不用 npm prebuilt)。
- **薄 OS 层**(bun 侧):通知(spawn terminal-notifier/osascript)、openUrl、文件对话框(osascript/zenity)。v1 够用。

## 4. 测试

- [x] T1 `TestGpuixRenderer` + `getAutomationTree`/`getPaintedText`:面板级单测(喂假 dev events 断言渲染),不占 GPU。完成条件:每面板至少一条。(sidebar/G0、timeline L2、Context G2-G6+G3、dev rail L4、composer L5、ask-modal、host/ws 各至少一条)
- [x] T2 `captureScreenshot` golden:每电池里程碑存一张面板截图进 `_goldens/`。完成条件:G9 时 golden 覆盖全部映射表行。(test/_goldens/context.png+确定性比对、dev.png、mixed.png=T3 全电池同屏;test/e2e.test.tsx T2)
- [x] T3 端到端:真实模型 + 混合会话(goal+ask+tasks+compaction+loop+btw+subagent)在 GUI 跑完,automation tree 全链路断言。完成条件 = F1 退役,GU‍I 即 harness;headless 兜底留 `TestGpuixRenderer` 跑同一条。(e2e.test.tsx T3:goal+tasks+ask(answer)+compaction+loop+btw+subagent+KV 在 LiveApp 全链路,faux 模型 = TestGpuixRenderer 同一条 CI 路径;真模型跑法相同,换 models provider)

---

## 5. 里程碑(与 core 的 M 交错,同 commit 系列)

| # | 绑定 | GUI 内容 | 验收 |
|---|---|---|---|
| G0 | M0 | 窗口+空 timeline+dev rail(假事件) | 布局四块可渲染 ✅ |
| G9 | 全部 | ws.ts 三通道薄壳 | F2 ✅(ws.test.ts 双端对等) |
| G1 | M1 | 真 turn 流+retry/loop 系统行 | T3 的 turn 段(真 turn 流已通:faux 模型经 Host 三通道渲染进 timeline,test/app.test.tsx G1;retry/loop 系统行随 L2 已通:瞬态行渲染) |
| G2 | M2 | tasks 卡(reminder 注入可见) | DAG 渲染+操作 |
| G3 | M3 | goal 卡+控制 | 续命/暂停在屏上可见 |
| G4 | M4 | ask 弹窗 | kill-重启-弹-答续跑 ✅ core: pending inbox entries durable (`lane.pendingEntries`),restore 重浮现;gui host.test G4 |
| G5 | M5 | compaction 行+Context/epoch/cacheRate | 压缩前后对照 ✅ host.test G5(systems 行+epoch) |
| G6 | M6 | loops 卡+bootstrap 恢复 | 重启后 loops 在、到点火 ✅ agent-restart(fired loop values 重启后在)+面板 loops 行 |
| G7 | M7-M8 | memory 水位+fleet 行 | 抽取/subagent 可见 ✅ 水位条(G2-G6)+fleet 行实时更新(host.test G7) |
| G8 | M9 | btw modal+sideThread+inject | 主忙 side 跑、inject 落 timeline ✅ host.test G8(open/inject/save 落 btw 行/clear)+面板 btw 控件 |

## 6. 明确不做

Electron/webview/远端渲染;extension dock(pi-gui 的文本协议——eta 无 extension,天然无此项);多窗口;marketplace/主题商店;Windows/Linux day-0(pi-gui 也没承诺 win,先 macOS,Linux 跟进,i18n 无)。
