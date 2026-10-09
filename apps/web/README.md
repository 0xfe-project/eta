# Web

TanStack Start + React。开发命令在仓库根目录执行 `bun run dev`。

## 已配置的库

| 用途         | 库                                                | 配置入口                                            |
| ------------ | ------------------------------------------------- | --------------------------------------------------- |
| 图标         | `@phosphor-icons/react`                           | `src/components/providers.tsx`，默认 20px / regular |
| 服务端状态   | `@tanstack/react-query`                           | `src/lib/query-client.ts`                           |
| Query SSR    | `@tanstack/react-router-ssr-query`                | `src/router.tsx`                                    |
| URL 状态     | `nuqs`                                            | 根组件 adapter，首页 `view` 示例                    |
| 表单与校验   | `react-hook-form` + `@hookform/resolvers` + `zod` | `src/components/prompt-preview.tsx`                 |
| 通知         | `sonner`                                          | 根组件挂载 `Toaster`，业务中调用 `toast.success()`  |
| Markdown     | `react-markdown` + `remark-gfm`                   | `src/components/markdown.tsx`                       |
| 样式         | Tailwind CSS v4                                   | `vite.config.ts` + `src/styles.css`                 |
| 条件样式合并 | `cn`（shadcn CLI 配置）                           | `src/lib/utils.ts` 的 `cn()`                        |

`@/` 同时在 TypeScript 和 Vite 中指向 `src/`。

## Query

`getRouter()` 为每个路由实例创建独立 QueryClient，避免 SSR 请求间共享缓存。SSR integration 提供 QueryClientProvider、缓存序列化和 hydration。默认查询保鲜 30 秒，失败重试一次；mutation 不自动重试。

按功能在 `src/queries/` 中定义 `queryOptions()`，在组件中通过 `useQuery()` 消费。控制面接口经 `src/lib/api.ts` 的 `controlPlane`（openapi-fetch）调用，路径、参数、请求体和响应的类型都由 `bun run generate` 从控制面的 OpenAPI 文档生成到 `src/api/control-plane.gen.ts`（不入库）。该相对路径 query 仅用于浏览器，由开发代理或生产反向代理处理。

需要 SSR 预取时，在 loader 中调用 `context.queryClient.ensureQueryData(options)`，并在组件中通过 `useSuspenseQuery(options)` 读取；此时 queryFn 必须能够在服务端执行，例如调用 Start server function，由其访问后端绝对 URL。不要在 SSR 中直接复用相对路径的 health query。

## URL 状态

根组件使用 `nuqs/adapters/tanstack-router`。首页的 `view` parser 同时用于 `useQueryState` 和 `createStandardSchemaV1`，后者传给路由的 `validateSearch`，使 Router 的搜索参数类型与 nuqs 保持一致。示例使用 `history: 'push'` 支持浏览器前进后退。

