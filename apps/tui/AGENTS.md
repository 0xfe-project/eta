# 终端界面（apps/tui）

`eta` 命令：React 19 加 Ink 8 画在终端备用屏幕上的 host 客户端。组成、连接、设定文件、画面与扩展接口见 [`docs/architecture/tui.md`](../../docs/architecture/tui.md)，命令见 [`docs/tui/commands.md`](../../docs/tui/commands.md)。

准则：**不照搬桌面端**。一次只展示一件事，别的按需调出、用完收起；齐全是桌面端的事。打扰不超过桌面端：不自动弹层、不响铃、不发终端通知。

## 约定

- 数据只走 wire，和 Web 一样：`src/connection/wire.ts` 的那一条 WebSocket，订阅 target、调 `target.action`。类型来自 `@eta/client-contracts`，**动手前读 `docs/architecture/` 和 `apps/web/src` 里同一功能的实现**，语义保持一致，不要发明 op。host 缺接口时去改 host，不在 TUI 里绕。
- 不碰 `~/.eta`。找 host、起停进程、写设定都在 `src/connection/`，它只交结构化结果，不产出给人看的文字；界面只读控制器的状态、调它的动作。
- 加功能只加文件：`src/ext/` 下一个模块默认导出一个 `Extension`，`scripts/gen-extensions.ts` 生成注册表，不改已有文件。
- 命令名和参数名只用英文，没有别名。加了或改了命令跑 `bun run --cwd apps/tui docs` 重新生成命令文档，否则测试会红。
- 界面文字用 `defineMessages({ en, zh })`，中英两套键一一对应、占位相同；`catalog-parity` 测试守着。产品名、命令名、代码保留原文。
- 自己用 Ink 的 `useInput` 时把 `useInputActive()` 放进 `isActive`；按动作名绑键用 `useAction`，键位在设定里可改，不写死。
- 层回调、按键处理、画面里发起的异步动作用 `ctx.reportFailure(promise)` 包起来，失败报到状态区，不让未处理的 rejection 弄崩程序。
- 颜色只用主题（`useTheme()`，交给 Ink 前过 `inkColor`），不写死色码。

## 测试

- 连接层与命令对**真实 host** 测：`test/support/host.ts` 在临时目录的空闲端口上起进程内 host。核心路径不对替身测。
- 界面用 Ink 的测试渲染断言画面文字与按键行为，辅助在 `test/ui-support/`。
- 一律用临时目录（`test/support/temp.ts`），不碰真实的 `~/.eta`；测试不对外网发请求，要用模型或登录端点就指向本地。

## 命令

```sh
bun run --cwd apps/tui dev             # 从源码运行
bun run --cwd apps/tui test
bun run --cwd apps/tui typecheck
bun run --cwd apps/tui docs            # 重新生成 docs/tui/commands*.md
bun run --cwd apps/tui build:binaries  # 交叉编译到 apps/tui/out/
```
