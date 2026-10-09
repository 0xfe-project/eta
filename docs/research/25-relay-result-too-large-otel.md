# #25 远程记录 64 KiB 超限与生产 OTel 诊断能力

调查时间：2026-10-09，生产版本 `415f40b`（api/web/gateway 等），relay `axp-relay:bc84cad15280`，agenvo `bc84cad`。只读调查，未改生产、未重发任务。

用户看到的原文：

> 读取远程智能体的记录失败：relay: result_too_large: Native result exceeds 64 KiB. Use native IDs with narrower/paginated reads. Confirmation does not mean task completion.

## 一、根因

### 调用链

| 层           | 位置                                                                          | 行为                                                                                                          |
| ------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 前端         | `apps/web/src/queries/tasks.ts:82` `useRunLog`                                | 运行中每 3 秒 `GET /api/v1/tasks/{task}/runs/{run}/log`，`retry: false`                                       |
| 前端         | `apps/web/src/components/workspace/tasks.tsx:750` `RunLog`                    | 出错时原样显示 `error.message`                                                                                |
| 控制面 API   | `apps/control-plane/internal/api/tasks.go:192` → `tasks.go:769` `Service.Log` | 失败一律包成 `424 REMOTE_UNAVAILABLE "读取远程智能体的记录失败：" + err`                                      |
| 控制面       | `apps/control-plane/internal/tasks/native.go:636` `agents.log`                | Paseo：`paseo.agents.history {agentId, limit: 50}`，**不带 cursor、不翻页**；Herdr：`agent.read {lines: 300}` |
| relay 客户端 | `apps/control-plane/internal/relay/relay.go` `Call`                           | `Fault.Error()` 生成 `relay: <code>: <message>`                                                               |
| connector    | `vendor/agenvo/packages/connector/src/adapters/adapter.ts:42` `bounded()`     | 序列化后 ≥ `LIMITS.frame - 2048`（62 KiB）就丢掉结果，换成上面那条英文消息，`execution` 保持 `accepted`       |
| Paseo 适配器 | `vendor/agenvo/apps/paseo/src/paseo.ts:41,204`                                | `paseo.agents.history` 已支持 `direction`/`cursor {epoch, seq}`/`limit 1–50`，原样转给 `fetchAgentTimeline`   |

消息里的 "Confirmation does not mean task completion" 是 connector 的通用措辞，对只读调用没有意义。

### 证据

- relay 容器 stdout（非 OTel）：`2026-10-09T12:30:02.352Z` 与 `12:30:05.974Z` 两条 `mcp.tool.completed`，`method=paseo.agents.history`、`instanceId=paseo`、`deviceId=3ac052d0…`、`execution=accepted`、`errorCode=result_too_large`、`durationMs=30/23`。
- gateway 容器 stdout（非 OTel）：同一 run `tasks/1a6cb8e3…/runs/ff8024ea…/log`：`12:28:20Z`、`12:28:24Z` 为 200（响应 57,098 B），`12:30:02Z`、`12:30:05Z` 为 424（288 B）。同一 run 两分钟内从成功变为失败。
- 数据库（只读）：该 run 属于任务 #23，`runtime=paseo`、`provider=claude`、run 状态 `running`（读失败没有影响任务状态）。
- 本机复现（这台机器就是该远程电脑；用 connector 自带的 `@getpaseo/client` 0.11.1，只打印大小与类型）：AXP 的同一调用 `fetchAgentTimeline(agentId, {limit: 50})` 返回 **88,278 B**，50 条中 38 条 `tool_call` 共 80.6 KB，最大单条 6.6 KB（Bash 输出 6.2 KB），`hasOlder=true`，有 `startCursor {epoch, seq}`。`limit 20/10/5` 分别为 29.2/12.4/9.4 KB。

结论：**是累计历史超限，不是单条大工具输出**。Claude 代理几分钟内就能积累 50 条带输出的工具调用，`limit: 50` 的单次读取必然越过 62 KiB。原生接口已有游标分页，AXP 没用。Herdr 分支（300 行终端）同样没有大小保护，行很长时也可能触发（未观测到）。

## 二、修复方案

### 推荐：控制面按字节自适应、倒序分页（只改 AXP）

不需要升级用户电脑上的 connector。

