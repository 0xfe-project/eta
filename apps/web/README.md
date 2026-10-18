# Web

Vite + React + React Compiler。界面只通过 host 的一条 WebSocket（`/ws`）读写，没有 REST、没有生成的 API 客户端。开发命令在仓库根目录执行 `bun run dev`（host 与 vite 一起起）；生产由 host 用 `--web-dir` 直接提供构建结果（`bun run --cwd apps/web build` → `dist/`，其中的 `BUILD` 文件是 `/version` 的内容）。

## 已配置的库

| 用途           | 库                                                | 配置入口                                                                                          |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 图标           | `@phosphor-icons/react`                           | `src/components/providers.tsx`，默认 20px / regular                                               |
| 智能体头像     | `blobatar` + `@blobatar/react`                    | `AgentAvatar`（`agent-identity.tsx`），按 id 生成；动画需 `styles.css` 引入 `blobatar/motion.css` |
| 路由           | `@tanstack/react-router`                          | `src/router.tsx` + `src/routes/`                                                                  |
| 服务端状态     | `@tanstack/react-query` + 自己的 wire store       | `src/lib/query-client.ts`、`src/lib/wire.ts`、`src/queries/`                                      |
| URL 状态       | `nuqs`                                            | 根组件 adapter                                                                                    |
| 表单与校验     | `react-hook-form` + `@hookform/resolvers` + `zod` | `src/components/workspace/agent-editor.tsx`                                                       |
| 通知           | `sonner`                                          | 根组件挂载 `Toaster`，业务中调用 `toast.success()`                                                |
| Markdown       | `streamdown` + `@streamdown/cjk`                  | `src/components/markdown.tsx`                                                                     |
| 样式           | Tailwind CSS v4                                   | `vite.config.ts` + `src/styles.css`                                                               |
| React Compiler | `babel-plugin-react-compiler`                     | `vite.config.ts` 的 `reactCompilerPreset`                                                         |

`@/` 同时在 TypeScript 和 Vite 中指向 `src/`。

## 数据层

`src/lib/wire.ts` 是页面唯一的连接：说 `@eta/client-wire-proto` 的管道协议，处理 `hello`、`reply`、`state`、`event`，断线后以递增的间隔重连，重连时重新订阅仍有人使用的 target，等不到回复的调用以错误结束。连接状态和各 target 的 section / revision 放在一个 zustand store 里。类型来自 `@eta/client-contracts`。协议见 [线协议与 target](../../docs/architecture/wire-protocol.md)。

`src/queries/wire.ts` 把它接成 hooks（`useTarget`、`useConnectionLost` 和调用用的 mutation）；每个 target 一个 `src/queries/<target>.ts`（agents、machines、projects、conversations、sessions、providers、inbox、tasks、artifacts、routines、memory、usage、personas），签名贴近 react-query 的习惯。读到的是 host 推来的状态，不轮询。

`hello.mounted` 里没有的插件，对应入口隐藏而不是报错（例如没有记忆边车时的记忆页，见 `queries/memory.ts`）。

开发时 vite 只代理 `/ws`（目标 `ETA_HOST_ORIGIN`，默认 `http://127.0.0.1:8787`），浏览器带的是 vite 的 origin，所以 host 以 `--allow-origin` 放行它（根目录的 `dev` 脚本已经做了）。`/up` 与 `/version` 由提供页面的服务器回答：开发时是 vite，生产时是 host，页面据此（`src/lib/update.ts`）提示"有新版本"。

## 国际化

使用 `react-i18next`，简体中文与英文资源按功能放在 `src/locales/zh/<namespace>.json` 和 `en/<namespace>.json`，由 `resources.ts` 注册，共 14 个 namespace（common、agents、artifacts、chat、machines、connections、memory、navigation、overview、providers、routines、settings、tasks、validation）。共用按钮、时间和通用标签放在 common，各功能维护自己的资源。

所有界面文字、无障碍标签、通知和校验提示都从资源读取；用户内容、产品名、代码和命令保留原文。key 使用稳定的英文语义路径，如 `tasks:status.todo`，禁止中文 key 或整句文案 key。插值参数按含义命名；英文数量文案维护 `_one` / `_other`。

默认按 `navigator.languages` 选择中英文，中文地区变体统一使用简体中文，其他语言回退英文。设置 → 外观 → 语言可选择跟随系统、中文或 English，保存在 `eta.language.v1`，即时切换并跨标签页同步。React 组件显式声明 namespace，如 `useTranslation(["tasks", "common"] as const)`；组件外通过 `src/lib/i18n.ts` 的 `translate("tasks:status.todo")` 在调用时读取语言。`src/@types/i18next.d.ts` 从英文资源推导 key 类型，拼错 key 或 namespace 在类型检查中失败。`i18n.test.ts` 检查 namespace/key 一致性、英文语义 key、插值变量和源码调用覆盖。

