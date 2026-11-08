# TUI

`apps/tui` 是 eta 的终端界面，命令名 `eta`。它是一个独立程序，和网页一样只经 host 的一条 WebSocket（`/ws`，见[线协议](wire-protocol.md)）读写，不碰 `~/.eta`；唯一的例外是读 `eta-host running` 指明的令牌文件（见〈选哪个 host〉）。界面用 React 19 加 Ink 8 画在终端的备用屏幕上（和 vim、htop 一样占满窗口，退出后恢复原来的终端内容）。

准则：不照搬桌面端。一次只展示一件事，别的按需调出、用完收起；桌面端负责齐全。

## 组成

```text
apps/tui/
  src/main.tsx          入口：参数、读设定、建控制器、render、退出与崩溃处理
  src/config/           设定文件与状态文件：路径、默认值、逐键校验、写入
  src/connection/       连接层：wire、找 eta-host、临时 host、装服务、探测、控制器
  src/extensions/       扩展的类型、注册表、斜杠命令的解析与执行、给扩展用的 React 接口
  src/ext/              功能模块，一个文件（或目录）一个功能；/help、/config、/install-service 在这里
  src/i18n/             语言选择与消息目录
  src/ui/               各阶段画面、外壳（主区域、状态区、标签栏）、首页与开场图案、编辑器；`run-interface.ts` 把界面接到进程上（信号、异常、`exit` 兜底、交给终端的子程序）
  scripts/              gen-extensions、gen-docs、build-binaries
```

界面只读控制器的状态、调控制器的动作；找 host、起停进程、写设定都在 `src/connection/` 里，界面不直接碰。`src/connection/` 不产出给人看的文字，只交结构化的结果，文字全在界面这边翻译。

## 连接

### 选哪个 host

设定里有 `connection` 就照它连，不再问。没有时首次启动给三个选项，选定后写进设定：

1. **连接常驻 host**：输入地址。启动时预填一个地址：找得到 `eta-host` 时先问 `eta-host running`，它指出了正在跑的 host 就预填那个地址；没指出、问不出结果或找不到 `eta-host` 时，探本机 `http://127.0.0.1:8787/up`，通了就预填这个地址。两件事同时做。地址要令牌时（`GET /ws` 回 401）再让用户贴令牌。
2. **临时 host**：在本机起 `eta-host`，和 TUI 同生共死，照桌面端的本机模式。
3. **装常驻 host**：跑 `eta-host install-service`，等本机 `/up` 通了再连。

`eta-host` 依次在这些地方找：环境变量 `ETA_HOST_BIN`、`PATH`、`~/.eta/bin/eta-host`（Windows 为 `%USERPROFILE%\.eta\bin\eta-host.exe`）。`ETA_HOST_BIN` 设了就只认它，指向的文件不存在也不往下找。都找不到时告诉用户怎么装，不替用户下载。

两个 host 不能同时用同一个 `~/.eta`，而桌面端的 host 在 `~/.eta/desktop/host/` 下用空闲端口跑，探 8787 找不到它。所以每次要在本机起 host 之前（首次启动选临时 host 或装常驻 host、设定为临时 host 的启动、断线菜单里的「改用临时 host」、`/install-service` 移交时装服务和装不上后重起临时 host），TUI 先跑 `eta-host running`（`apps/eta/src/running.ts`），和桌面端一样。它读 `~/.eta/running-host.json`（进程要活着、`/up` 要回应），再查本机的系统服务，打印一行 JSON：`{ address, tokenFile, from }` 或 `null`。TUI 取输出的最后一个非空行，不看 `from`：现行的 `eta-host` 每次启动都写这份记录，系统服务启动的也写，所以 `from` 分不出桌面端的 host 与系统服务。

- 指出了一个 host：不起新的，画面说「这台电脑上已经有一个 host 在跑」并给出地址，选项是「连接它」与「返回」。`tokenFile` 有值时 TUI 读出令牌，「连接它」直接带着令牌检查并连接；读不到就预填地址，让用户贴令牌。连接时和「连接常驻 host」一样把地址（和令牌）存进设定。桌面端的 host 用空闲端口，下次启动端口变了，由〈断线与连不上〉里的回查接上。「返回」回到引出这一步的选项：首次启动的三个选项或断线菜单；设定为临时 host 的启动和 `/install-service` 移交没有可回的选项，回首次启动的三个选项，不再重起临时 host。
- `null`：照原流程起 host。
- 跑不起来、非零退出、10 秒内没有回答（到期硬杀）、输出不是这种 JSON：当作问不出结果，照原流程起 host。

`running` 是 `eta-host` 2026-11-08（#491）加的子命令。更早的版本把 `running` 当成运行参数，严格模式的参数解析（`parseArgs` 的 `strict: true`，不收位置参数）拒绝它，以非零退出、不起 host，所以 TUI 不先查 `eta-host --version`。

