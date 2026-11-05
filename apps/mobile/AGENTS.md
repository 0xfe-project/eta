# 手机端（apps/mobile）

Native Shell（nsh，TSX on QuickJS）写的 iOS/Android 客户端。设计稿在 Paper 文件「Eta mobile」
（`01M6NVTTY29AE2FET8P4VRX3ZK`），总览页写了产品判断：**首屏是「等你」**、**就地答完**、**过程是证据**、
**手机只是一块屏**、**黑白，红绿只留给 diff 和错误**。不做：锁屏推送、提问过期提示、语音转写、邮箱。
留在电脑：模型、MCP、审批、GitHub、编辑智能体、管理机器。

## 还原设计稿

- 用 `get_jsx`（`includeNodeIds:false`，`format:"tailwind"`）取精确值，截图只用来对照结果。
- Paper 的导出类名和本工程不完全相同，按下表翻译：

| Paper                                        | 这里                                                 |
| -------------------------------------------- | ---------------------------------------------------- |
| `text-md/tight`                              | `text-md leading-[18px]`（`/tight` = 18px）           |
| `text-base/body`                             | `text-base leading-[23px]`（`/body` = 23px）          |
| `h-band`                                     | `h-11`（44）                                          |
| `px-5` `gap-5` 等 `-5`                       | `-[24px]`（Paper 的 5 = 24，不是 20）                 |
| `-6`                                         | `-[32px]`（Paper 的 6 = 32）                          |
| `bg-foreground/scrim`                        | `bg-scrim`                                            |
| `[color:var(--color-primary-foreground)]`    | `text-primary-foreground`                             |
| `border-t border-t-solid border-t-border`    | `border-t border-border`                              |
| `flex`（横向）                               | `flex-row`（nsh 默认纵向）                            |
| `flex flex-col`                              | 不写（默认）                                          |
| `grow basis-[0%]`                            | `grow basis-0`                                        |
| `font-sans` `antialiased` `inline-block`     | 不写                                                  |
| 状态栏帧、Home indicator 帧                  | 不画：`Page` 已留安全区                               |
| `<svg>` Phosphor 图标                        | `<Icon name=…>`，缺的把 path 加进 `src/ui/icons.ts`   |
| 头像 `<svg viewBox="0 0 100 100">`           | `<AgentAvatar id={agent.id} size={20} />`             |

## 约定

- 数据只走 wire，和 Web 一样：`src/wire/target.ts` 的 `useTarget`（订阅）、`eager`（`hello` 带的）、
  `call`（`target.action`）。列表在 `src/app/lists.ts`。类型来自 `@eta/client-contracts`，
  **动手前读 `docs/architecture/` 和 `apps/web/src` 里同一功能的实现**，语义和 Web 保持一致，不要发明 op。
- 所有文案走 `t("feature.key")`，中英成对写在 `src/features/<feature>/i18n.ts`。
- 只用主题颜色（`theme.json`）：`text-foreground`、`text-muted-foreground`、`text-faint`、`bg-muted`、
  `bg-surface`、`border-border`、`border-border-strong`、`bg-primary`、`text-state-error`…，深色自动切换。
- 直角。动效直接、不拖尾。列表行要有按压反馈（`active:bg-muted` 或 `active:opacity-60`）。
- 组件在 `src/ui/`：`Page` `Header` `SectionLabel` `Body` `Button` `Segmented` `Sheet` `ConfirmSheet`
  `Empty` `Loading` `Failed` `Icon` `AgentAvatar` `toast`，时间格式在 `ui/format.ts`。优先复用，能共用的放进 `src/ui/`。
- 页面之间跳转用 `src/nav/links.tsx` 的 `go.*`；feature 内部的页面用 `nav/stack.ts` 的 `open(key, page)`。
- 操作失败用 `toast(t("common.failed", { message: reason(error) }))`；host 没挂载的插件，入口隐藏（`wire().isMounted`）。
- nsh 的反应式：组件函数只跑一次；用 `signal`/`computed`，JSX 里读 `x()`；列表用 `<Each of=…>{(item) => …item()…}</Each>`
  或 `<List>`，条件用 `<If when=… else=…>`。解构 props 会丢响应，别解构。
- 文档：`https://nsh.dev/docs/<page>.md`，类型声明在 `.nsh/types/nsh/`。文本截断用 class `truncate` / `line-clamp-2`。
  `nsh.json` 里没有的 Tailwind 字号不要写；类名检查的 warning 也要处理干净。

## 假 host

`src/testing/fake-host.ts` 在 app 自己的 VM 里说同样的帧：`DevApp.tsx` 用它在模拟器和 `nsh test` 里跑，不需要网络。
数据和 op 写在 `src/testing/fixtures/<feature>.ts`，数据用设计稿里的（阿澈、Mori、小满、#128…）。
类型由 contracts 约束，op 的回答方式要和 `apps/eta` 一致。`host.scenario`（storage 的 `eta.fake.scenario`）切变体。

测试写在 `src/features/<feature>/*.test.tsx`：

```tsx
import { expect, open, test } from "nsh/test";

test("答完一个问题", async () => {
  const app = await open("../../../DevApp.tsx");
  await app.press("先备份再跑");
  expect(app.texts()).not.toContain("迁移脚本要直接在生产库上跑吗？");
});
```

## 命令

```sh
nsh check                 # 类型检查
nsh test                  # 无头测试
nsh package DevApp.tsx --target ios-simulator --run   # 模拟器（假 host）
nsh package App.tsx --target ios-simulator --run      # 模拟器（真 host）
xcrun simctl io booted screenshot /tmp/x.png          # 截图
```