1. `agents.log`（Paseo）：`direction: "before"`，从最新页开始，`limit` 初始 20；遇到 `result_too_large` 就减半（20→10→5→2→1）重试同一页，成功后用返回的 `startCursor` 继续往前取，直到 `hasOlder=false` 或达到本次的条目/字节预算（比如 100 条，或给浏览器的响应约 128 KB）。
2. 顺序与去重：各页内部是旧→新，按页倒序拼接后整体旧→新；按 `seq`（合并条目用 `seqStart..seqEnd`）去重。
3. 完整性：所有页必须同一 `epoch`；遇到 `staleCursor`/`reset`/epoch 变化就从头重读一次，仍不一致则返回已取到的最新页并标记 `partial`；`gap=true` 时在记录中插一条"中间有缺失"。
4. 单条超大（`limit=1` 仍超限）：插一条占位（"这一条记录超过 64 KiB，无法经中继读取"），游标 `seq` 减 1 跳过。**待确认**：Paseo 的 before 游标是否是"严格小于 seq"，以及合并条目跨多个 seq 时减 1 是否足够；需对 `@getpaseo/server` 验证。
5. API 形状：`GET …/log?before=<cursor>` 返回 `{entries, older_cursor?, partial?}`；默认只返回最新一段。运行中的轮询改成只读最新一页（或用 `direction: "after"` + `endCursor` 增量），不用每 3 秒拉 50 条。
6. 控制面再把每条 `Text` 截到约 4 KB（界面本来就折叠）并标记 `truncated`，浏览器负载与中继上限脱钩。
7. 错误分类：中继的 `result_too_large` 映射为独立的 `REMOTE_LOG_TOO_LARGE`，中文提示，去掉 connector 的英文原文；它只是读失败，**不改 run/task 状态，不触发任何重发**（现状也不会，保持即可）。
8. Herdr：`lines` 300→150→80 递减重试；仍超限时提示"终端输出过宽"。

前端：显示最近 N 条，顶部"加载更早的记录"按钮（`older_cursor`），`partial`/截断/缺失处显示提示；读失败显示为"记录暂时读不到"，不显示为任务失败。

### 备选

- **在 agenvo（自己的 fork）把 `paseo.agents.history` 改为按字节截断**：复用 `@agenvo/protocol` 的 `page()` 思路，超预算时保留最新条目、修正 `startCursor/hasOlder`，单条超大时截断 `detail.output` 并标 `truncated`。语义最干净（一次调用永不超限），但要所有远程电脑升级 connector 才生效。建议作为第二步，AXP 的自适应分页保留作兼容。
- **改用 connector 的 `threads.read`**（`paseo-management.ts:136`，已分页并给 opaque cursor）：它的 `limit` 也按条数，不按字节，问题一样。
- **仅把 `limit` 改为 10**：最小改动，但工具输出再大一点仍会失败，且只看到 10 条。不推荐。
- **提高 64 KiB 上限**：relay 帧协议与内存保护的上限，不该为一个展示接口改。不推荐。

### 最小验收

1. Go 单测（fake relay）：`limit>k` 时返回 `result_too_large` → 自动降级并拼出完整、有序、无重复的记录；跨页 epoch 变化 → 重读；`limit=1` 仍超限 → 占位并继续；`result_too_large` 映射为 `REMOTE_LOG_TOO_LARGE` 且 run 状态不变。
2. 本机复现：对任务 #23 的 agent（现 88 KB/50 条）调新接口，返回 200，条数与 `fetchAgentTimeline` 逐页对齐，`older_cursor` 能继续翻页。
3. 部署后看 relay stdout（或补上 OTel 后的查询，见下）：`paseo.agents.history` 不再出现 `errorCode=result_too_large`，gateway 的 `/log` 不再 424。

## 三、生产 OTel 实际查询结果

入口：OpenObserve `http://127.0.0.1:24160/observe`，组织 `default`，root 账号只读查询（`_search` API）。

- 数据源：logs 只有一个 stream `default`（94,485 条），traces 只有 `default`（28,423 条）。
- 时间窗：**2026-10-07T09:00:24Z（stream 最早一条）至 2026-10-09T12:35Z**，覆盖 12:30:02Z 的故障时刻；故障前后 `control-plane-api`、`control-plane-controller` 都在正常上报，采集链路通。
- 关键词（`str_match` 于 `body/error_message/exception_message/path/url/method/output/arguments`）：

| 关键词                                                                     | 命中                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `result_too_large` / `Native result exceeds` / `64 KiB` / `读取远程智能体` | 3 条，均为 `codex-app-server`（某 AXP 聊天智能体 `axp_agent_id=63b6d865…`）在 12:31:11Z 的 `codex.user_prompt` 和 12:31:48Z 的两条 `codex.tool_result`，即有人把这段报错文字发给智能体并让它处理，**不是故障本身的记录** |
| `REMOTE_UNAVAILABLE`、`runs/`、`agents.history`                            | 0                                                                                                                                                                                                                        |

