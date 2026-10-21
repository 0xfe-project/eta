# akhook 规则与流式规则

会话的行为规则是声明式的：配置文件就是 [akhook](https://github.com/aghub-app/akhook) 的 `.akhook.yml`（结构见它的 `docs/design.md`，这里一字不改地沿用），由 `packages/eta-plugin-akhook` 执行，再加一种 akhook 没有的规则：流式规则（`on: stream`，来自 oh-my-pi 的 TTSR）。

## 配置从哪来

合并顺序同 akhook：preset，用户级文件（`<配置目录>/akhook/akhook.yml`），项目文件（从会话的工作目录向上找最近的 `.akhook.yml`），然后是宿主的附加配置。同 ID 的后者覆盖前者，`disabled_rules` 在合并后关掉对应规则；附加配置的规则，用户级和项目文件关不掉也盖不掉，只有附加配置自己或更靠后的附加配置可以。

宿主自己带一层规则，排在最前，用户的与项目的文件关不掉也盖不掉：`eta:github`（`apps/eta/src/github/akhook.ts`），其中 `gh-pr-create` 拦下 `gh pr create`，提示改用 `open_pull_request` 工具（见 [GitHub](github.md)）。这一层属于 GitHub 那条链，所以只有 host 加载了它（`--github`，默认关）才注册：没加载时智能体手里只有 `gh`，提示它用一个不存在的工具反而是干扰。

宿主的附加配置有三处，按此顺序；之后还有智能体载入的[环境包](bundles.md)各自的一层（`akhook.yml`，规则 id 前缀是包名，规则的命令带上包的配置作为环境变量，只对载入它的智能体的会话有效）：环境变量 `AKHOOK_ADDITIONAL_CONFIG_PATH`（路径列表，文件不存在算配置错误）、数据目录里的 `akhook.yml`（有才读）、嵌入方传给 `startHost({ akhook: { additional } })` 的文本（环境包带的那份就走这里）。文件改了，下一次工具调用就生效，不用重开会话。

远端机器（daemon）上的会话在 daemon 那台机器上读用户级文件和项目的 `.akhook.yml`，再叠上主 node 的附加配置：主 node 在每次 `machine.open` 时把这些层以文本发过去，所以两边的规则一致。`prompt_submit` / `stop` 属于一次回复，由主 node 的引擎执行，所以对远端项目只有用户级和附加配置生效（主 node 读不到远端的项目目录）。

## 规则怎么执行

| `on`                                     | 在哪执行                                                   |
| ---------------------------------------- | ---------------------------------------------------------- |
| `file_change`、`shell_exec`、`tool_call` | session 的 `ToolMiddleware`（`before`）                    |
| `prompt_submit`、`stop`                  | 引擎的 `beforeRun` / `afterRun`；出错从不挡住智能体        |
| `stream`                                 | runner 的生成守卫（见下），软提醒走 `ToolMiddleware.after` |

- **工具调用**：`deny` 直接拦截，模型读到规则 ID 和 `message`；`ask` 走会话的 ask 通道，所以是待处理页里的一张卡片，不需要 akhook 给 Codex 用的一次性授权文件，也就没有 `ask_instruction` 的用武之地（字段照常解析，不起作用）；`decide` 运行外部命令决定。同一次调用里有 `deny` 就拒绝，否则有 `ask` 就问。配置读不出来、检查器出错、`ast` 推断不出语言时拒绝调用，不会放行。
- **eta 的工具**：每次调用都是 `tool_call` 候选；`bash`（参数 `command`）同时是 `shell_exec`，`shell_tools` 可以再加；`edit` / `write` 同时是 `file_change`，规则只看这次改动引入的内容：`regex` 看新增的行，`ast` 只算旧内容里本来没有的匹配。
- **匹配实现**：`argv` 用 tree-sitter-bash（wasm）把命令拆成简单命令（列表、管道、子 shell、命令替换、`sh -c`），`ast` 用 `@ast-grep/napi`（内置 js/ts/tsx，rust、go、python、bash、json、yaml 用 `@ast-grep/lang-*`）。`regex` 是 JavaScript 正则，开头的 `(?i)` `(?m)` `(?s)` 会翻译成标志。
- **审批名单与 `ask` 规则统一**：名单里的工具在同一个中间件里等于多一条 `ask` 命中，所以一次调用同时被规则和名单要求确认时只问一次，问句里带规则的话。名单仍是用户的设置（`inbox.setApprovals`），每次调用现读。daemon 的会话通过 `tool.gate` 问主 node 名单，也进同一个中间件（原来两边各一份的 `approvalMiddleware` 删掉了）。

## 流式规则（`on: stream`）

```yaml
rules:
  - id: no-fixme
    on: stream
    scope: [
      text,
      "tool:edit(*.ts)",
      "tool:write(*.ts)",
    ] # 默认 text 和所有工具，不含 thinking
    checks:
      - regex: "FIXME"
      - ast: {
          language: tsx,
          pattern: "const $A: any = $B",
        } # 只在工具调用完整后检查
    paths: ["src/**"] # 可选：文件路径的额外门槛
    interrupt_mode: always # always | prose-only | tool-only | never，默认 always
    repeat_mode: once # once | after-gap，默认 once
    repeat_gap: 10 # after-gap 时，间隔多少个已完成的 turn
    message: 规则正文，作为提醒
```

字段对应 omp 的 `condition`（`regex`）、`astCondition`（`ast`）、`scope`、`globs`（`paths`）、`interruptMode`、`repeatMode`、`repeatGap`。生成过程中对累计输出匹配，所以能跨流片段；`edit` / `write` 匹配的是它们写入的新内容，其他工具匹配参数的 JSON。

命中且需要中断时：这次生成停掉，已生成的部分丢弃，规则正文作为一条 user 消息注入，同一个 turn 里重新生成。`never`（以及 `prose-only` / `tool-only` 遇到另一类输出）是软提醒：工具照常执行，提醒附在它自己的工具结果后面（文本和 thinking 里命中的，附在下一个工具结果后面；这一轮没有工具结果就丢掉，不算触发）。

触发记录（哪条规则在第几个已完成的 turn 触发过，以及已完成的 turn 数）存在 session 的值存储里（`akhook.stream`），重开会话后接着算。

`presets: [omp]` 给出 omp 的 27 条规则，来源是 akhook 仓库里的拷贝（`presets/omp/*.md`，MIT），由 `bun run embed` 嵌进 `src/omp-preset.gen.ts`（daemon 是单文件，运行时读不到包目录）。akhook 把它们映射成执行前拒绝；这里它们是 `stream` 规则，保留 omp 原来的 `interruptMode: never`，也就是软提醒。

## kernel 的原语

`eta-core` 的 runner 新增“中断当前这一次生成、丢弃已生成的部分、注入消息、重新生成”：

- `RunnerOptions.guardGeneration` / `runner.addGenerationGuard(guard)`：每个流帧调用一次守卫，返回 `GenerationInterrupt { reason, source?, inject? }` 即中断。多个守卫按加入顺序问，第一个中断生效。每个 turn 最多接受 `maxInterrupts`（默认 8）次，之后不再问。
- 中断的实现：这次请求有自己的 `AbortSignal`（中断时只取消这一次请求，不影响 run 的 signal），丢弃部分输出，`inject` 的消息作为普通消息进 transcript 和 journal，然后重新组装上下文再生成；不占重试次数，也不新开 turn。
- 事件 `generation:interrupted`（`runId`、`turnId`、`reason`、`source`、第几次、丢弃的字符数和用量、注入了几条）。界面看到它要丢掉流式中的半条消息。
- journal 新增 `interrupt` 条目：谁、为什么、丢了多少；被丢弃的文本不会出现在 journal、transcript 或下一次请求里。它不是 transcript 消息，也没有对应的系统行。
