package tasks

import (
	"fmt"
	"strings"
)

// What remote agents are sent. They work in their place (a workspace or a
// new worktree of the user's), where the `axp` CLI knows which task they are
// on.

const cliGuide = `你在 AXP 的任务看板上工作，用 ` + "`axp`" + ` 命令和看板打交道（在当前目录及其子目录中运行）：

- ` + "`axp task show`" + `：任务的描述、状态和全部评论。
- ` + "`axp task comment \"<Markdown>\"`" + `（或 ` + "`--file <path>`" + `）：在任务下回复。
- ` + "`axp task status in_review|blocked|in_progress`" + `：做完待验收时设为 in_review，需要人帮忙时设为 blocked。
- ` + "`axp gh pr create ...`" + `：以 AXP 的 GitHub App 身份开 PR（先用 git 推送分支），开出的 PR 会记为任务的交付物。

规则：每一轮结束前，必须用 ` + "`axp task comment`" + ` 汇报你做了什么、结果如何、还需要什么；没有评论的一轮不算完成。在当前目录里工作，把改动提交到当前分支。`

func describe(r *taskRow) string {
	var b strings.Builder
	fmt.Fprintf(&b, "任务 #%d：%s\n", r.Number, r.Title)
	if desc := strings.TrimSpace(r.Description); desc != "" {
		fmt.Fprintf(&b, "\n%s\n", desc)
	}
	return b.String()
}

func initialPrompt(r *taskRow) string {
	return cliGuide + "\n\n---\n\n" + describe(r) + "\n开始处理这个任务。"
}

func actorName(by Actor) string {
	switch by.Kind {
	case ActorAgent:
		return "AXP 智能体"
	case ActorUser:
		return "用户"
	}
	return "AXP"
}

func followUpPrompt(r *taskRow, by Actor, body string) string {
	return fmt.Sprintf("任务 #%d 有一条来自%s的新评论：\n\n%s\n\n请据此继续（需要时用 `axp task show` 看完整的任务），结束前用 `axp task comment` 回复。",
		r.Number, actorName(by), body)
}

const nudgePrompt = "这一轮你还没有在任务下回复。请现在用 `axp task comment` 汇报你做了什么、结果如何、还需要什么；没有评论的一轮不算完成。"
