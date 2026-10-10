# 工具调用规则

本文说明 agent 的 shell 命令和文件修改在执行前怎样按规则检查。关联 [#19](https://github.com/AkaraChen/axp/issues/19)。

规则写在一份 YAML 里（`apps/agent-runtime/hooks/akhook.yml`）。命中后**拒绝**：把原因和替代做法告诉 agent。例如 `gh pr create` 被拒，提示改用 `open_pull_request`（见[代码托管](forge.md)）。Codex 以 `never` 审批运行（见[聊天与运行时架构](chat-runtime.md#runtime)），没有请用户确认的流程：工作区自带的 `ask` 规则同样只会拦下命令。

维护时只改规则文件。代码只负责“怎么匹配”，与具体规则无关。规则对每个 agent 都生效，不随它的环境包变化。

## 能防什么，不能防什么

hook 在容器里运行，而容器对 agent 完全开放：agent 可以把命令写进脚本、编码后执行，也可以改掉规则或伪造授权。因此 hook 是**防止 agent 误操作的护栏**，不是安全边界。镜像自带的规则只把 agent 引导到更好的工具，不限制外部服务：凭据有什么权限，agent 就能做什么（见[代码托管](forge.md)）。

## 组成

| 部分   | 位置                                                             | 作用                                                                                                                                                                                           |
| ------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| akhook | `vendor/akhook`（submodule），镜像里是 `/usr/local/bin/akhook`   | 规则引擎。Codex 的受管 hook（`/etc/codex/requirements.toml`）：`PreToolUse` 不设 matcher，每次工具调用前调用它；`UserPromptSubmit` 和 `Stop` 运行插件的生命周期规则（[插件](plugins.md#hook)） |
| 规则   | `apps/agent-runtime/hooks/akhook.yml` → `/etc/akhook/akhook.yml` | 镜像通过 `AKHOOK_ADDITIONAL_CONFIG_PATH` 加载。工作区仓库自带的 `.akhook.yml` 可以追加规则，但关不掉、也替换不了这些规则                                                                       |

镜像构建时，akhook 由 `rust` 构建阶段从 submodule 编译（`scripts/build/image.sh` 以 `akhook-src` 构建上下文传入，submodule 缺失时先初始化）。镜像里还装了 `gh`。

## 规则

| 规则              | 动作 | 内容                                                            |
| ----------------- | ---- | --------------------------------------------------------------- |
| `gh-pr-create`    | 拒绝 | `gh pr create`：改用 `open_pull_request`                        |
| `akhook-approval` | 拒绝 | agent 自己执行 `akhook approval grant`，绕过工作区的 `ask` 规则 |

## 验证

`packages/plugins-go` 的测试用 akhook 跑插件的生命周期规则（依赖 `@axp/akhook#build`，`scripts/build/akhook.sh` 从 `vendor/akhook` 编译到 `packages/akhook/out/akhook`；本地没有 Rust 时跳过，`CI=1` 时找不到 akhook 直接失败）。

## 为什么不用 Codex 自带的 execpolicy

Codex 的 `.rules` 只能按参数前缀匹配，也不能运行脚本看当前分支，没法表达“推送到受保护分支”，规则也会分成两套格式。akhook 一份规则文件覆盖 shell 命令和文件修改，聊天智能体和定时任务用同一套。
