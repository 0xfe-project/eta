# 定时任务

本文说明 [#23](https://github.com/AkaraChen/axp/issues/23) 的实现：按计划运行的智能体。每次运行都在一个全新的 runtime 里完成，留下一份报告（或者什么都不发），并给下一次运行写一段交接说明。用户对报告的反馈会修订任务的要求。

## 数据

都在 PostgreSQL（`apps/control-plane/routines`）：

| 表                 | 内容                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| `routine`          | 名称、模型、计划（`schedule.py` 的四种形状）、时区、是否启用             |
| `routine_brief`    | 要求的各个版本；由反馈修订而来的版本指向那条反馈                         |
| `routine_run`      | 每次运行：状态（运行中、已发送、没有新内容、失败）、报告、交接说明、错误 |
| `routine_feedback` | 用户对某次运行的反馈；修订失败时标记 `revision_failed`                   |

“交接说明”是最近一次写了交接说明的运行的 `handoff`。

## 计划

计划在 NATS 里（[队列](queue.md)的 stream `ROUTINES`）：`axp.routine.<id>.schedule` 上的一条带 `Nats-Schedule`（六段 cron）和 `Nats-Schedule-Time-Zone` 的消息，到点由 NATS 发布到 `axp.routine.<id>.fire`。新建、改计划、启用时发布（替换），暂停、删除时清除；都在请求的事务里完成，失败则回滚（`503`）。controller 启动时把所有已启用任务的计划重新发布一遍。“立即运行”直接往 `fire` 发一条带 `{"now": true}` 的消息，走同一条路径。

浏览器看到的“下次运行”由 croniter 按同一个 cron 计算。

## 一次运行

1. controller 每轮从 consumer `routine-fires` 取触发消息（取到即确认：controller 停机期间错过的触发不补）。任务已暂停（且不是立即运行）就跳过；同一任务已有运行中的（部分唯一索引）也跳过。
2. 建 `routine_run`，用 agent runtime 镜像启动一个容器，命令换成 `python -m axp_runtime.routine`。developer instructions 里有任务名、计划、当前要求、上一次的交接说明和做法；第一条消息是当前时间。
3. 容器里只装两个插件：`routine`（`list_runs`、`get_run`、`search_runs` 查本任务过往的报告和反馈，`finish` 结束运行）和 `grok`（网页搜索）。审批策略是 `never`：没有人在线。
4. 模型调用照常经 runtime 网关；运行的 key 是 `<run id>.<token>`，token 只在运行期间有效，网关以 `routine-<id>` 作为 `X-AXP-Agent-Id`。
5. turn 结束后 runtime 报告 `complete`。调用过 `finish` 的以它为准（有报告是“已发送”，没有是“没有新内容”）；没调用的，完成时以最后一条回复作为报告，否则记为失败。
6. controller 随后移除容器。超过 15 分钟的运行被停止并记为失败；容器没有报告就退出的，30 秒后记为失败。

## 反馈

反馈写入 `routine_feedback` 后，controller 在后台用任务的模型（直接请求 LLM 网关的 chat completions）把反馈吸收进要求，存为新的一版，从下一次运行开始生效。旧版本可以恢复（恢复也是新的一版）。

## 界面

右侧面板的“定时”tab（`apps/web/src/components/workspace/routines.tsx`）：列表、任务详情（要求和一条把运行、反馈、要求修订串在一起的时间线）、报告页（报告和反馈）、新建与编辑表单。
