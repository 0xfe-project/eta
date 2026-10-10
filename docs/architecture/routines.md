# 定时任务

本文说明 [#23](https://github.com/AkaraChen/axp/issues/23) 的实现：按计划运行的智能体。每次运行留下一份报告（或者什么都不发），并给下一次运行写一段交接说明。用户对报告的反馈会修订任务的要求。

定时任务是一个独立的 Go 服务（`apps/routine-service`，建在 [Go 服务框架](service-framework.md)上），与控制面无关：它有自己的数据库和 API，计划在 NATS，运行是进程内的 [ADK](https://adk.dev/) agent。浏览器经网关访问 `/api/routines`。

## 数据

服务自己的数据库 `axp_routines`（与其他服务同一个 PostgreSQL 实例；默认由 `DATABASE_URL` 换库名得到，也可用 `AXP_ROUTINES_DATABASE_URL` 指定）。服务启动时库不存在就创建，然后执行自己的迁移（`migrations/`）。新建任务、恢复要求版本、提交反馈这些 POST 支持 `Idempotency-Key`。

| 表                 | 内容                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| `routine`          | 名称、模型、计划（`schedule.go` 的四种形状）、时区、是否启用             |
| `routine_brief`    | 要求的各个版本；由反馈修订而来的版本指向那条反馈                         |
| `routine_run`      | 每次运行：状态（运行中、已发送、没有新内容、失败）、报告、交接说明、错误 |
| `routine_feedback` | 用户对某次运行的反馈；修订失败时标记 `revision_failed`                   |

“交接说明”是最近一次写了交接说明的运行的 `handoff`。同一任务同时只有一次运行（`status = 'running'` 上的部分唯一索引）。

## 计划

计划在 NATS 的 stream `ROUTINES`，由本服务创建和独占：`axp.routine.<id>.schedule` 上的一条带 `Nats-Schedule`（六段 cron）和 `Nats-Schedule-Time-Zone` 的消息，到点由 NATS 发布到 `axp.routine.<id>.fire`。新建、改计划、启用时发布（替换），暂停、删除时清除；都在请求的事务提交之前完成，失败则回滚（`503`）。服务启动时清除所有计划，再按数据库重新发布已启用任务的计划，所以已删除任务的计划不会留下。“立即运行”直接往 `fire` 发一条带 `{"now": true}` 的消息，走同一条路径。

服务通过 durable consumer `routine-fires` 取触发消息，取到即确认：服务停机期间错过的触发不补。停机期间 NATS 照常按计划把触发写进流里，服务启动后取到时，在流里等了一分钟以上的触发（按消息的存储时间）直接丢弃，“立即运行”同样处理。浏览器看到的“下次运行”由服务按同一个 cron 计算（robfig/cron）。

## 一次运行

1. 收到触发。任务已暂停（且不是立即运行）就跳过；同一任务已有运行中的也跳过。否则建 `routine_run`，起一个 goroutine 运行，限时 15 分钟。
2. 运行是一个 ADK `llmagent`：
   - instructions 里有任务名、计划、当前要求、上一次的交接说明和做法；第一条消息是当前时间。没有用户在线，工具一律放行。
   - 模型经 LLM 网关的 Chat Completions（ADK 的 `openaimodel`），请求带 `X-AXP-Agent-Id: routine-<id>`，用量记在任务名下。
   - 自己的工具（Go 函数，只能看到本任务）：`list_runs`、`get_run`、`search_runs` 查过往的报告和反馈，`finish` 结束运行。
   - [插件](plugins.md)中 routine 目标的那些（目前是 `grok` 的网页搜索），经服务的本地代理访问 LLM 网关，key 只在本次运行有效。
3. 调用过 `finish` 的以它为准（有报告是“已发送”，没有是“没有新内容”）；没调用的，正常结束时以最后一条回复作为报告，否则记为失败（附错误）。超时记为“运行超过 15 分钟，已停止。”
4. 服务重启时，上一个进程留下的运行中记录记为失败（“运行被中断”）。服务只能有一个实例。

## 聊天智能体的 routines 插件

RFC #23 §6 的浅集成：聊天智能体启用 `routines` 插件（`apps/agent-runtime/plugins/routines`）后，可以在对话里替用户建定时任务（“每天早上帮我做个日报”）、查看已有的任务和报告、修改要求、暂停或立即运行。插件的 MCP 服务就在本服务里（`/routines/mcp`，`internal/api/mcp.go`），工具是 `list_routines`、`get_routine`、`get_run`、`create_routine`、`update_routine`、`run_routine`，直接包装上面的领域函数；没有删除和反馈（反馈是用户自己的声音）。runtime 经 runtime 网关的 `/routines/*` 访问它，网关先确认这个智能体启用了 `routines` 插件（见[网关](gateway.md)），本服务只接受带 `X-AXP-Agent-Id` 的请求，而这个路径只有 runtime 网关会转发过来。新建时不指定模型，就用用户最近更新的那个定时任务的模型。

## 反馈

反馈写入 `routine_feedback` 后，服务在后台用任务的模型把反馈吸收进要求，存为新的一版，从下一次运行开始生效；失败则标记 `revision_failed`（超时也记得下）。修订基于读取时的最新一版：写入前发现要求已经变了（手动编辑、恢复旧版本、另一条反馈的修订），就基于新的一版重做，最多 3 次，不会覆盖更新的版本。服务重启时补做还没修订的反馈。旧版本可以恢复（恢复也是新的一版）。

## 界面

右侧面板的“定时”tab 和 `/workspace/routines`（`apps/web/src/components/workspace/routines.tsx`）：列表、任务详情（要求和一条把运行、反馈、要求修订串在一起的时间线）、报告页（报告和反馈）、新建与编辑表单。列表接口（`GET /routines`）只返回摘要：每个任务最近 14 次运行的状态、时间和标题，以及是否正在修订要求，固定 3 个查询，与任务数量无关；打开任务时再取它的详情（`GET /routines/{id}`：全部要求版本、最近 30 次运行的报告和反馈）。类型由本服务的 OpenAPI 文档生成（`apps/web/redocly.yaml`）。

## 开发与测试

`bun run dev` 启动它（`P+9`）。`bun run test:routine-service` 在开发 PostgreSQL 上用独立的库跑 API 与运行的测试，模型是脚本化的 ADK `model.LLM`，NATS 是假的；设 `AXP_TEST_NATS_URL` 再跑一遍真实 NATS 的计划与触发（要用测试自己的 NATS：其他服务的实例会抢走 `routine-fires` 上的触发）。