TUI 名下正在停止的临时 host（被新动作取代、还没退出）若被 `running` 指出，TUI 认得它的地址，不当成别的 host。

### 临时 host

子进程跑 `eta-host --port 0`，端口从 host 启动时打印的一行 JSON 摘要里取（`apps/eta/src/main.ts`）。stdout 与 stderr 一直读到进程结束，留最近 200 行，起不来或半路退出时显示给用户。

停止时让 host 走自己的收尾：POSIX 上发 SIGTERM；Windows 没有 SIGTERM，TUI 启动子进程时设 `ETA_STOP_PIPE` 为一个命名管道，停止时往管道写一行（`apps/eta/src/stop.ts`）。10 秒内没退就硬杀。TUI 正常退出、收到 SIGINT、SIGTERM、SIGHUP、崩溃（未捕获的异常、未处理的 rejection、组件渲染时抛错）时都先停临时 host（有期限，到期硬杀）、离开备用屏幕，再退出；正在启动、正在停止、被新动作取代的临时 host 也算在内。进程 `exit` 事件里还有一道同步硬杀兜底。临时 host 不在 eta 的进程组（POSIX 上以新会话启动）或控制台（Windows 上有自己隐藏的控制台）里，终端的 Ctrl+C 和关终端的 SIGHUP 到不了它，它只经 eta 的停止路径停下；所以把终端交给编辑器期间，Ctrl+C 交给编辑器处理，eta 和临时 host 都不受影响。eta 退出或崩溃时，正占着终端的编辑器等子程序会被结束。代价是 eta 被硬杀（SIGKILL、任务管理器结束、Windows 关窗后 eta 没在约 5 秒内停完）时临时 host 会留下来。

用临时 host 时状态区常驻一行黄字，提示 `/install-service`。这条命令把临时 host 移交给常驻服务：先用 `upgrade.check` 的 `busy` 列出会被中断的回复、任务、定时任务并要求确认，再停临时 host、跑 `eta-host running`（见〈选哪个 host〉，这时问的是停掉自己的临时 host 之后还有没有别的 host）、跑 `install-service`、等 `/up`、重连，并把设定改成连接常驻 host。装不上时报出 `install-service` 的输出与退路（自己在另一个终端或 tmux 里跑 `eta-host`，再选连接常驻 host），用户看过后重新起临时 host（起之前同样先问 `eta-host running`），免得停在没有 host 的状态。

### 令牌

依次取：用户这一次在界面里输入的令牌、环境变量 `ETA_TOKEN`、设定里的 `connection.token`。以 `Authorization: Bearer <令牌>` 带在 WebSocket 握手上（`apps/eta/src/access.ts`）。用户输入的排最前，是因为 `ETA_TOKEN` 错了时，用户在「更改地址」里贴的新令牌要能生效。

### 断线与连不上

连接层照 `apps/web/src/lib/wire.ts` 改写：hello 之后才算连上；断线后对仍在用的 target 重新订阅，等回复的调用一律失败、不重放。

- 连的是本机的常驻 host（地址是 `localhost`、`127.x.x.x` 或 `[::1]`，不是临时 host）时，第一次尝试失败或断线后，进遮罩之前先跑一次 `eta-host running`（期限与坏输出的处理同〈选哪个 host〉）。它指出了一个**不同地址**的 host，就直接连那个：这一次不改写设定，`tokenFile` 有值就读出令牌来用（同样不写设定，读不到就不带令牌，host 要令牌时走下面的令牌无效流程），状态区一行黄字「设定里的地址连不上，已连到本机正在运行的 host（地址）」。没指出、指出的是同一个地址、问不出结果、找不到 `eta-host`，或者问的期间原地址又连上了，就照下一条重连。这样桌面端换了端口、服务改了端口，TUI 都能自己接上。
- 连不上或断线：整屏遮罩「Reconnecting」，自动重连，间隔从 0.5 秒起翻倍、封顶 5 秒。
- 15 秒仍连不上（从第一次尝试或断线时起算，尝试挂住没有回应也算）：停止重试，给三个选项：改用临时 host（只这一次，不写设定）、更改地址、退出。
- 每次尝试失败后探一次 `GET /ws`，回 401 就判令牌无效，停止重试，进「更改地址」表单。

### 版本检查

host 的版本号只在 `upgrade.check` 的回复里（`version`）。TUI 进程启动后第一次连上时调一次，和自己构建时记下的版本比，不一致就在状态区黄字提示，不拒绝。任一方是 `dev`（源码运行）就不比，TUI 是 `dev` 时干脆不调。重连、换 host 都不再调：`upgrade.check` 每次都会去问 GitHub Releases，未登录一小时只有 60 次额度。

不用 `/version`：它回的是网页包的构建 id（`apps/web` 构建时的时间戳），不是 host 的版本号。

