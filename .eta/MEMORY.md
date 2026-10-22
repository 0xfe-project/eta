# eta memory (untrusted)

## decision

- [0] In the Eta monorepo, when the user says a change is done and asks to push, push it directly to main.
- [9] In Eta product language, task is the human-level subagent abstraction; the internal Agent/subagent execution pool is an implementation detail and should not become a separate human-facing concept.
- [13] Eta draft_task cards must be visually attached to the originating turn/message and be collapsible, so humans can review and confirm them in context.
- [18] Eta: do not build a separate mid-turn task-promotion mechanism; when chat-area work needs to become durable task work, reuse existing draft_task confirmation, brief-only handoff, and originating message/turn lineage.
- [23] When the user narrows an Eta change to a specific tool or file, treat that scope as a hard requirement and do not bundle base prompt, project instructions, or UI changes without explicit approval.
- [33] Eta 任务评论必须始终被读取：任务有活跃运行时，评论 steer 当前运行；任务没有活跃运行时，评论必须自动形成 continuation prompt，唤醒同一任务的执行者继续，而不是静默留在时间线或要求用户显式 rerun。
- [38] In Eta chat UI, queued/排队的 task runs must be represented only near the composer and must not appear as chat rows/cards in the chat area.
- [41] Eta chat message folding must be display-only: do not change the message text or prompt content sent to agents.
- [45] Eta 新手安装先走 /onboard：绑定模型后按人格卡安装智能体。
- [46] Eta 聊天区只允许信息确认/流转和极短验证；凡会改仓库、跑构建/测试、需人验收、或会跨多轮工具的工作，必须先 draft_task 并由人确认。
- [49] In Eta, when the user asks to merge task work into mainline, merge only completed task branches locally; push only if explicitly asked.
- [54] Eta WorkspacePanel/context panel layout must prioritize items worthy of user attention: confirmations/actions needing the user come first; do not keep them buried in the old fixed ordering.
- [56] Eta TasksPage 任务板主区域不要保留左右内边距；后续调整需保持水平贴边，只保留纵向间距。
- [65] In Eta, a requested PR means push the branch and open a PR for the user to review; do not merge it without follow-up.
- [68] In Eta, GitHub integration is hidden by default: hide all frontend GitHub surfaces via mounted-absence, backend GitHub plugin is not loaded/mounted by default, and existing GitHub data/migrations/copy are preserved rather than deleted.
- [74] Eta 设置窗口应隐藏「需先确认的工具」approvals tab：只过滤设置 rail/展示入口，不删除 approvals 机制、数据或历史配置；保留 ?settings=approvals 深链逃生口。
- [81] Eta 侧栏 AgentCard 的头像必须向上对齐（top-align），不要垂直居中。
- [82] Eta GitHub 插件启用/关闭应通过后端可选插件开关完成：默认 off，可用 `--github` 或 `ETA_GITHUB=1/true/yes/on` 启用，`--no-github` 强制关闭；关闭时 mounted/pending、GitHub routes/tools/akhook layer 都不出现。
- [93] 新建群聊默认生成的群名应使用当前 project 名称；用户显式填写的群名仍优先。
- [99] Eta chat: publish_artifact/ref cards must render outside ProcessBox in the turn-tasks card layer, same position as draft_task/task_card, on both streaming and persisted message paths.
- [100] Eta 侧栏折叠布局：折叠后任务/定时导航只展示图标；群聊/agent 卡片改为上方图标+下方小字名称（竖向排列），折叠 rail 宽度要刚好容纳图标+小字；折叠态 SidebarHeader 只显示紧凑 logo（点击可展开），不要把 logo 和折叠按钮硬塞在同一行；折叠/展开按钮移到分区列表最上方，顺序为 折叠→设置→任务→定时。展开态保持页眉右侧折叠按钮，设置仍排在任务/定时之前。
- [102] Eta ActivityRefCard/artifact/task reference cards in sidebar/workspace panel must fill the available card area and must not impose a local max-width (e.g. max-w-md).

## preference

