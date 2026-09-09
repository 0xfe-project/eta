# GUI-PLAN v2 — eta GUI(Web + WebSocket)+ 逐步交付

> **v1(gpuix)退役原因**:原生 GPUI 渲染体验不如 Electron/web。v2 换 **`eta-server`(Bun HTTP+WS,托管 core)+ `eta-web`(React SPA)**,浏览器直连调试(devtools/热重载),以后要 Electron 就是套 BrowserWindow 壳指到同一 URL,零改动。
>
> 不变量(v1 G0 铁律原样继承):**GUI 是 core 的观测仪器,不留任何只有引擎知道、UI 看不到的功能**;唯一契约 = 三通道(`SessionView` 快照/增量、`AgentEvent`、telemetry dev ring)+ `GuiOps` 回驱。v1 已交付的 gpuix 版本(commit `896150f` 前史)验证过这套契约 JSON-safe 可跨进程,现在只是把它挪到 WebSocket 上并换前端。
>
> 参照物:**布局/交互照抄 `pi-gui`**(侧栏 thread 列表、流式 pin-bottom timeline、工具折叠行、composer 排队/steer、ask 模态、乐观跳转);**工程配置照抄 `../matrix/apps/web`**(Vite + React + wouter + Tailwind v4 CSS 变量 + i18next workspace 包 + shadcn copy-in 组件)。主题**弃用** pi-gui 的 68 变量 8 预设体系,重做两套:**dark `#181818` / light `#ffffff`**。
>
> eta 独有交互:**新建 session 必须先选 persona**(v2 新增 W3,core persona battery 已就绪)。
>
> 每条 `- [ ]` 末尾是完成条件。

---

## 0. 进程与数据契约

- [x] G0.1(继承 v1)三通道 + GuiOps 契约,类型上 GUI 只 import 这三类;JSON-safe roundtrip。
- [ ] W0.1 删 `packages/eta-gui`,根 `package.json` scripts 摘除对它的引用。完成条件:全仓 `bun run test`/`typecheck` 绿,`grep -r eta-gui` 只剩历史文档。
- [x] W0.2 `packages/eta-server`:单 Bun 进程,in-process 起 `@eta/core`(Host 语义延续 v1:N session 并发、attach 指针、DevRing、断连不退进程);HTTP 静态托管 `eta-web` build 产物 + `GET /api/personas`、`GET /api/sessions` + `ws /ws`。完成条件:`bun packages/eta-server/src/main.ts` 起服务,curl 两个 API 返回 JSON。
- [x] W0.3 WS 协议 = v1 channels 帧的超集:`{channel:"view"|"agent"|"dev", session, frame}` 下行,`{op:GuiOps, session?}` + 控制消息上行;控制消息:`session.create {name, personaId, cwd}` / `session.delete` / `personas.refresh`。完成条件:roundtrip 测试 + 双客户端同 attach 一个 session 帧一致。
- [x] W0.4 persona 源:`GET /api/personas` 返回 core persona battery(4 内置卡 + `.eta/persona/*.persona.md` 发现结果)的 `{id,name,description}` 摘要;`session.create` 必带 `personaId`,非法 id 拒绝。完成条件:drop 一个 `.persona.md` 进 cwd 的 `.eta/persona/`,不重启 API 能看到。
- [x] W0.5 dev 拓扑:vite dev server(5173)`/ws`、`/api` proxy 到 server(3000);prod 同域静态托管。完成条件:`bun run dev` 两条命令起全栈,浏览器可用。
- [ ] W0.6 手机可达:默认绑 `127.0.0.1`,`ETA_HOST=0.0.0.0` 开局域网直连(手机同 WiFi 用本机 IP);远程场景走用户自己的隧道(指向 loopback 即可,无配对/鉴权体系)。响应式到位即手机可用(见 W2.0),不做 PWA 安装/二维码。完成条件:手机上能完成建 session→发消息→收流式。

## 1. eta-web 工程(照抄 matrix/apps/web)

