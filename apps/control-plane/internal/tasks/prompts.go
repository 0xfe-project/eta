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

// assistPrompt is an assisting agent's brief: the user's request as the
// confirmed requirement, the delivery pinned at the head the user saw, and
// the task as background. The assignee is named so it is not mistaken for
// the agent's own job.
func assistPrompt(r *taskRow, request string, pull *AssistPull) string {
	var b strings.Builder
	fmt.Fprintf(&b, "你被请来协助 AXP 任务看板上的任务 #%d。它的主执行者是这台电脑上 %s 里的 %s，不是你：你只做下面这一次协助，不接手任务本身。"+
		"用 `axp` skill 和看板打交道，结束前必须用 `axp task comment` 把结果回复在任务下（没有评论的一轮不算完成）；不要用 `axp task status` 改任务状态，状态由用户和主执行者决定。\n\n",
		r.Number, deref(r.Runtime), deref(r.Provider))
	b.WriteString("当前目录是 AXP 为这次协助单独开的 worktree，和主执行者的工作目录分开；不要去改主执行者的目录或分支。" +
		"只读的审查不要提交任何东西；要求里需要改代码时，在当前 worktree 新建分支提交，并在回复里写明交付方式（例如单独开一个 PR）。\n\n---\n\n")
	fmt.Fprintf(&b, "## 用户这次的协助要求（已确认）\n\n%s\n\n", request)
	b.WriteString("## 要看的交付\n\n")
	switch {
	case pull == nil:
		b.WriteString("这次没有指定要看的 PR；按要求看任务描述、时间线（交付也在里面）和主执行者的工作。\n\n")
	case pull.HeadSHA != "":
		fmt.Fprintf(&b, "PR：%s\n\n固定的 head：`%s`（用户请你协助时这个 PR 的最新提交）。先 `git fetch origin %s`，再 `git checkout --detach %s`，用 `git rev-parse HEAD` 确认后再看；"+
			"不要假设本地哪个分支就是最新交付。回复里写明你看的 SHA；PR 之后又有新提交的话，说明你没有看到它们。\n\n",
			pull.URL, pull.HeadSHA, pull.HeadSHA, pull.HeadSHA)
	default:
		fmt.Fprintf(&b, "PR：%s\n\nAXP 没能读到它现在的 head：用 `axp gh pr view %s --json headRefOid` 查出来，`git fetch origin <sha>` 后 `git checkout --detach <sha>` 再看；"+
			"不要假设本地哪个分支就是最新交付。回复里写明你看的 SHA。\n\n", pull.URL, pull.URL)
	}
	fmt.Fprintf(&b, "## 任务背景（不是这次的要求）\n\n%s\n完整的时间线（包括主执行者的回复和之前的协助）用 `axp task show` 看。", describe(r))
	return b.String()
}