功能用到的 op 不在 `hello.ops` 里时，那个功能报「host 版本太旧」，其余照常。斜杠命令在 `requiredOps` 里声明，执行前检查。

## 设定文件

| 文件             | 位置                                                                                                                    | 谁写                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `tui.json`       | `$XDG_CONFIG_HOME/eta/`，没有时 `~/.config/eta/`；Windows 为 `%APPDATA%\eta\`；环境变量 `ETA_TUI_CONFIG` 可改成任意路径 | 用户；首次启动写入连接   |
| `tui-state.json` | 和 `tui.json` 同一目录                                                                                                  | TUI 自己（打开的标签等） |

两个文件分开，TUI 记状态时就不会改写用户手写的设定。写入都是先写临时文件再改名；POSIX 上文件是 0600、新建的目录是 0700，因为 `tui.json` 里可能有令牌。

`tui.json` 是声明式覆盖：写了的键盖掉默认值，没写的用默认值。坏掉的键（类型不对、值不合法、不认识的键）启动时列出文件、键与原因，那个键用默认值，其余照常；JSON 本身坏了就全部用默认值。`/config` 用编辑器打开这个文件，保存后重新载入并立即生效，`connection` 的改动下次启动生效。

下面的例子用注释说明每个键；真正的 `tui.json` 是普通 JSON，不能写注释。

```jsonc
{
  "locale": "zh", // "zh" 或 "en"；不写时按 LC_ALL、LC_MESSAGES、LANG 选，认不出用英文
  "connection": {
    "mode": "resident",
    "url": "http://127.0.0.1:8787",
    "token": "…"
  }, // 或 { "mode": "temporary" }
  "ssh": { "target": "me@server" }, // 远程时经 ssh -t 打开 host 机器上的文件
  "theme": { "accent": "cyan", "brand": "#e6e6e6" }, // 颜色令牌
  "keybindings": { "tabs.next": ["alt+right", "ctrl+n"] }, // 动作名到键位，空数组表示不绑
  "layout": { "tabBar": "bottom" }, // 或 "top"
  "toolOutput": { "previewLines": 5 } // 长工具输出默认显示几行
}
```

颜色令牌：`brand`、`brandDim`（开场图案渐变的两端）、`text`、`muted`、`accent`、`warning`、`error`、`success`、`border`、`selection`。值可以是 `default`（终端前景色）、16 色名（含 `Bright` 后缀与 `gray`）、`#rgb`、`#rrggbb`。默认只用 16 色和 `default`，跟着用户的终端主题走。

键位写成 `ctrl+alt+shift+键`，键是一个字符或 `left`、`right`、`up`、`down`、`escape`、`enter`、`tab`、`backspace`、`delete`、`pageup`、`pagedown`、`home`、`end`、`space`。动作与默认键位：

| 动作                         | 默认                           |
| ---------------------------- | ------------------------------ |
| `tabs.previous`、`tabs.next` | `alt+left`、`alt+right`        |
| `tabs.goTo1` … `tabs.goTo9`  | `alt+1` … `alt+9`              |
| `panel.open`                 | `left`（只在输入框为空时有效） |
| `review.open`                | `alt+r`                        |
| `tabs.close`                 | `alt+w`（关标签，不影响对话）  |
| `reply.stop`                 | `escape`（有回复在跑时）       |
| `app.quit`                   | `ctrl+c`，2 秒内连按两次才退出 |

## 画面

- **主区域**：活跃标签对应的画面；没有打开的标签时是首页：开场图案、版本、连的 host、上手提示，以及一行命令输入。窄终端退成一行文字。
- **状态区**：一行。最新的通知、连接地址、临时 host 黄字、版本提示；放不下就截断。
- **标签栏**：一行，默认在最底下。每个打开的标签显示编号、名字与状态标记；扩展注册的固定标签靠右。打开的标签记在 `tui-state.json`，下次启动还在。
- **层**：命令开的小窗盖在主区域上，可以叠，最上面那层收按键，用完关掉。

## 扩展：加命令、加画面

一个功能是 `src/ext/` 下的一个模块（`<名字>.ts(x)` 或 `<名字>/index.ts(x)`），默认导出一个 `Extension`（`src/extensions/types.ts`）。`scripts/gen-extensions.ts` 扫描这个目录，写出被 git 忽略的 `src/extensions.gen.ts`；`build`、`dev`、`test`、`typecheck`、`build:binaries` 都先跑它，`bun run --cwd apps/tui gen` 单独跑。所以加功能只加文件，不改已有文件。注册表在启动时检查扩展 id、命令名、标签页 kind、固定标签 id 不重复，重复就启动失败。

`Extension` 可以带：

