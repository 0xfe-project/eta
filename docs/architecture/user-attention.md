# 用户确认

plugin 的工具在做有风险的操作前可以请用户确认：工具调用停在原地，直到用户在前端同意或拒绝。用户不必打开那个智能体，右侧栏的“待处理”标签页（和全窗口的“待处理”页）列出所有智能体待确认的请求。

这不是一个新服务，而是 MCP 的 elicitation 接进了现有的确认流程（见[聊天与运行时架构](chat-runtime.md)的“确认”一节）。

## plugin 怎么用

在 MCP 工具里发一个表单为空的 elicitation，等它返回（任何 MCP SDK 都可以，下面是 Python 的写法）：

```python
from mcp.server.fastmcp import Context, FastMCP

mcp = FastMCP("example")
CONFIRM = {"type": "object", "properties": {}}


@mcp.tool()
async def drop_table(name: str, ctx: Context) -> str:
    """Drop a table."""
    result = await ctx.session.elicit_form(
        f"删除表 {name}？", CONFIRM, related_request_id=ctx.request_id
    )
    if result.action != "accept":
        return "用户没有同意，未删除。"
    ...
```

- `action` 是 `accept`（同意）、`decline`（拒绝）或 `cancel`（turn 被停止或实例退出）。只有 `accept` 才能继续。
- 不要用 `ctx.elicit(schema=SomeModel)`：pydantic 生成的 schema 带 `title`，Codex 解析失败后直接以 `cancel` 回应，请求不会到达用户。
- 目前只支持纯确认：表单有字段的请求和 `url` 模式的请求会被拒绝。
- 提示文字写清楚要做什么、影响什么；它原样显示给用户，最多 500 字。

## 流程

1. 工具发出 `elicitation/create`；Codex 以 `mcpServer/elicitation/request` 转给 runtime。
2. runtime 像命令审批一样发出 `approval.requested`（`kind: "elicitation"`，摘要是 MCP 服务名和提示文字），然后挂起对这个请求的应答，等决定。
3. 控制面建 `approval` 和 choice `interaction`，回复显示“等待确认”，SSE 推给浏览器。
4. 用户在对话里或“确认”标签页回答；controller 把决定送到 runtime；runtime 以 `{"action": …}` 回应 Codex，工具继续执行。

等待期间 MCP 的工具超时（`tool_timeout_sec`）不计时，可以一直等下去。停止 turn 时请求以 `cancel` 结束；实例退出时同样以 `cancel` 结束，工具调用不会重放。

## “确认”标签页

右侧栏的一个标签页（`?view=inbox`），数据就是聊天快照里的待处理交互，所有智能体都在里面：

- 每条显示智能体名和提示文字，可以直接同意或拒绝；点智能体名切到它的对话。
- 标签名、手机上的“工作区”切换按钮和页面标题都带待确认数量。

## 其他等你处理的事

“待处理”不只有确认（#103）。在确认上面，还有一份从现有数据派生的列表，不新增状态：

- 任务：指派给你、待验收（`in_review`）、受阻（`blocked`）、最近一次远程运行失败、或有 AXP 智能体请求的运行在等你确认（#99），已完成和已取消的除外；
- 定时任务：有你还没看过的报告或失败的运行。`routine_run.seen_at` 记录你看过的时间（迁移 `00003`，之前结束的运行算作看过），打开一个定时任务时（`POST /routines/{id}/seen`）它已结束的运行都算看过；列表接口的摘要带 `unseen_reports`、`unseen_failures`。

侧栏和右侧栏“待处理”的数字是三类加起来的总数；任务页的数字仍是待验收的任务数。

## 边界

确认只拦得住经过这个工具的路径。智能体在容器里有完整权限，如果风险操作在容器里也能直接做到（例如所需凭据或命令对智能体可见），它可以绕过工具。真正有风险的能力应该放在容器外、经网关访问，plugin 工具是唯一入口。
