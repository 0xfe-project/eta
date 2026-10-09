# 工具调用规则与用户确认

本文说明 agent 的 shell 命令和文件修改在执行前怎样按规则检查，以及需要用户确认时怎样通过 MCP elicitation 问用户。关联 [#19](https://github.com/AkaraChen/axp/issues/19)。

规则写在一份 YAML 里（`apps/agent-runtime/hooks/akhook.yml`）。命中后：

- **拒绝**：把原因和替代做法告诉 agent。例如 `gh pr create` 被拒，提示改用 `open_pull_request`（见[代码托管](forge.md)）。
- **请用户确认**：先拒绝，agent 调用 `request_approval` 工具，在 AXP 里弹出确认卡片；用户同意后，agent 原样重新执行，这一次放行。

维护时只改规则文件。代码只负责“怎么匹配”和“怎么问用户”，与具体规则无关。

规则对每个 agent 都生效，不随它选择的插件变化。`approval` 是普通插件，可以在智能体编辑器里关掉；关掉后需要确认的操作会一直被拦，agent 只能告诉用户。

## 能防什么，不能防什么

hook 在容器里运行，而容器对 agent 完全开放：agent 可以把命令写进脚本、编码后执行，也可以改掉规则或伪造授权。因此 hook 是**防止 agent 误操作的护栏**，不是安全边界。镜像自带的规则只把 agent 引导到更好的工具、保护确认机制本身，不限制外部服务：凭据有什么权限，agent 就能做什么（见[代码托管](forge.md)）。

## 组成

| 部分             | 位置                                                             | 作用                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| akhook           | `vendor/akhook`（submodule），镜像里是 `/usr/local/bin/akhook`   | 规则引擎。Codex 的受管 hook（`/etc/codex/requirements.toml`）：`PreToolUse` 不设 matcher，每次工具调用前调用它；`UserPromptSubmit` 和 `Stop` 运行插件的生命周期规则（[插件](plugins.md#hook)） |
| 规则             | `apps/agent-runtime/hooks/akhook.yml` → `/etc/akhook/akhook.yml` | 镜像通过 `AKHOOK_ADDITIONAL_CONFIG_PATH` 加载。工作区仓库自带的 `.akhook.yml` 可以追加规则，但关不掉、也替换不了这些规则                                                                       |
| `approval` 插件  | `apps/agent-runtime/plugins/approval`                            | MCP 工具 `request_approval`：读出请求，用 elicitation 问用户，同意后授权                                                                                                                       |
| runtime / 控制面 | `runtime.py`、`projection.go`                                    | 把“只需确认”的 elicitation 当作审批，复用现有的确认卡片                                                                                                                                        |

镜像构建时，akhook 由 `rust` 构建阶段从 submodule 编译（`scripts/build/image.sh` 以 `akhook-src` 构建上下文传入，submodule 缺失时先初始化）。镜像里还装了 `gh`。

## 规则

| 规则              | 动作 | 内容                                     |
| ----------------- | ---- | ---------------------------------------- |
| `gh-pr-create`    | 拒绝 | `gh pr create`：改用 `open_pull_request` |
| `akhook-approval` | 拒绝 | agent 自己执行 `akhook approval grant`   |

## 用户确认

Codex 的 hook 只能同步地允许或拒绝；它能解析 `ask`，但会照样执行工具。elicitation 只能由 MCP server 发起。所以拆成两步，中间由 agent 调用工具衔接：

```
agent 执行一条命令
  └─ PreToolUse → akhook：一条 ask 规则命中
       ├─ 写入 /run/akhook/requests/<id>.json（规则、提示、命令、cwd）
       └─ 拒绝：规则提示 + ask_instruction（带上 request_id）
agent 用 tool_search 找到并调用 request_approval(<id>)
  ├─ akhook approval show <id>
  └─ elicitation/create（form，没有字段；正文是规则提示和原命令）
       └─ Codex → runtime（mcpServer/elicitation/request）→ 控制面 → 确认卡片
用户点“允许”
  └─ akhook approval grant <id>：一次性授权，10 分钟内有效
agent 原样重新执行这条命令
  └─ akhook：找到授权 → 删除授权并放行
```

- 授权只对完全相同的调用有效（同样的规则、cwd 和命令），只能用一次。agent 换一条命令就要重新确认。
- 状态是 `/run/akhook` 下的文件，不在 `/agent` 里，所以不进快照；实例换代后一并消失。akhook 每次处理 `ask` 时顺带删掉过期的授权和超过一天的请求。
- turn 被停止时 elicitation 以 `cancel` 结束，工具返回“用户没有确认”。

## elicitation 到用户

`request_approval` 发出的是一个没有字段的表单 elicitation，经 runtime 和控制面变成对话里（以及“确认”标签页里）的确认卡片，见[用户确认](user-attention.md)。

## 验证

- `apps/agent-runtime/tests/test_hooks.py`：用 akhook 跑规则文件（需要先构建 `vendor/akhook`，否则跳过）；`approval` 插件经 MCP 内存客户端完成 elicitation 与授权。
- 用真实的 Codex（0.160.1）在镜像里按上图完整跑通过一次：受管 hook 拦下命令，拒绝理由原样交给模型，模型经 `tool_search` 调用 `request_approval`，`on-request` 策略下 Codex 把 elicitation 转给客户端，同意后重试的命令成功。

## 为什么不用 Codex 自带的 execpolicy

Codex 的 `.rules`（`prefix_rule(..., decision="prompt")`）也能让命令走审批，但它只能按参数前缀匹配，也不能运行脚本看当前分支，没法表达“推送到受保护分支”，规则也会分成两套格式。akhook 一份规则文件覆盖 shell 命令和文件修改，确认统一走 elicitation，前端只有一种确认卡片。