- `commands`：斜杠命令（`SlashCommand`）。名字和参数名只用英文，没有别名，补全按英文前缀；`summary`、参数说明、例子说明中英各一。`requiredOps` 列出它调的 op。`run(ctx, argText)` 里的 `ctx` 是 `ShellContext`：开层、在状态区提示、开关标签、用编辑器打开文件、把终端交给交互程序（`ssh -t`）、重新载入设定、退出。
- `views`：一种标签页（`TabView`）。`kind` 是它画的东西的种类（例如对话），`Component` 画主区域，`useTitle`、`useStatus` 是给标签栏用的 hook。用 `ctx.openTab({ kind, id })` 打开。
- `pinnedTabs`：标签栏右端的固定标签。选中它（`ctx.selectPinnedTab(id?)`，不给 id 时是最右边那个）时调它的 `onSelect(ctx)`。
- `Background`：外壳显示期间常驻挂载、不占画面的组件，用来放在外壳任何画面上都有效的键（`useAction`），例如批阅模式。被层盖住、在重连遮罩后面时它的键不触发；外壳收起时卸载。
- `messages`：这个功能的消息目录。
- `onConnected(ctx, first)`：每次连上（hello）后调用，`first` 表示本进程第一次。

画面里用的 React 接口：`useShell()`、`useConfig()`、`useTheme()`（颜色交给 Ink 前过一次 `inkColor`）、`useRegistry()`（`src/extensions/react.ts`）；`useMessages(catalog)`、`useLocale()`（`src/i18n/react.ts`）；按动作名绑键用 `useAction(action, handler, { isActive })`，自己用 Ink 的 `useInput` 时把 `useInputActive()` 放进 `isActive`，这样被层或重连遮罩盖住时不会收到按键；层的外观用 `LayerFrame`。层属于外壳：一次外壳从一个连接的第一次尝试起，到这个连接被放弃、令牌被拒、临时 host 退出或换 host 为止；外壳收起时所有层一起关掉。`ShellContext` 也按外壳分开，外壳收起之后再经同一个上下文开层什么都不会开，不会盖到下一次外壳上；`onConnected` 里在外壳画出来之前开的层，外壳出现时显示。层回调、按键处理、画面里发起的异步动作用 `ctx.reportFailure(promise)` 包起来，失败时报到状态区，而不是变成未处理的 rejection 让程序崩溃。

输入框为空时按 `left` 打开最右边的固定标签（`panel.open`）由输入框自己绑：`useAction("panel.open", () => ctx.selectPinnedTab(), { isActive: 值为空且这个画面在前面 })`。首页的命令输入就是这样做的，对话画面的输入框照做。切走的标签会被卸载，滚动位置这类要保留的状态放进功能自己的 store。

加了或改了命令后跑 `bun run --cwd apps/tui docs`，重新生成命令文档；不跑的话测试会红。

### 界面文字

界面文字中英两套都要完整。每个功能的文字放在自己的消息目录里，用 `defineMessages({ en: {...}, zh: {...} })` 声明并导出；两种语言的键必须完全相同，少一个键类型检查就失败。占位写 `{name}`，两种语言用同样的占位。测试 `catalog-parity` 遍历所有导出的目录、每个扩展的 `messages` 和每条命令的说明，检查键一一对应、占位相同、没有空串，所以**加文字时中英两边都要加**。产品名、命令名、代码保留原文。React 之外（命令的 `run` 里）用 `translatorFor(catalog, ctx.locale)` 与 `localize(text, ctx.locale)`。

## 编辑器

`ctx.editFile(path)` 用 Ink 的 `suspendTerminal` 挂起界面、交还终端，子进程用继承的 stdio 跑，退出后恢复并重画。编辑器取 `$VISUAL`，其次 `$EDITOR`，都没设时 Windows 用 `notepad`、其他用 `vi`；值可以带参数（`code --wait`）。Windows 上 `.cmd`、`.bat` 经 `cmd.exe` 启动。`ctx.runInteractive(command, args)` 走同一条路。

## 命令

命令文档由注册表生成：[英文](../tui/commands.md)、[中文](../tui/commands.zh.md)。地基自带 `/help`、`/config`、`/install-service`。

## 构建

`bun run --cwd apps/tui build:binaries` 交叉编译出 `apps/tui/out/eta-linux-x64`、`eta-darwin-arm64`、`eta-windows-x64.exe`。版本号写进程序（`eta --version` 打印 `eta <版本>`），依次取环境变量 `ETA_TUI_VERSION`、`ETA_DAEMON_VERSION`，都没有时是 `dev`。脚本用 `Bun.build` 的 compile，并把 Ink 的可选依赖 `react-devtools-core` 换成空模块：直接 `bun build --compile --external` 编出的程序一启动就因为找不到它而退出。

开发时 `bun run --cwd apps/tui dev` 从源码运行。

## 安装与分发

安装脚本同时装 `eta` 与 `eta-host`，这一节随发布流程补全。
