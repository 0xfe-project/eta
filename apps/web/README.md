# Web

TanStack Start + React。开发命令在仓库根目录执行 `bun run dev`。

## 已配置的库

| 用途         | 库                                                | 配置入口                                            |
| ------------ | ------------------------------------------------- | --------------------------------------------------- |
| 图标         | `@phosphor-icons/react`                           | `src/components/providers.tsx`，默认 20px / regular |
| 服务端状态   | `@tanstack/react-query`                           | `src/lib/query-client.ts`                           |
| Query SSR    | `@tanstack/react-router-ssr-query`                | `src/router.tsx`                                    |
| Query 调试   | `@tanstack/react-query-devtools`                  | 仅开发环境懒加载                                    |
| URL 状态     | `nuqs`                                            | 根组件 adapter，首页 `view` 示例                    |
| 表单与校验   | `react-hook-form` + `@hookform/resolvers` + `zod` | `src/components/prompt-preview.tsx`                 |
| 通知         | `sonner`                                          | 根组件挂载 `Toaster`，业务中调用 `toast.success()`  |
| Markdown     | `react-markdown` + `remark-gfm`                   | `src/components/markdown.tsx`                       |
| 样式         | Tailwind CSS v4                                   | `vite.config.ts` + `src/styles.css`                 |
| 条件样式合并 | `cn`（shadcn CLI 配置）                           | `src/lib/utils.ts` 的 `cn()`                        |

`@/` 同时在 TypeScript 和 Vite 中指向 `src/`。

## Query

`getRouter()` 为每个路由实例创建独立 QueryClient，避免 SSR 请求间共享缓存。SSR integration 提供 QueryClientProvider、缓存序列化和 hydration。默认查询保鲜 30 秒，失败重试一次；mutation 不自动重试。

按功能在 `src/queries/` 中定义 `queryOptions()`，在组件中通过 `useQuery()` 消费。首页使用 `/api/health` 验证 Django 连通性，并由 Zod 校验响应。该相对路径 query 仅用于浏览器，由开发代理或生产反向代理处理。

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

已验证构建、类型检查、浏览器健康请求、表单校验、通知、Markdown 和 nuqs URL 状态。QueryDevtools 仅在开发构建中加载。

参考：[Query SSR integration](https://tanstack.com/router/latest/docs/integrations/query)、[Phosphor React](https://github.com/phosphor-icons/react)、[React Hook Form resolvers](https://github.com/react-hook-form/resolvers)、[react-markdown](https://github.com/remarkjs/react-markdown)。

## shadcn 与设计规范

已执行 `pnpm dlx shadcn@latest apply --preset buFzlTs -y`。`components.json` 使用 `radix-lyra`、neutral 配色和 Phosphor 图标。已安装 Button、Input、Textarea、Label、NativeSelect、Sonner、Tabs、Dialog、Tooltip，源码在 `src/components/ui/`。

根据 [Vercel design.md](https://vercel.com/design.md) 中适用于产品界面的规则，统一使用 Geist Sans / Geist Mono、单色语义主题、清晰层级与焦点状态，支持系统深浅模式和减少动效偏好。本项目是 AXP 产品界面，借用视觉规范，不添加 Vercel 报告品牌标识或报告专用 CSS 层。

应用 preset 后的项目覆盖规则：

- 字体从 preset 的 Inter 改为本地打包的 Geist Variable / Geist Mono Variable。
- `--radius` 与所有 Tailwind radius token 均为 `0px`；全局样式同时将元素和伪元素的 `border-radius` 强制设为 0，覆盖通知、弹层和内联圆角。
- 组件使用 `bg-background`、`text-foreground`、`text-muted-foreground`、`border-border` 等语义 token，避免写死浅色主题。
- `ThemeProvider` 跟随系统主题；Sonner 与页面共用主题。无需可见主题开关。

后续添加组件，在 `apps/web` 执行 `bunx shadcn@latest add <component>`。仓库继续使用 Bun 管理依赖；本机 pnpm 由 Corepack 代理，执行 pnpm CLI 时需加 `COREPACK_ENABLE_PROJECT_SPEC=0`，避免根目录 `packageManager: bun` 的校验冲突。再次应用 preset 可能覆盖 `src/styles.css`，需要保留上述字体和零圆角规则。

## 工作台

首页参考 [today.ai hero](https://today.ai/) 中的左右分栏：桌面左侧为聊天，右侧为 Overview / Tasks / Memory / Capabilities；手机上通过 Chat / Workspace 切换面板。源码在 `src/components/workspace/`。

聊天支持快捷起始提示、Enter 发送、Shift + Enter 换行、Markdown 消息和新建会话。当前仅保存用户消息，尚未调用模型。任务支持新增、完成、删除；Memory 支持编辑上下文。数据使用 Zod 校验后保存在 `localStorage` 的 `axp.workspace.v1`，只属于当前浏览器，不会同步到后端。顶部连接状态来自 Django 健康检查，与 agent runtime 是否连接无关。

已验证桌面/手机布局、深浅主题、任务与上下文操作、消息发送、刷新持久化、页签 URL 与浏览器后退。

## React Grab

开发依赖 `react-grab` 在 `src/client.tsx` 中按 `import.meta.env.DEV` 动态加载，并在 React hydration 前初始化。生产构建不加载此工具。

启动 `bun run dev` 后，将鼠标移到页面元素上，按 ⌘C（Windows/Linux 为 Ctrl+C），即可复制元素、组件和源码位置信息，再粘贴给 coding agent。参考 [React Grab 官方说明](https://github.com/aidenybai/react-grab)。
