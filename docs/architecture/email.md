# 邮箱

邮箱是一条独立的邮件通道，不是 Agent 的附属物，也不是现有 `inbox`（Agent 提问队列）的一部分。

## 数据边界

```text
email_account
  └─ email_thread
       ├─ email_message
       ├─ session_email ── session (unmodified)
       └─ email_proposal
```

- `email_account` 只保存协议地址和连接参数；授权码以 `integration='email'` 存在 `credential` 表中，并用 host 的 `secret.key` 封装。
- `email_thread` 和 `email_message` 保存邮件线程、RFC 5322 头和人类可读正文。
- `session_email` 是普通 session 与邮件线程之间的产品级多对多关系。它不是会话所有权：删除 session 不会删除邮件。
- `email_proposal` 是 `send_email` / `reply` 工具创建的待确认 widget。用户确认前不会进入 SMTP，也不会写入已发送邮件。

## 收信

收信只使用 IMAP。每 60 秒检查 INBOX，并通过 IMAP special-use `\Junk` 或显式配置检查垃圾邮件目录。首次绑定把游标建立到当前最新 UID，不导入整个历史邮箱。

设置页的“检查连接”会执行 SMTP 登录、IMAP 登录，并以只读方式确认收件箱和垃圾邮件目录可访问。它不会发送测试邮件，也不验证邮箱地址的归属；真正的收发验证由 SMTP/IMAP 集成测试和两个实例之间的端到端测试完成。编辑账号时密码留空会继续使用已封装的凭据。

收到新邮件只更新邮箱状态，**不会创建或唤醒 Agent**。用户在邮箱页选择线程，明确选择 Agent 和 Project 后，才会向该 Agent 的真实私聊写入邮件 briefing、启动普通 session，并写入 `session_email`。邮件页显示处理 Agent、Project、运行状态和最终结果，并可直接打开该会话。

邮箱页的“收件箱”只列出包含收到邮件的线程，“已发送”只列出包含发件的线程。同一线程的后续收发仍保留在一起，以便查看完整回复链。

一个 session 可以关联多封邮件。交给 Agent 时，邮件标题、正文、RFC 5322 头和已解码的 ETA meta 会进入第一条提示。

## 发信

Agent 只会创建待确认提案：

- `send_email`：新邮件，必须显式选择邮箱账号。
- `reply`：只能回复当前 session 已关联的线程，参数携带 `threadId`。

提案在 session 时间线显示成可编辑 widget。用户确认后才：

1. 生成 `<eta.{uuid}.{session-id}@domain>` 的 Message-ID。
2. 生成回复所需的 `In-Reply-To` 和 `References`。
3. 渲染 Markdown/HTML 邮件、logo 和 10×10 上下文数据点。
4. 写入 outbox 并发送 SMTP。
5. 记录 `sending → accepted / failed`。

SMTP accepted 只表示服务器接受，不表示对方已读。

## ETA 上下文

logo 的 `alt` 使用 `ETA-A1:<base64url-json>`，携带 `agentId`、`agentName`、`sessionId`、逻辑 session / mail thread id 和 task id。

正文中的每个 10×10 数据点携带一个 `alt` 分片：

```text
ETA1:<batch>:<index>/<count>:<sha256-8>:<base64url-gzip-json>
```

接收方合并分片后恢复完整 envelope，其中包含 Agent/session/task 标识和 `context`。七个数据点不是七份独立上下文，而是同一份 gzip 数据的分片；分片数只表示传输体积。邮箱页面默认显示解码后的摘要，并可按需展开完整 `context`。数据点不自动触发任何 Agent 操作。

常规邮件固定显示 7 个 10×10 数据点，并把压缩后的上下文数据尽量等分到这 7 个 `alt` 中。只有总数据超过 7 个 `alt` 的承载上限时才增加点数，避免截断上下文。

`context` 是发送工具的可选业务数据。发送方传入 `{}` 或省略时，邮件仍携带 logo 和分片中的 Agent/session/thread/task 元数据，但页面会显示“无额外上下文”；这不表示分片解码失败。
