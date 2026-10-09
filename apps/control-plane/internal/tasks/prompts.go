package tasks

import (
	"fmt"
	"strings"
)

// What remote agents are sent. They work in their place (a workspace or a
// new worktree of the user's), where the `axp` CLI knows which task they are
// on. How to use it (replying, statuses, pull requests, attachments) is the
// axp skill `axp setup` installs for them (apps/remote/skills/axp), not
// these prompts: they carry the task, the place and the rule AXP enforces.

const brief = "你在处理 AXP 任务看板上的任务，用 `axp` skill 和看板打交道。" +
	"每一轮结束前，必须用 `axp task comment` 汇报你做了什么、结果如何、还需要什么；没有评论的一轮不算完成。" +
	"在当前目录里工作，把改动提交到当前分支。"

func describe(r *taskRow) string {
	var b strings.Builder
	fmt.Fprintf(&b, "任务 #%d：%s\n", r.Number, r.Title)
	if desc := strings.TrimSpace(r.Description); desc != "" {
		fmt.Fprintf(&b, "\n%s\n", desc)
	}
	return b.String()
}

func initialPrompt(r *taskRow) string {
	return brief + "\n\n---\n\n" + describe(r) + "\n开始处理这个任务。"
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