- [1] Use Chinese for Eta project interactions.
- [2] For Eta changes, ensure pre-commit/repo checks pass before pushing.
- [19] For Eta task/draft_task features, user considers human-reviewed draft_task sufficient and prefers minimal UI/lineage changes (attach cards to originating turn, collapse/expand) over redesigning subagent/background concurrency.
- [24] For Eta draft_task underuse, user prefers a first fix that only rewrites the draft_task tool description with explicit triggers and boundaries, leaving base prompt/policy changes for a later measured step.
- [25] Measure draft_task usage relative to chat-area tool activity after prompt/tool changes before expanding scope.
- [28] Eta chat: long pasted text in sent user messages should be folded in-place like the composer paste chip, not only truncated as a whole message.
- [34] Eta 任务评论续跑优先复用同一任务已有会话上下文，避免全新失忆 rerun；运行键/归属要确保续跑仍属于同一任务。
- [35] Eta draft_task 卡片折叠后，折叠标题仍要显示待确认/attention 标记，避免需要用户动作的卡片静默消失。
- [36] Eta draft_task 确认后产生的 task_card 仍留在产生它的 turn 附近显示实时状态，不要跳走。
- [39] When suppressing queued Eta chat rows, hide only replies whose parent user message is still held/queued; queued replies waiting for an already-visible user message can remain in chat.
- [42] In Eta chat, long agent replies should also fold to first 12 lines with an expand control, using the same long-text folding pattern as user pasted messages.
- [43] Eta chat folding should reuse a shared clamp/fold component and reader open/collapse preferences; default-collapse settled messages, preserve manual expansion, and leave streaming replies unfolded.
- [58] Eta draft_task 工具描述应以可自检硬触发开头（改文件 / 跑构建测试 / 需人验收 / 多轮工具），并区分聊天区、mention、会话 todo 与看板 task；避免淡化紧迫感的措辞。
- [59] Eta 聊天长文本折叠应在用户消息、智能体回复和 ProcessBox answer 间共用同一个 FoldedText / 外部折叠状态，避免同一消息出现两份独立展开状态。
- [62] When the user pastes a DOM selector/element snippet to point at a UI problem, treat it as the exact component/layout scope to modify and do not touch adjacent UI unless explicitly named.
- [63] In Eta task workflow, after task work is verified merged, mark/close the task; if the task branch is already merged (main..branch has 0 commits), close it rather than re-merging or opening another PR.
- [66] When the user says they will review something themselves, prefer a reviewable PR/branch over direct merge or hidden assumptions.
- [69] Eta WorkspacePanel context panel sections should be ordered by user-attention value, e.g. waiting/confirmations first, then tasks, artifacts, routines, members, goals; avoid duplicating chat confirmations in the panel when chat already requires action.
- [70] When hiding an optional Eta integration, hide the whole related surface/flow rather than leaving partially disabled or stale-looking UI.
- [75] Eta 隐藏可选设置 tab 时，优先做展示层过滤并保留旧状态/深链的可渲染路径，避免把数据或后端确认机制一起藏掉。
- [76] When the user asks to merge all open Eta tasks if they look fine, the agent should merge/close/verify them autonomously instead of asking for per-task confirmation.
- [92] 当用户说"这是一个任务"时，应建 task 而非在聊天区直接执行。
- [94] For significant Eta UI redesigns, user prefers reviewing a visual HTML artifact/prototype first before implementation.
- [98] Eta 任务页重设计（#13 定稿）：只有任务「详情/信息页」做成聊天式（一次运行=一条带头像的发言、日志折在发言里、状态改动=细系统行、需要人的是带按钮的卡、底部输入框常驻且**发送即续跑**、属性四格/右侧 aside 换成标题下一行 chip、去掉「活动」小标题与 tab、长描述收成流里第一条折叠块）；任务列表保持列表页原样（状态分节+计数、行式、行内**不加**验收按钮），整页列表/看板与右侧栏 Tasks tab 的列表都不动，详情改造抽一个组件给整页与面板共用。
- [103] For Eta ref-card width issues, remove arbitrary card caps and rely on outer layout bounds instead of adding a new cap or resizing the sidebar.

## lesson