- [x] W1.1 脚手架:`packages/eta-web` = Vite + React 19 + wouter 3 + Tailwind v4(`@tailwindcss/vite`,无 config 文件)+ TS(extends 根 tsconfig,`@/*` alias);vitest 复用 vite config。完成条件:`bun run dev` 出页面,`bun run test`/`typecheck` 绿。
- [x] W1.2 路由(wouter)(`/`、`/new`、`/settings`;数据驱动 route-definitions 表暂以路由常量代替;WS store 为模块级单例,切页不重连):数据驱动 route-definitions(侧栏/面包屑共用);路由:`/`(session 列表+timeline)、`/new`(persona 向导)、`/settings`(主题/语言)。完成条件:`useLocation` 切换不重挂 WS 连接。
- [x] W1.3 i18n:workspace 包 `packages/eta-i18n`(i18next,`en` + `zh-CN` 扁平点号 key,`TranslationKey` 编译期校验,单一 translation namespace,`keySeparator:false`);检测链 URL `?locale=` → localStorage(`eta.locale`)→ cookie → navigator → 默认 `zh-CN`;跨 tab 同步(storage + CustomEvent)。完成条件:key 覆盖率测试(en/zh 键集相等)+ 传错 key TS 报错。
- [x] W1.4 主题:两套 CSS 变量,Tailwind v4 `@theme inline` 映射,`.dark` class 切换;dark 基底 `#181818`、light 基底 `#ffffff`;边框/hover/accent 淡色用 `color-mix` 派生(pi-gui 的机制,变量名换 shadcn 风格全集);theme-provider:localStorage `eta.theme` + `matchMedia` system + 跨 tab 同步,`useAppTheme()`。完成条件:两套主题下全组件可读,切换无闪白(FOUC 由内联脚本预防)。
- [ ] W1.5 组件层:shadcn copy-in(`components/ui/`,radix 原语)+ `cn()`;chat 类组件(消息气泡/工具行/composer)手写在 `features/session/components/`。完成条件:无孤儿依赖,`bun run typecheck` 绿。

## 2. 界面(v2 布局)

```
┌─────────┬───────────────────────────────┬──────────────┐
│ 侧栏     │ timeline(流式 markdown,      │ tab: Context │
│ session │  工具折叠行 +N -M,            │ tab: Dev rail│
│ +badge  │  turn marker/系统行)          │ (15 类着色   │
│ +persona│  prompt rail(右侧编号跳转)   │  tail+过滤)  │
│ +新建   ├───────────────────────────────┤              │
│ /new    │ composer(排队/⌘↵ steer、     │              │
│         │  @mention、ask 模态、btw)     │              │
└─────────┴───────────────────────────────┴──────────────┘
```

- [ ] W2.0 响应式(移动优先):桌面三栏 grid;**竖屏/窄屏只剩 timeline+composer**,侧栏=左滑出抽屉(遮罩关闭)、Context/Dev 面板=右滑出抽屉、排队条/附件等=底部抽屉(sheet)。断点一套 CSS(`@theme`/container query),所有抽屉状态持久化。完成条件:375px 宽下全功能可用(建 session/发消息/审批 ask/开 Context),无横向滚动条。
- [ ] W2.1 连接层:`useEtaSocket` 单例——重连指数退避、断线 banner、revision 防乱序(v1 `ChannelFrame` 反序列化进 reducer store,快照优先 + 增量合并,抄 pi-gui `applySnapshotIfNewer` 思路)。完成条件:kill server 再起,前端自动恢复且状态正确。
- [x] W2.2 侧栏:session 列表 + badge(`running/goal/ask-pending/loop`)+ delete;New session 按钮 → `/new`。数据 = server `GET /api/sessions` + view 帧。完成条件:后台 session loop 点火时 badge 实时变,切走再回不丢。
- [ ] W2.3 timeline:delta 合并进最后一条 assistant(不产生新节点);pin-bottom(滚离 >32px 解除钉底 + "New activity below" 按钮);工具行按 callId 原位 upsert(running→done/failed,图标按 toolName,展开 `<pre>`/diff);行类型在 v1 L2 基础上原样(`goal-change/loop-fire/compaction/ask/btw-note/retry`)。完成条件:历史重放与直播同一渲染路径;reducer 纯函数有单测。
- [ ] W2.4 Context 面板 + Dev rail:v1 L3/L4 的内容原样搬(usage/prompt 拆块/goal/tasks/loops/memory/fleet/btw + 15 类着色 tail、`/` 过滤、暂停)。完成条件:每块实时刷新,dev ring 满丢最旧。
- [ ] W2.5 composer:textarea 自动增高;running 时空输入 Enter=停止、有输入 Enter=入队 followUp、⌘↵=steer;`@` mention(server 文件列表模糊匹配);ask 模态 = v1 ask_user(单选即点/多选+confirm/freeform/倒计时,队列取第一个)。完成条件:kill-重启后未决 ask 重弹。
- [ ] W2.6 快捷键:`⌘B` 侧栏、`⌘⇧O` 新建、`⌘K` 命令面板(最小集:切 session/切主题/切语言)。完成条件:与浏览器保留键无冲突。

## 3. 新建 session 向导(eta 独有)

