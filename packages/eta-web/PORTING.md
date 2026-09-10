# eta-web: React → Solid 机械移植指南

对照 [Rewriting Bun in Rust](https://bun.com/blog/bun-in-rust)：**一次换完、先长得像转译、用测试当队列、出错改这份文件而不是打补丁。**

本文冻结行为。移植时不要顺手改协议、reducer、i18n key、视觉或状态模型。细粒度 `createStore` 是合入之后的第二轮，不在这次。

配套清单：[`REACTIVITY.tsv`](./REACTIVITY.tsv)。试跑文件：`theme.tsx`、`eta-store.ts` 的 `useEta`、`composer.tsx`。

## 0. 方法

1. 只动 `packages/eta-web`。`@eta/core` / server / sqlite / `@eta/i18n` 资源不动。
2. 不要 React/Solid 混跑，不要为 markdown 留 React island。
3. 架构、路由、`data-testid`、WS 帧、对外组件 API 保持原样。
4. 现有 web 测试 0 skip / 0 delete。断言只认 DOM / 协议 / `localStorage`。
5. 不 stub（`return null` 顶上算失败）。需要一段话解释的 workaround → 代码是错的，先改 `PORTING.md`。
6. 实现者不审；审查者只看 diff，默认代码是错的。专门查「语法像、语义不像」。
7. `tsc` 报错当队列，按文件清。

## 1. 已经是框架无关的，原样留下

| 符号 | 文件 |
| --- | --- |
| `reduceEtaState` / `EtaState` / `EtaStore` 类 | `src/lib/eta-store.ts` |
| `ClientMessage` / `ServerMessage` / `DevFrame` | `src/lib/protocol.ts` |
| `detectLocale` / `persistLocale` / `normalizeLocale` | `src/i18n/locale.ts` |
| `resolveTheme` / `applyTheme` 的 DOM 写入 | `src/app/theme.tsx` |
| `fuzzyScore` | `src/features/sessions/composer.tsx`（可原位留下） |
| `cn` | `src/lib/utils.ts` |
| CSS / Tailwind / `graphite.css` | `src/styles*` |
| 纯测试 | `test/store.test.ts` `test/store-connect.test.ts` `test/locale.test.ts` `test/i18n.test.ts` |

`EtaStore` 继续发整包 snapshot。`useEta` 只换订阅适配器，不要在这一轮把 `EtaState` 拆成细粒度 store。

## 2. 模式映射

| React | Solid | 规则 |
| --- | --- | --- |
| `useState(x)` | `createSignal(x)` | 函数式更新 `setX(c => …)` 写成 `setX(c => …)`；不要在 JSX 里解构 signal |
| `useState(() => init)` | `createSignal(init())` 或惰性 init | 只跑一次 |
| `useRef(v)` 可变盒 | `{ current: v }` 普通对象，或 untracked signal | DevRail `frozen`、通知 `seen`、xterm `onExitRef`、heightRef。**不要**做成会触发渲染的 signal，除非现有行为就是渲染 |
| `useRef(null)` DOM | `let el: HTMLElement \| undefined` + `ref={el => { … }}` | Solid ref 是赋值，不是 `{ current }` |
| `useEffect(fn, [])` | `onMount` + `onCleanup` | 深链、persona 监听、xterm 建连 |
| `useEffect(fn, [a,b])` | `createEffect` + 显式读 / `on()` | **禁止**假设自动追踪等于依赖数组。边沿检测必须自己留旧值 |
| `useEffect` 返回清理 | `onCleanup` | 定时器、ResizeObserver、ws、matchMedia、keydown |
| `useMemo(fn, deps)` | `createMemo` | palette 的 command 列表。Memo 里禁止 `navigate` / `send` |
| `useCallback` | 普通函数 | Solid 不靠引用稳定来少渲 |
| `useSyncExternalStore` | `from(subscribe, snapshot)` 或 `createSignal` + `subscribe` | 见 §3.1。继续整包 snapshot |
| `createContext` + 普通对象 | context 里放 **signal/store** | Theme / Shell 的对象身份在 React 靠 `useMemo`；Solid context 默认不追踪 |
| `useContext` 抛错 | 同样抛错 | `useShell` / `useAppTheme` 在 provider 外 throw |
| `children: ReactNode` | `JSX.Element` / 已经是 JSX 的 slot | `AppShell` 的 sidebar/main/panel/palette 继续当 slot，不要改成 render-prop，除非不改就编不过 |
| `.map` + `key` | `<For each={…}>` / `<Index>` | Timeline、sidebar、palette、queue。继续 `.map` 会拆掉整棵树 |
| `{cond && <X/>}` | `<Show when={cond}>` | 条件挂载（Welcome vs Timeline、palette、抽屉） |
| `className` | 机械阶段可继续 `className`（Solid 兼容） | 不要顺手改成 `class` 除非碰那个节点 |
| `htmlFor` | `for` | 本仓几乎不用 |
| 输入 `onChange` | **`onInput`** | textarea/input 的每个键。`change` 在 Solid 是 blur。测试用 `setField`（`input`+`change`） |
| `onKeyDown` / `onPaste` | 同名，**原生事件** | `event.nativeEvent.isComposing` → `event.isComposing` |
| `PointerEvent as ReactPointerEvent` | 原生 `PointerEvent` | `app-shell` Resizer、`terminal-drawer` |
| `forwardRef` / `displayName` | 直接 `ref` prop | Button / Dialog 手写后不需要 |
| `asChild` + Radix Slot | 不要 | Button 去掉 `asChild`，ModelPicker 自己包 button |
| `StrictMode` | 删 | 组件只挂一次。测试已不依赖双挂 |
| `createRoot().render` | `render` from `solid-js/web` | `main.tsx` |
| `wouter` `Router/Switch/Route/Link/useLocation` | `@solidjs/router` 的 `Router/Route/A/useNavigate/useLocation` | 路由只有 `/` `/new` `/settings`。测试用 `MemoryRouter` |
| `react-i18next` `useTranslation` | 留下 `i18next` 实例，钩子自己写 | `i18n.changeLanguage` + signal。`@eta/i18n` 不动 |
| `@testing-library/react` | `@solidjs/testing-library` | **只改** `test/render.tsx`。规格文件继续走 `test/dom.ts` |

## 3. 语义陷阱（编译过、行为漂）

这些是这篇的 `debug_assert!`。对抗审查必须逐条查。

### 3.1 `useEta()` 不能再当「每次渲染读 snapshot」

React：`useSyncExternalStore` 让每个调用方在 emit 时重渲，读到新对象。

Solid：组件函数只跑一次。必须：

```ts
export function useEta(): EtaState {
  const store = etaStore();
  return from(store.subscribe.bind(store), () => store.snapshot());
}
```

或 `createSignal(store.snapshot())` + `store.subscribe(() => set(store.snapshot()))`。

调用方写 `const state = useEta()` 之后，读字段必须追踪（`state.sessions` 若 `from` 返回 store 要按 Solid store 规则读）。机械阶段最稳：`from` 得到 accessor，页面里 `state().sessions`。若为了少改调用方，可把 `useEta` 做成返回一个 **store proxy**（`createStore` 包住 snapshot，subscribe 时 `setState(snapshot)` 整包替换顶层字段）——行为仍是整包更新，只是 API 仍是 `state.sessions`。**禁止 `reconcile`**：它就地改写 `dev[]` / `views`，DevRail `frozen.current = frames` 会握到活列表。

**禁止**在机械阶段按字段切片订阅。

### 3.2 解构 props 剪断追踪

`function Timeline({ view, session, running })` 在 Solid 里 `view` 是第一次的快照。统一：

- 组件第一行 `const { session } = splitProps(props, ["session"])` 只拆不变的 id
- 变化的 `view` / `running` 用 `props.view` / `() => props.view`

试跑和审查把「顶层解构 SessionView」当缺陷。

### 3.3 依赖数组 ≠ 自动追踪

| 现有 effect | 必须保持的语义 | Solid 怎么写 |
| --- | --- | --- |
| Timeline `[view, pinned]` | **整个 view 一换**且 pinned 就滚到底 | 显式读 `props.view` 的引用（或 `compactionEpoch`+`messages.length`+`streaming` 不够——现网就是整对象）+ `pinned()` |
| Composer 草稿 `[draftKey]` | 换 session 才重载 localStorage | `on(() => draftKey, …)` 不要追踪 `text` |
| Composer 草稿 `[text, draftKey]` | 每次击键写盘 | 可以自动追踪这两个 |
| Composer mention `[mentionQuery !== null, session, files.length]` | **只在 @ 出现且 files 空时打一次** `/api/files` | 必须保留布尔门。若追踪 `mentionQuery` 字符串会每个字符 refetch |
| ContextPanel `[session]` | 换 session 才拉 models | `on(() => props.session, …)` |
| ContextPanel `[view.compactionEpoch, epochAtRequest]` | epoch 越过请求时的值才清 compacting | 显式比较，不要只因 `view` 别的字段变化而清 |
| ContextPanel `[compacting]` 15s 超时 | 仅 compacting 为真时开定时器 | `createEffect` 里 `if (!compacting()) return` |
| AskModal `[view.pendingAskDeadline]` | deadline 有值才 `setInterval` | 同上 |
| 通知 `[runningBySession, attach]` | **边沿** was&&!running 且非 attach | `seen` 用普通 `{current}` 盒；effect 里对比旧值。自动追踪整个 snapshot 会漏边沿或误报 |
| ModelPicker `[session]` | session 变先 `setInfo(undefined)` 再 fetch | 先清空再请求，用 `live` 标志丢弃乱序 |
| New/Welcome persona `[]` + `eta:personas` | 挂载拉一次 + 事件刷新 | `onMount`；清理时摘监听 |
| DevRail **render 期** `if (!paused) frozen.current = frames` | 未暂停时 frozen 跟着最新 frames | **不能**只在 create 时写一次。`createEffect`：`if (!paused()) frozen.current = frames`，或 `held = paused() ? frozen : frames` |

### 3.4 列表身份

Timeline 用 `entry.entryId`；streaming 行 key 是 `"streaming"`。Sidebar 用 `session.name`。必须 `<For>`，否则 pin-bottom、选区、展开的 tool `<details>`、xterm 都会抖。

`view.messages.map` 外面还有 IIFE 建 `results` Map——这是 **派生数据**，用 `createMemo`，不要在 JSX 里靠每次重渲重建。

### 3.5 输入事件

`composer-input` / `cwd-input` / `prompt-input` / `toolbox-file-search` / `loop-note` / `task-new` / `ask-freeform` / `btw-input` / `sidebar-search` / `dev-filter` / `palette-input` 全部是「每个键更新」。Solid 用 `onInput`。

测试已经走 `test/dom.ts` 的 `setField`（原生 setter + `input` + `change`）。移植后 **不要**改回 `fireEvent.change`。

`onKeyDown` 里 `event.nativeEvent.isComposing` 改 `event.isComposing`。

### 3.6 Context

`ThemeProvider` 的 value 必须是 signal：`theme` / `resolvedTheme` / `setTheme`。Settings / palette 读到的才能变。

`AppShell` 的 `leftOpen` / `rightOpen` / `paletteOpen` / setters 同样放进 context 上的 signal。`useShellOptional` 在 Composer（Welcome 无 shell）里可以为 undefined。

### 3.7 其它

- `useRunNotifications` 的 `seen` 是边沿存储器，不是 UI state。
- `TermTab` 的 `useEffect([cwd])` 会拆掉整个 xterm+ws。Solid 同样：`cwd` 变才 dispose/重建。`onExit` 走 ref 盒，避免 effect 重跑。
- `command-palette` 的 `useMemo` 依赖 `t` / `shell`。Solid 用 `createMemo` 读 `useEta()` 的 sessions 即可；`t` 随 locale signal 变。
- `window.location.assign`（Welcome 去 settings、slash `/new`）保持原样，不要改成 router，除非那条路径已经在用 `navigate`。
- `humanizeAge(Date.now())` 在 React 每次重渲会变。机械阶段保持「读 store 才更新」，不要额外 `setInterval`。
- `useEtaOps` 和 `Badge` / `Tooltip*` **没有调用方**。不要为它们引入新依赖；可原样翻或删，但不要借机加 Kobalte Tooltip。

## 4. 依赖

| 现在 | 去做 | 不要 |
| --- | --- | --- |
| `react` `react-dom` `@vitejs/plugin-react` | `solid-js` `vite-plugin-solid` | 双运行时 |
| `@testing-library/react` | `@solidjs/testing-library`，只改 `test/render.tsx` | 规格里直接 import RTL |
| `wouter` | `@solidjs/router` | 自写 history |
| `react-i18next` | 自写 `useAppI18n` | 换 i18n 资源格式 |
| `lucide-react` | 内联 `X` / `ChevronDown` 两枚 SVG | 再加 icon 包 |
| `@radix-ui/*` `cmdk` | **手写** Dialog / Dropdown / Palette，API：`open` / `onOpenChange` / 现有 `data-testid` | Kobalte/Corvu 过渡 |
| `streamdown` `@streamdown/code` `@streamdown/math` | 换 Solid 流式 markdown（首选对照 `solid-streamdown` 或 `flomark/solid`）。先做流式/未闭合围栏/KaTeX 对照 | React island；先 `innerHTML` 顶上 |
| `@xterm/*` | 只换生命周期 | 换终端库 |
| `class-variance-authority` `clsx` `tailwind-merge` | 可留 | 重写 class 系统 |

Dialog 手写最低行为（现有测试依赖）：

- `open` 为真才挂 `DialogContent`
- 有 overlay；默认右上角关闭，`hideClose` 则无（ask-modal）
- `onOpenChange(false)` 在 overlay / 关闭钮
- 现有 `data-testid`：`ask-modal` `prompt-overlay` `tools-overlay` `json-overlay` `memory-dialog` `persona-switch-dialog` `btw-dialog` `dev-frame-dialog` `file-preview`

Palette：过滤 label、键盘上下/回车、空态 `palette.empty`。不必复刻 cmdk 全部 a11y，但 `data-testid="command-palette"` / `palette-input` / `palette-item-*` 要在。

## 5. 切片顺序（铺开时）

试跑绿了才能按这个切。每片：改文件 → `tsc` → 相关测试 → 对抗审查。

| 片 | 文件 |
| --- | --- |
| 0 试跑 | `theme.tsx`，`eta-store.ts` 的 `useEta`，`composer.tsx` |
| 1 壳 | `main.tsx`，`app-shell.tsx`，`i18n.ts`，路由 |
| 2 UI 壳 | `button` `dialog` `dropdown-menu`（手写）。`badge`/`tooltip` 无调用方可删 |
| 3 主路径 | `sessions-page` `sidebar` `timeline` `context-bar` `context-panel` |
| 4 输入 | `ask-modal` `btw-dialog` `model-picker` `welcome` `new-session-page` |
| 5 外围 | `settings-page` `dev-rail` `terminal-drawer` `command-palette` |
| 6 markdown | `message-markdown.tsx` **单独对照**，不和其它片搅 |

`vite.config.ts`：`react()` → `solid()`。`package.json` 依赖按 §4 换。

## 6. 测试合同

规格已经不依赖 RTL / `StrictMode` / `act` 细节：

| 规格 | 证明什么 |
| --- | --- |
| `test/dom.ts` | `data-testid`、原生 `input`/`change`/`click`/`keydown` |
| `test/fake-socket.ts` | `sent` JSON / `fire` 帧 |
| `test/render.tsx` | **唯一** 允许出现 `@solidjs/testing-library` 的地方 |
| `test/memory-router.tsx` | `@solidjs/router` 的 `MemoryRouter` + `createMemoryHistory` |
| `composer.test.tsx` | Enter 发送、空 Enter abort、@ mention、slash、pending ask disabled |
| `theme.test.tsx` | `resolveTheme` + 点按钮写 `class` / `localStorage` |
| `smoke.test.tsx` | hello+view 出 `user-message`，点 `prompt-open` 出 section |
| `wizard.test.tsx` | 未选 persona 不能创建；选了发 `session.create` 并回到 `/` |
| `devrail.test.tsx` | 点击帧打开 dialog |
| `store*.ts` `locale.test.ts` `i18n.test.ts` | 已是纯 TS，不动 |

`setup.ts` 每测重置 store 单例 + FakeSocket。移植后 `resetEtaStoreForTests` 留下。

绿的定义：`bun run --cwd packages/eta-web test` 与 `typecheck` 都过；手测 hello→view、Enter、流式 markdown、⌘K、主题/语言、抽屉、终端 tab。

## 7. 审查清单

对每个 TSX diff：

1. 有没有顶层解构会变的 props（尤其 `view`）？
2. effect 是不是把依赖数组翻译成了「多读/少读」？
3. 列表是不是 `<For>`，key 还是不是 `entryId` / `session.name`？
4. 输入是不是 `onInput`？IME 是否还挡 Enter？
5. context 里是不是 signal，而不是冻结对象？
6. 有没有 stub、超长注释、跳过测试？
7. 有没有改 reducer / 协议 / class 名 / i18n key？

## 8. 明确不做

- 生产里按路由渐进替换
- 为 streamdown 留 `react` / `react-dom`
- Radix → Kobalte 再换一次
- 把 `EtaState` 改成细粒度 store（第二轮）
- 删「暂时不好移植」的测试
- 改 WS 协议、视觉、文案