## Query

`getRouter()` 为每个路由实例创建独立 QueryClient（测试与应用不共用缓存），默认保鲜 30 秒、失败重试一次、mutation 不重试。

## 加载、空与出错

`src/components/states.tsx` 是各处共用的三种状态，不要再手写「正在加载…」或单独一行的空提示：

- `Loading`：灰色骨架，形状接近将要出现的内容（`list`、`detail`、`lines`）；延迟 300ms 淡入，快的请求不会闪一下。
- `Empty`：居中的图标 + 一句「还没有…」+ 这里会放什么 + 开始的按钮。筛选或搜索后为空也用它，按钮换成清除筛选。
- `LoadError`：同样的排版，「无法加载…」+ 错误信息 + 重试。

## 表单、通知与 Markdown

智能体编辑器用 `useForm` + `zodResolver` 校验字段，错误显示在字段下方，结果用 toast 提示。`Markdown` 支持 GFM 表格、列表与代码块，不渲染原始 HTML，过滤不安全 URL，链接在新标签页打开；聊天中正在输出的文本用 `streaming` 模式，其余用静态模式。

## shadcn 与设计规范

`components.json` 使用 `radix-lyra`、neutral 配色和 Phosphor 图标，组件源码在 `src/components/ui/`。后续添加组件在 `apps/web` 执行 `bunx shadcn@latest add <component>`；再次应用 preset 可能覆盖 `src/styles.css`，需要保留以下项目规则：

- 字体是本地打包的 Geist Variable / Geist Mono Variable。
- `--radius` 与所有 Tailwind radius token 均为 `0px`；全局样式把元素和伪元素的 `border-radius` 强制设为 0。
- 组件用 `bg-background`、`text-foreground` 等语义 token，不写死单一主题的颜色。
- `ThemeProvider` 默认跟随系统，设置 → 外观可切换。

界面约定见 [AGENTS.md](AGENTS.md) 与根目录的 [DESIGN.md](../../DESIGN.md)。所有单选入口统一用 `select-field.tsx` 组合官方 Select（不用原生 select）。

## 页面与路由

文件路由在 `src/routes/`。

- `/`：工作台。侧栏 project → 对话 → 成员（机器多于一台时先按机器分一层），底部是智能体库；主区是对话，header 有主理人芯片。
- `/new`：新建对话，选 project 与智能体；`?project=<id>` 预选 project。
- `/workspace`：全窗口应用外壳（`app-shell.tsx`），下面是 `/workspace/tasks`、`/workspace/routines`、`/workspace/inbox`、`/workspace/memory`（仅有记忆边车时）、`/workspace/more`（手机上的入口页）。
- 设置是首页和 `/workspace` 共用的弹层，分区：智能体、模型服务、审批、机器、已归档、外观。`?settings=<分区>` 在任意页面打开对应分区一次，随后从地址里去掉。
- 任务页：列表（按状态分组）或看板，`?task=<id>` 打开、`?task=new` 新建；定时任务页参数是 `routine`、`run`、`edit`；待处理页按天分组，`?filter=pending` 只看待处理。分区和侧栏共用同一套 URL 参数（`task-nav.ts`、`routine-nav.ts`、`workspace-search.ts`），都支持直接访问、刷新和浏览器历史。

`localStorage` 只放这个浏览器自己的东西，都用 Zod 校验：`eta.workspace.v1` 是界面状态（布局、字体、上次用的模型、任务页过滤等），`eta.groups.v1` 是草稿和还没送达的消息，`eta.language.v1` 是语言。

## React Grab（圈选元素）

`react-grab` 由 `src/lib/element-picker.ts` 动态加载：默认只在开发构建开启，工作区状态里的 `reactGrab` 可以覆盖。把鼠标移到页面元素上按 ⌘C（Windows/Linux 为 Ctrl+C），即可复制元素、组件和源码位置信息。生产构建带 source map，使圈选在生产包上也能映射回源码。

## 验证

```sh
bun run --cwd apps/web build
bun run --cwd apps/web typecheck
bun run --cwd apps/web test
```

`typecheck` 依赖 `build` 先生成 `src/routeTree.gen.ts`（不入库）；根目录的 `bun run check` 经 turbo 按这个顺序执行。