- [x] W3.1 `/new`(persona 卡片网格必选;persona 名行进 `persona-row`,stableChars 增大由 core 测试锁定):第一步 persona 卡片网格(`GET /api/personas`,name+description,单选,无默认——**不选不能继续**);第二步同页展开 cwd 输入(默认 server 的 process.cwd())+ 首条 prompt;Create → `session.create {name: 自动标题占位, personaId, cwd}` → **乐观跳转 `/`并选中新 session**,首条 prompt 后台发送(照抄 pi-gui startThread 时序)。完成条件:persona 进入 composer 稳定块(与 core L3 拆块一致),Context 面板 prompt 稳定块能看到该 persona 文本。
- [x] W3.2 persona 热发现:向导打开时重新拉 `/api/personas`;新建后可在 Context 面板看到 persona 摘要行。完成条件:运行中新增 `.eta/persona/x.persona.md`,打开向导立即可选。

## 4. 验证

- [x] T1 server 测试(vitest/bun test 均可):协议 roundtrip、`/api/personas`(含热发现)、`session.create` 校验(非法 personaId 拒绝)、ws 双客户端帧一致、断连 loop 照常。
- [ ] T2 web 测试(jsdom + testing-library):theme provider 切换/持久化、i18n 键集相等 + locale 检测链、timeline reducer(delta 合并/tool upsert/pin-bottom 判定)、persona 向导(不选不能 create)、composer 键盘分支。
- [ ] T3 e2e:`bun run dev` 起 server+web,手测清单(建 persona session → 跑 turn → 工具行/ask 弹框/dev rail)记入本文件;可选 Playwright 后续再说。
- [ ] T4 根 `package.json`:`bun run test`/`typecheck`/`dev` 串起 core+sqlite+server+web;README 更新启动方式。完成条件:新克隆两命令可跑。

## 5. picot 借鉴(调研自 `picot/`,Tauri+内嵌 server+SPA,与我们同构)

- [ ] W5.1 Agent Inbox lite(无 Telegram,进件源留 union):server 端 `inbox/tasks.json`(status 机 `pending/needs_input/blocked/running/done/failed` + 追加式 events 审计) + 固定 "Agent Inbox" session(persona=Executor,workspace=inbox 目录,agent 用 KV/工具写任务);GUI 侧栏固定入口带 badge(pending+running 数)+ 任务面板(过滤计数/卡片折叠/项目(session)下拉/**本地批准后**才 `session.create` 派发 headless 子 session 执行,先落面包屑再执行 / View Session 跳转 / Force Cancel / History);派发 prompt 带 Task ID+来源+"要澄清就停下报 needs_input"+"完成总结改动/验证/风险"。回流:server 订阅子 session `run_end`/ask → 自动写终态/needs_input(把 picot 没接完的闭环在我们契约里做对)。完成条件:任务卡 Approve→新 session 跑完→面板自动变 done,全程无手改 json。
- [ ] W5.2 后台会话事件镜像:侧栏未读点 + 流式绿点(单 server 全量事件流,近乎白送)。
- [ ] W5.3 Context popover 化:分段条(输入/输出/缓存读/缓存写/可用)+ 就地 Compact + "请求已接受 vs 真完成"协调器。
- [ ] W5.4 回合文件 chip:每回合末尾列出写过的文件成 chip,点击预览;write/edit 工具完成自动跟随。
- [ ] W5.5 排队消息 pill(steer/follow-up 两种,composer 上方逐条,可改/删)。
- [ ] W5.6 侧栏增强:RECENT(跨 session 近 5)+ Pins + ARCHIVED 折叠 + 行内改名 + 全文搜索(带片段,server 端扫 lane)。
- [ ] W5.7 自动会话标题:首回合并行一次性小 agent 生成,不占主回合队列,不覆盖手动改名。
- [ ] W5.8 大粘贴卸载:>4KB 粘贴提示落盘换成 `@file` 引用。
- [ ] W5.9 ask/扩展对话框排队:后台会话的提问不弹模态,前台才弹,Stop 常显(照抄 picot extension-ui-host 语义,数据源 = AskRegistry)。
- [ ] W5.10 OS/Web Notification:回合完成通知,点击直达 session(URL 深链)。

## 明确不做(v2)

- Electron 壳(留待以后:BrowserWindow 指 `/`,协议零改动);terminal 面板、diff 侧挂、dnd 排序、fork/tree(都是 pi-gui 有而 v2 首版不搬);Telegram/远程进件通道与设备配对/二维码/PWA(picot 有,eta 只留 task.source union 钩子);图片附件(web 粘贴可用但先不做);virtual-list(首版全量渲染,>80 条再抄 pi-gui 区间法)。