**兼容性限制：** [nuqs 官方文档](https://nuqs.dev/docs/adapters#tanstack-router)仍将 TanStack Router adapter 标记为实验性，未承诺 TanStack Start 支持。本项目已验证字符串视图状态的 SSR、hydration、刷新和前进后退；页面 hydration 尚未完成时立即进行历史导航的检查中曾出现一次 hydration mismatch；全新会话和等待页面就绪后的重复检查均未报错。复杂参数或升级后需重新验证。Router loader 依赖的参数也可以直接使用 TanStack Router 的 `validateSearch` / `Route.useSearch()`。

## 图标与样式

按图标路径导入，避免开发时解析完整图标目录：

```tsx
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { cn } from "@/lib/utils";

<RobotIcon
  aria-hidden="true"
  className={cn("text-slate-500", active && "text-blue-600")}
/>;
```

图标按钮应有可访问名称，例如 `aria-label` 或可见文字。Phosphor 的常规 React 组件支持本项目的 React SSR；不需要切换为 RSC 版本。

## 表单、通知与 Markdown

`PromptPreview` 演示 `useForm` + `zodResolver`、字段错误、提交后 toast 和 Markdown 渲染。它只在浏览器内预览，不调用 agent 或持久化数据。

`Markdown` 支持 GFM 表格、列表与代码块，跳过原始 HTML，保留 react-markdown 默认 URL 过滤。后续 agent 消息可复用该组件；当前未实现流式传输或代码高亮。

## 验证

```sh
bun run --cwd apps/web build
bun run --cwd apps/web typecheck
```

已验证构建、类型检查、浏览器健康请求、表单校验、通知、Markdown 和 nuqs URL 状态。Query Devtools 已关闭，不挂载或加载。

参考：[Query SSR integration](https://tanstack.com/router/latest/docs/integrations/query)、[Phosphor React](https://github.com/phosphor-icons/react)、[React Hook Form resolvers](https://github.com/react-hook-form/resolvers)、[react-markdown](https://github.com/remarkjs/react-markdown)。

## shadcn 与设计规范

已执行 `pnpm dlx shadcn@latest apply --preset buFzlTs -y`。`components.json` 使用 `radix-lyra`、neutral 配色和 Phosphor 图标。已安装 Button、Input、Textarea、Label、NativeSelect、Sonner、Tabs、Dialog、Tooltip，源码在 `src/components/ui/`。

根据 [Vercel design.md](https://vercel.com/design.md) 中适用于产品界面的规则，统一使用 Geist Sans / Geist Mono、单色语义主题、清晰层级与焦点状态，支持系统深浅模式和减少动效偏好。本项目是 AXP 产品界面，借用视觉规范，不添加 Vercel 报告品牌标识或报告专用 CSS 层。

应用 preset 后的项目覆盖规则：

- 字体从 preset 的 Inter 改为本地打包的 Geist Variable / Geist Mono Variable。
- `--radius` 与所有 Tailwind radius token 均为 `0px`；全局样式同时将元素和伪元素的 `border-radius` 强制设为 0，覆盖通知、弹层和内联圆角。
- 组件使用 `bg-background`、`text-foreground`、`text-muted-foreground`、`border-border` 等语义 token，避免写死浅色主题。
- `ThemeProvider` 当前固定亮色，Sonner 与页面共用主题；保留 `.dark` 变量供后续主题切换。

后续添加组件，在 `apps/web` 执行 `bunx shadcn@latest add <component>`。仓库继续使用 Bun 管理依赖；本机 pnpm 由 Corepack 代理，执行 pnpm CLI 时需加 `COREPACK_ENABLE_PROJECT_SPEC=0`，避免根目录 `packageManager: bun` 的校验冲突。再次应用 preset 可能覆盖 `src/styles.css`，需要保留上述字体和零圆角规则。

## 工作台

首页左侧为聊天，右侧为概览 / 任务 / 定时 / 记忆 / 能力 / 确认面板；全窗口工作台在 `/workspace`（见「页面与路由」）。源码在 `src/components/workspace/`。

聊天使用 brainless 消息与输入组件，默认 Claude 外观，使用原版单行 Prompt，支持 Enter 发送，使用一个常驻会话。右上角 Settings 可立即切换 Claude / Codex / Grok 外观，选择随工作区保存，切换保留消息与草稿。当前仅保存用户消息，尚未调用模型。任务支持新增、完成、删除；Memory 支持编辑上下文。数据使用 Zod 校验后保存在 `localStorage` 的 `axp.workspace.v1`，只属于当前浏览器，不会同步到后端。Capabilities 中的 Control plane 状态来自控制面的健康检查，与 agent runtime 是否连接无关。

已验证桌面/手机布局、深浅主题、任务与上下文操作、消息发送、刷新持久化、页签 URL 与浏览器后退。

## React Grab

开发依赖 `react-grab` 在 `src/client.tsx` 中按 `import.meta.env.DEV` 动态加载，并在 React hydration 前初始化。生产构建不加载此工具。

启动 `bun run dev` 后，将鼠标移到页面元素上，按 ⌘C（Windows/Linux 为 Ctrl+C），即可复制元素、组件和源码位置信息，再粘贴给 coding agent。参考 [React Grab 官方说明](https://github.com/aidenybai/react-grab)。

## Terminal agent UI

终端 agent 界面优先使用 [brainless](https://brainless.swerdlow.dev/components)，不要自行拼 ASCII 界面或将整段 agent 输出塞进 `<pre>`。保留组件的 `details`、`listbox`、`radiogroup`、`aria-live` 等语义。

`components.json` 已注册 `@brainless`，安装了 Claude、Codex、Grok 三套 session 及其基础组件，源码在 `src/components/brainless/`。后续在 `apps/web` 执行 `bunx shadcn@latest add @brainless/<name>`。

```tsx
import { ClaudeSession } from "@/components/brainless/blocks/claude-session";
import { CodexHeader } from "@/components/brainless/codex/codex-header";
import { GrokThought } from "@/components/brainless/grok/grok-thought";
```

`blocks/*-session.tsx` 是带静态演示内容的组合示例，尚未挂载到首页。首页已复用三套消息与输入组件；Header、Message、Prompt 保留 registry 原版结构与样式，不注入演示会话记录。仅把颜色常量映射到 `brainless/theme.css` 的 `--terminal-*` 语义变量。当前强制亮色；`.dark` 变量已预留，未来移除 AppProviders 的 `forcedTheme="light"` 并接入主题切换即可。接入运行时数据时继续组合工具调用、思考状态等组件；保持项目的零圆角规则。

## 页面与路由

- `/`：聊天与右侧面板（概览仪表盘、任务、定时、记忆、能力、确认）。除概览外，标签右上角的「在全窗口中打开」进入 `/workspace` 下对应的位置。手机上通过「对话 / 工作区」切换。
- `/workspace`：全窗口工作台，传统应用布局。宽屏（`lg` 起）左侧边栏切换分区并列出智能体（点击回到 `/` 与它对话），窄屏收成顶部图标栏。外壳在 `app-shell.tsx`，挂在 `/workspace` 布局路由上；`/workspace` 本身跳到任务。
- `/workspace/tasks`：任务列表（按状态分组，点状态图标直接改）或看板（`?layout=board`，拖动卡片改状态），`?scope=` 按指派过滤；`?task=<id>` 打开任务，正文和时间线在左、属性在右；`?task=new` 新建。
- `/workspace/routines`：列表在左、定时任务详情或报告在右，参数同面板（`routine`、`run`、`edit`）。
- `/workspace/memory`、`/workspace/capabilities`：对应面板内容的全窗口版本。
- `/workspace/inbox`：确认请求，形态像通知：按天分组，待处理的标记出来、就地答复，之前的显示当时的选择或已过期；`?filter=pending` 只看待处理。历史来自 `GET /api/v1/chat/interactions`，并由聊天事件流保持实时。

分区和面板共用同一套组件与 URL 参数（`task-nav.ts`、`routine-nav.ts`、`workspace-search.ts`），都支持直接访问、刷新和浏览器历史导航。