- `control-plane-api` 在整个时间窗共 286 条，全部是启动/停止/监听等生命周期日志，**没有一条请求日志**。traces 只有 `codex-app-server`，没有任何 AXP 服务的 span。

可复查的查询：

```sql
-- logs，start_time=1791363624000000（2026-10-07T09:00Z），end_time=现在
SELECT service_name, count(*) FROM "default"
WHERE str_match(body,'result_too_large') OR str_match(error_message,'result_too_large')
   OR str_match(output,'result_too_large') OR str_match(arguments,'result_too_large')
GROUP BY service_name;

SELECT severity, substr(body,1,60) b, count(*) c FROM "default"
WHERE service_name='control-plane-api' GROUP BY severity, b ORDER BY c DESC;

-- traces
SELECT service_name, count(*) FROM "default" GROUP BY service_name;
```

### 判断：不是"没查到"，是"根本没记录"

代码确认这条错误经过的每一层都不往 OTel 写：

- `packages/service-go/httpapi/httpapi.go:186` `newError`：带 `*apierr.Error` 的错误直接返回，**只有未处理的 500 才 `slog.Error`**；424 `REMOTE_UNAVAILABLE` 不记录。也没有访问日志中间件。
- `packages/telemetry-go/telemetry.go`：只有 log pipeline，没有 tracer provider，Go 服务不产生 trace，`slog` 记录也没有 trace_id。
- relay accessory（`deploy/deploy.yml:280`）没有 `OTEL_*` 环境变量，pino 日志只在容器 stdout，relay 重启即丢失。
- connector（`vendor/agenvo/packages/connector/src/main.ts:283`）只对 `internal_error` 写本地日志，`result_too_large` 不记录。
- gateway 访问日志按设计只在 stdout（`deploy/README.md` 已写明不进 OpenObserve），每次部署换容器后旧日志随之删除。
- 浏览器只上报 `window.error`/`unhandledrejection`（`apps/web/src/lib/report.ts`），React Query 的请求错误不会上报。

### 诊断能力评估

| 问题                    | 仅靠 OTel                                                 | 加上 stdout 辅助证据                                                                          |
| ----------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 能否发现错误            | 否                                                        | relay、gateway stdout 能                                                                      |
| 关联到具体任务/run/请求 | 否                                                        | gateway 日志有 task/run 路径；relay 日志没有 AXP 的 request id，只能靠时间对齐                |
| 关联到远程电脑/runtime  | 否                                                        | relay 日志有 deviceId、instanceId                                                             |
| 失败层级与原生方法      | 否                                                        | relay 日志有 `method=paseo.agents.history`、`errorCode`；错误文字说明是 connector `bounded()` |
| 响应大小/上限/分页参数  | 否                                                        | 都没有：没有字节数、`limit`、cursor；只能本地复现得到 88 KB                                   |
| 服务版本                | 只有 `service_name`，`service_version` 字段为空（未设置） | 容器名有 git sha                                                                              |

这次能定位，靠的是 stdout、数据库和本机复现，不是 OTel。现有 OTel 设计对这类"控制面→中继→远程运行时"的读失败**没有诊断价值**，而且 stdout 证据会在下次部署或 relay 重启后消失。

## 四、最小 OTel 改进

只记关联字段和大小，不记聊天、工具输出、参数值和凭据。

1. **控制面记录上游错误**：`httpapi.newError` 遇到 `status >= 424`（或 `apierr.Upstream`）时 `slog.WarnContext("Upstream error", request_id, code, http.route)`；`relay.Client.Call` 失败时 `slog.WarnContext("Relay call failed", request_id, relay.method, relay.instance_id, relay.device_id, relay.error_code, relay.execution, duration_ms)`，`tasks.Log` 附 `task_id, run_id, session_id, runtime`。这两处就足以从 OTel 回答上表前四行。
2. **大小与参数**：成功和失败都记 `relay.response_bytes`（成功时可得；失败时 connector 不回传原始大小，可加 `relay.limit_bytes=65536`、`relay.page_limit`、`relay.has_cursor`）。若改 agenvo，可在 `bounded()` 的错误里带 `omittedBytes`（Paseo 事件里已有同名先例），这是唯一能拿到真实超限字节数的地方。
3. **relay 接入 collector**：relay accessory 加入 runtime 网络或直接配 OTLP（pino → OTLP transport），只导出 `mcp.tool.completed` 这类结构化字段；或者最小化做法是控制面把 AXP 的 request id 作为 `requestId` 传给 relay，让两边可以对上。
4. `OTEL_RESOURCE_ATTRIBUTES` 加 `service.version=<git sha>`，部署时注入。
5. trace（`otelhttp` + span 传播到 relay）收益更大但改动也大，可以放在 1–4 之后。
