# 工具调用规则与用户确认

本文说明 agent 的 shell 命令和文件修改在执行前怎样按规则检查，以及需要用户确认时怎样通过 MCP elicitation 问用户。关联 [#19](https://github.com/AkaraChen/axp/issues/19)。

规则写在一份 YAML 里（`apps/agent-runtime/hooks/akhook.yml`）。命中后：

- **拒绝**：把原因和替代做法告诉 agent。例如 `gh pr create` 被拒，提示改用 `open_pull_request`。
- **请用户确认**：先拒绝，agent 调用 `request_approval` 工具，在 AXP 里弹出确认卡片；用户同意后，agent 原样重新执行，这一次放行。例如推送 `main`。

维护时只改规则文件。代码只负责“怎么匹配”和“怎么问用户”，与具体规则无关。

## 能防什么，不能防什么

hook 在容器里运行，而容器对 agent 完全开放：agent 可以把命令写进脚本、编码后执行，也可以改掉规则或伪造授权。因此 hook 是**防止 agent 误操作的护栏**，不是安全边界。绝对不允许的事只能靠凭据：容器里的凭据没有某个权限，就做不了那件事（#19）。

## 组成

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| akhook | `vendor/akhook`（submodule），镜像里是 `/usr/local/bin/akhook` | 规则引擎。Codex 的受管 `PreToolUse` hook（`/etc/codex/requirements.toml`，匹配 `Bash` 与 `apply_patch`）在每次执行前调用它 |
| 规则 | `apps/agent-runtime/hooks/akhook.yml` → `/etc/akhook/akhook.yml` | 镜像通过 `AKHOOK_ADDITIONAL_CONFIG_PATH` 加载。工作区仓库自带的 `.akhook.yml` 可以追加规则，但关不掉、也替换不了这些规则 |
| `push-target` | `apps/agent-runtime/hooks/push-target` → `/etc/akhook/push-target` | 推送规则的 `decide` 脚本，判断这次 `git push` 是否到达受保护分支 |
| `approval` 插件 | `apps/agent-runtime/plugins/approval` | MCP 工具 `request_approval`：读出请求，用 elicitation 问用户，同意后授权 |
| runtime / 控制面 | `runtime.py`、`projection.py` | 把“只需确认”的 elicitation 当作审批，复用现有的确认卡片 |

镜像构建时，akhook 由 `rust` 构建阶段从 submodule 编译（`scripts/build/image.sh` 以 `akhook-src` 构建上下文传入，submodule 缺失时先初始化）。镜像里还装了 `gh`。

## 规则

| 规则 | 动作 | 内容 |
| --- | --- | --- |
| `gh-pr-create` | 拒绝 | `gh pr create`：PR 要以 AXP 的身份打开 |
| `gh-write` | 拒绝 | `gh` 的写命令（`pr`/`issue` 的 merge、close、comment 等，`repo create` 等），`gh api` 的非 GET 方法和 GraphQL mutation |
| `push-protected-branch` | 由 `push-target` 决定 | 推送默认分支、`main`、`master`，或 `--all`/`--mirror` 时请用户确认 |
| `akhook-approval` | 拒绝 | agent 自己执行 `akhook approval grant` |

`argv` 条件按解析后的命令匹配：`cd x && gh -R a/b pr 'create'`、`bash -c '…'`、`$(…)` 都能命中，`echo gh pr create` 不会。由于参数只需按顺序出现，`gh issue list --search close` 这类命令也会被 `gh-write` 误拦；遇到时再收窄规则。依赖 `-f` 隐式变成 POST 的 `gh api` 写入不在规则里，交给凭据。

`push-target` 不访问网络，按 git 自己的规则算出目标分支：显式 refspec（含 `HEAD`、`src:dst`、`:dst` 删除、`--delete`），没写 refspec 时取 `@{push}`（遵循 `push.default`、上游和 `pushRemote`），会跟随前面的 `cd` 和 `git -C`。默认分支取自 `refs/remotes/<remote>/HEAD`。命令无法解析时请用户确认，不猜测。

## 用户确认

Codex 的 hook 只能同步地允许或拒绝；它能解析 `ask`，但会照样执行工具。elicitation 只能由 MCP server 发起。所以拆成两步，中间由 agent 调用工具衔接：

```
agent 执行 git push origin main
  └─ PreToolUse → akhook：push-protected-branch 命中，push-target 答 ask
       ├─ 写入 /run/akhook/requests/<id>.json（规则、提示、命令、cwd）
       └─ 拒绝：规则提示 + ask_instruction（带上 request_id）
agent 用 tool_search 找到并调用 request_approval(<id>)
  ├─ akhook approval show <id>
  └─ elicitation/create（form，没有字段；正文是规则提示和原命令）
       └─ Codex → runtime（mcpServer/elicitation/request）→ 控制面 → 确认卡片
用户点“允许”
  └─ akhook approval grant <id>：一次性授权，10 分钟内有效
agent 原样重新执行 git push origin main
  └─ akhook：找到授权 → 删除授权并放行
```

- 授权只对完全相同的调用有效（同样的规则、cwd 和命令），只能用一次。agent 换一条命令就要重新确认。
- 状态是 `/run/akhook` 下的文件，不在 `/agent` 里，所以不进快照；实例换代后一并消失。akhook 每次处理 `ask` 时顺带删掉过期的授权和超过一天的请求。
- `request_approval` 的 `tool_timeout_sec` 是一天：工具调用会一直等到用户回答。turn 被停止时 runtime 以 `cancel` 回答 elicitation，工具返回“用户没有确认”。

## elicitation 在 runtime 和控制面

- **runtime**：`mcpServer/elicitation/request` 中，`mode` 为 `form` 且 `requestedSchema` 没有字段的，按审批处理：`kind = elicitation`，摘要是 `{server, message}`，等待和取消与命令审批相同。用户同意时回答 `{action: accept, content: {}}`，拒绝时回答 `decline`，取消时回答 `cancel`。其他 elicitation（有字段的表单、URL 模式）仍然直接回答 `decline`。
- **控制面**：`approval.kind` 增加 `elicitation`，确认卡片的提示就是 MCP server 给出的 message（最多 500 字），选项仍是“允许 / 拒绝”。前端无需改动。

以后其他插件也可以用 elicitation 请用户确认：只要请求一个没有字段的表单即可。需要用户填写内容的表单要等前端支持后再开放。

## 验证

- `apps/agent-runtime/tests/test_hooks.py`：`push-target` 的各种推送写法；用 akhook 跑规则文件（需要先构建 `vendor/akhook`，否则跳过）；`approval` 插件经 MCP 内存客户端完成 elicitation 与授权。
- `test_runtime.py`：确认类 elicitation 走审批、拒绝、带字段的表单被直接拒绝。`test_control.py`：确认卡片的提示与送达的决定。
- 用真实的 Codex（0.160.1）在镜像里按上图完整跑通过一次：受管 hook 拦下推送，拒绝理由原样交给模型，模型经 `tool_search` 调用 `request_approval`，`on-request` 策略下 Codex 把 elicitation 转给客户端，同意后重试的推送成功。

## 为什么不用 Codex 自带的 execpolicy

Codex 的 `.rules`（`prefix_rule(..., decision="prompt")`）也能让命令走审批，但它只能按参数前缀匹配，也不能运行脚本看当前分支，没法表达“推送到受保护分支”，规则也会分成两套格式。akhook 一份规则文件覆盖 shell 命令和文件修改，确认统一走 elicitation，前端只有一种确认卡片。