- [3] Knip in Eta flags exports used only internally; make internal helpers non-exported (e.g., onboardedStorageKey).
- [4] In Eta, untracked .eta/MEMORY.md can create noisy git status and make bun run check fail via dprint formatting; gitignore, format, or commit it if needed.
- [11] Do not conflate Eta's product mechanism with implementation details: the user's 'subagent' meant task-as-subagent in human workflow, while opaque internal Agent execution may be fine.
- [14] Before proposing new Eta task/promotion behavior, check whether existing draft_task already covers it; a request to make a card 'in the turn' may mean visual grouping/folding, not a change to execution timing or task semantics.
- [20] In Eta, tool descriptions are sent in every request, so agent underuse of draft_task is not a visibility problem; check competing prompts and decision-point policy first.
- [21] In Eta, the default base prompt's todo-list escalation and its use of 'task' for session todos competes with board tasks and encourages inline continuation; to enforce chat-area info-only behavior, put an imperative product policy in the cached base system prompt and explicitly disambiguate session todo from board task.
- [22] In Eta, don't assume a project-level instructions field exists as a global policy surface; use prompts/base.ts for product-wide prompt stance, and per-agent instructions/persona only for variation.
- [26] Analysis can identify broader root causes, but user may deliberately choose a smaller experiment; present the broader cause and implement the narrower requested change.
- [27] In Eta, do not treat a red pre-commit test as a flake without capturing/reproducing the failing test case.
- [37] Eta task comment delivery 不能只依赖内存 live handle；运行中可 steer，结束后的评论需要持久化/入队续跑，否则会成无声记录。
- [40] To keep queued Eta task replies out of chat, filter at the shared conversation query/source using held root message ids and cover both immediate send replies and reloaded host window replies.
- [44] For Eta long-message folding, reuse the existing fold preference module and shared clamp UI across message types instead of duplicating folding logic in separate render paths.
- [48] @eta/memory 的 lint 使用 `uv run ruff`；缺少 uv 会使整仓 check 失败，应与改动隔离判断。
- [51] Removing an Eta WorkspacePanel tab must also remove the now-dead panel branch/container and migrate its tests to the page route; missing panel sections should route to dedicated pages.
- [53] To fold pasted text inside sent Eta messages without changing the prompt, store paste-block ranges in message `data.blocks` and render the same chip by interval; legacy messages fall back to whole-message clamping.
- [55] Before merging all Eta task work, verify each task branch actually has commits; long runs can die (e.g., provider stream error before start) leaving only uncommitted worktrees. Task status changes alone do not enqueue a rerun/continuation, so failed work needs explicit rerun/manual verification before merge.
- [60] Eta web `sidebar-tree.test.tsx` 中按最近活跃排序的用例在并发下可能时间敏感/抖动；遇到红需单独复现后再判断是否回归。
- [61] Eta 长任务反复死于 `Assistant message stream emitted error before start` 时，应视为 provider/stream 稳定性问题单独检查，不要当测试 flake 或直接假设可重跑成功。
- [64] When reconciling Eta task branches with main, check whether main..branch has 0 commits; if yes and acceptance is verified, close the task. Do not merge or close based only on task status: failed/long runs may leave uncommitted worktrees, and uncommitted changes are not mergeable.
- [67] In Eta, PRs must go through `open_pull_request`; `gh pr create` is blocked by akhook. If GitHub integration is not connected, fall back to a manual compare URL plus prepared PR body.
- [71] When making Eta GitHub plugin optional/off-by-default, exclude GitHub from pending/everyone mount-wait sets; otherwise the disabled plugin still causes MOUNT_TIMEOUT_MS waits.
- [72] In Eta, prefer hiding optional plugin surfaces from existing state.mounted / useGitHubMounted and memory-sidecar-style optional backend loading instead of adding new feature flags or config round-trips.
- [73] Eta web test matrix can have concurrency-sensitive flakes (including @eta/web#test, not only sidebar-tree recent-activity cases); reproduce isolated before treating a red run as a regression.
- [77] Squash-merged Eta PR branches can still show commits in `main..branch`; use tree equality or `git merge-tree` to detect already-merged content, then close the branch/task instead of creating an empty merge.
- [78] When Eta's GitHub plugin is disabled, also omit akhook's GitHub layer; otherwise `gh pr create` remains blocked even though GitHub is not loaded/connected.
- [79] Eta backend plugin mounts and task-comment continuation only take effect after restarting the running host; frontend hiding depends on `hello.mounted` plus rebuilt web assets/refresh.
- [80] Eta full-check flakiness is not limited to @eta/web: `@eta/app` `bundles-gateway` has shown concurrency-sensitive 401-vs-200 failures; isolate reproductions before treating them as regressions.
- [84] 新增 Eta 插件开关后需 grep 部署配置是否重复定义同名 env/flag；#8 的 ETA_GITHUB 曾在 deploy/compose.yaml 写了两遍。
- [86] Eta task comment continuation must key sessions to the task and carry the established session across runs; run-level keys make continued context and finish_task/working-run attribution brittle.
- [87] Optional Eta plugins must also make their configured agent tools visibly unavailable/offline; otherwise agents may try them and fail with configured_tools_unavailable (e.g., GitHub open_pull_request/draft_issue after GitHub is hidden).
- [89] Eta GitHub 隐藏/关闭后，若 agent 配置仍引用 open_pull_request 或 draft_issue，会出现 configured_tools_unavailable 并阻塞执行；关闭可选 GitHub 链路时必须同步清理/容错 GitHub-only 工具配置，PR 需走 manual compare URL 或显式启用 GitHub。
- [96] Eta web 聊天里 tool call 自带的卡（ActivityRefCard：artifact / PR）由 ToolActivity 画在固定高度的 ProcessBox 过程盒内，会被一起折走；draft_task / task_card 不在过程盒里，它们走 Turn 的 `turn-tasks` 卡片层（画在答案旁边）。要让 tool 的产物卡常驻可见，就必须画进 turn-tasks 那一层，而不是留在过程盒里。
- [101] Eta 折叠侧栏不要为保住固定 40px header/分隔线而把 logo 和控件挤成一行；折叠态页眉应只留 logo，把交互控件移到导航列表。
- [104] Eta shared activity-card `frameClass` can hide width bugs: `max-w-md` looked like sidebar default width but was arbitrary; check shared style strings and both `<div>` vs `<a>/<button>` variants, and pin card fill behavior with tests.
