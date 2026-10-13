package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// currentTask is the task the agent works on: --task, AXP_TASK_ID (Herdr
// tabs AXP opens carry it), or the task whose place the working directory
// is in, as AXP knows it.
func currentTask(c *Config, flagTask string) (string, error) {
	if flagTask != "" {
		return flagTask, nil
	}
	if id := os.Getenv("AXP_TASK_ID"); id != "" {
		return id, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	var out struct {
		TaskID string `json:"task_id"`
	}
	if err := c.call("GET", "/remote/v1/current-task?dir="+url.QueryEscape(cwd), nil, &out); err != nil {
		return "", err
	}
	return out.TaskID, nil
}

type taskDetail struct {
	ID          string `json:"id"`
	Number      int64  `json:"number"`
	Title       string `json:"title"`
	Status      string `json:"status"`
	Description string `json:"description"`
	Assists     []struct {
		ID       string  `json:"id"`
		State    string  `json:"state"`
		Reason   *string `json:"reason"`
		Runtime  string  `json:"runtime"`
		Provider string  `json:"provider"`
		Request  string  `json:"request"`
		Round    *int    `json:"round"`
		RunID    *string `json:"run_id"`
		HeadSHA  *string `json:"head_sha"`
		Verdict  *string `json:"verdict"`
	} `json:"assists"`
	Loops []struct {
		ID        string  `json:"id"`
		Provider  string  `json:"provider"`
		MaxRounds int     `json:"max_rounds"`
		Rounds    int     `json:"rounds"`
		State     string  `json:"state"`
		Reason    *string `json:"reason"`
	} `json:"loops"`
	Runs []struct {
		ID     string `json:"id"`
		Status string `json:"status"`
		Assist bool   `json:"assist"`
	} `json:"runs"`
	Activity []struct {
		Kind  string `json:"kind"`
		Actor struct {
			Kind      string  `json:"kind"`
			AgentName *string `json:"agent_name"`
		} `json:"actor"`
		Body      *string        `json:"body"`
		Data      map[string]any `json:"data"`
		CreatedAt string         `json:"created_at"`
	} `json:"activity"`
}

func taskCommand(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: axp task show | comment <text> | status <status> | assist <runtime>/<provider> <request> | review pass|changes [<text>] [--task N]")
	}
	c, err := loadConfig()
	if err != nil {
		return err
	}
	// --task: the task's number or id (default: the one this directory
	// belongs to). --file: a comment's text from a file (- for stdin).
	// assist: --after, --pull, --rounds, --key (see help).
	a, err := parseArgs(args[1:], "task", "file", "after", "pull", "rounds", "key")
	if err != nil {
		return err
	}
	positional, file := a.positional, a.flags["file"]
	// text is the command's text: its words, or --file's contents.
	text := func(words []string) (string, error) {
		if file == "" {
			return strings.Join(words, " "), nil
		}
		var data []byte
		var err error
		if file == "-" {
			data, err = io.ReadAll(os.Stdin)
		} else {
			data, err = os.ReadFile(file)
		}
		return string(data), err
	}
	id, err := currentTask(c, a.flags["task"])
	if err != nil {
		return err
	}
	switch args[0] {
	case "show":
		var t taskDetail
		if err := c.call("GET", "/remote/v1/tasks/"+id, nil, &t); err != nil {
			return err
		}
		printTask(&t)
		return nil
	case "comment":
		body, err := text(positional)
		if err != nil {
			return err
		}
		if strings.TrimSpace(body) == "" {
			return errors.New("usage: axp task comment <text> | --file <path>")
		}
		if err := c.call("POST", "/remote/v1/tasks/"+id+"/comments", map[string]string{"body": body}, nil); err != nil {
			return err
		}
		fmt.Println("已回复。")
		return nil
	case "status":
		if len(positional) != 1 {
			return errors.New("usage: axp task status in_progress|in_review|blocked")
		}
		if err := c.call("POST", "/remote/v1/tasks/"+id+"/status", map[string]string{"status": positional[0]}, nil); err != nil {
			return err
		}
		fmt.Println("状态已更新为", positional[0])
		return nil
	case "assist":
		return assistCommand(c, id, a, text)
	case "review":
		if len(positional) == 0 || (positional[0] != "pass" && positional[0] != "changes") {
			return errors.New("usage: axp task review pass [<text>] | changes <feedback> | --file <path>")
		}
		feedback, err := text(positional[1:])
		if err != nil {
			return err
		}
		verdict := map[string]string{"pass": "pass", "changes": "changes_requested"}[positional[0]]
		if err := c.call("POST", "/remote/v1/tasks/"+id+"/review", map[string]string{"verdict": verdict, "feedback": feedback}, nil); err != nil {
			return err
		}
		fmt.Println("审查结论已提交：", verdict)
		return nil
	}
	return fmt.Errorf("unknown task command %q", args[0])
}

// assistCommand asks another agent on this computer to assist, as the web
// and the tasks tool do: axp task assist <runtime>/<provider> <request> |
// --file F [--after current|<run id>] [--pull yes|no] [--rounds N] [--key K].
func assistCommand(c *Config, id string, a cliArgs, text func([]string) (string, error)) error {
	usage := errors.New("usage: axp task assist <runtime>/<provider> <request> | --file <path> [--after current|<run id>] [--pull yes|no] [--rounds N] [--key K]")
	if len(a.positional) == 0 {
		return usage
	}
	runtime, provider, ok := strings.Cut(a.positional[0], "/")
	if !ok {
		return usage
	}
	request, err := text(a.positional[1:])
	if err != nil {
		return err
	}
	if strings.TrimSpace(request) == "" {
		return usage
	}
	in := map[string]any{"runtime": runtime, "provider": provider, "request": request, "after_run": a.flags["after"]}
	switch a.flags["pull"] {
	case "":
	case "yes":
		in["review_pull"] = true
	case "no":
		in["review_pull"] = false
	default:
		return usage
	}
	if rounds := a.flags["rounds"]; rounds != "" {
		n, err := strconv.Atoi(rounds)
		if err != nil || n < 1 {
			return usage
		}
		in["loop"] = map[string]int{"max_rounds": n}
	}
	// A retry of this command is the same request.
	key := a.flags["key"]
	if key == "" {
		b := make([]byte, 12)
		_, _ = rand.Read(b)
		key = "cli-" + hex.EncodeToString(b)
	}
	in["key"] = key
	if err := c.call("POST", "/remote/v1/tasks/"+id+"/assists", in, nil); err != nil {
		return err
	}
	fmt.Printf("已请 %s/%s 协助（key %s）；axp task show 看它的进度。\n", runtime, provider, key)
	return nil
}

type cliArgs struct {
	flags      map[string]string
	positional []string
}

// parseArgs takes the named flags (--task, -task, --task=3) wherever they
// are; everything else is text, even when it starts with "-" (a comment
// that is a Markdown list), and so is everything after "--".
func parseArgs(args []string, names ...string) (cliArgs, error) {
	a := cliArgs{flags: map[string]string{}}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			a.positional = append(a.positional, args[i+1:]...)
			break
		}
		name, value, inline := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		if !strings.HasPrefix(arg, "-") || !slices.Contains(names, name) {
			a.positional = append(a.positional, arg)
			continue
		}
		if !inline {
			if i+1 == len(args) {
				return a, fmt.Errorf("--%s needs a value", name)
			}
			i++
			value = args[i]
		}
		a.flags[name] = value
	}
	return a, nil
}

func printTask(t *taskDetail) {
	fmt.Printf("# #%d %s\n\n状态：%s\n", t.Number, t.Title, t.Status)
	if strings.TrimSpace(t.Description) != "" {
		fmt.Printf("\n%s\n", strings.TrimSpace(t.Description))
	}
	if len(t.Runs) > 0 {
		fmt.Println("\n## 运行")
		for _, r := range t.Runs {
			lane := "主执行"
			if r.Assist {
				lane = "协助"
			}
			fmt.Printf("- %s %s：%s\n", r.ID, lane, r.Status)
		}
	}
	if len(t.Assists) > 0 {
		fmt.Println("\n## 协助请求（按请求顺序）")
		for _, x := range t.Assists {
			line := fmt.Sprintf("- %s %s/%s：%s", x.ID, x.Runtime, x.Provider, x.State)
			if x.Round != nil {
				line += fmt.Sprintf("，审查第 %d 轮", *x.Round)
			}
			if x.RunID != nil {
				line += "，运行 " + *x.RunID
			}
			if x.HeadSHA != nil {
				line += "，提交 " + *x.HeadSHA
			}
			if x.Verdict != nil {
				line += "，结论 " + *x.Verdict
			}
			if x.Reason != nil {
				line += "（" + *x.Reason + "）"
			}
			fmt.Println(line)
		}
	}
	for _, l := range t.Loops {
		fmt.Printf("\n审查循环 %s（%s）：%s，已审 %d/%d 轮", l.ID, l.Provider, l.State, l.Rounds, l.MaxRounds)
		if l.Reason != nil {
			fmt.Printf("；%s", *l.Reason)
		}
		fmt.Println()
	}
	fmt.Println("\n## 时间线")
	for _, a := range t.Activity {
		who := map[string]string{"user": "用户", "agent": "AXP 智能体", "remote": "远程智能体", "system": "AXP"}[a.Actor.Kind]
		if a.Actor.AgentName != nil {
			who = "AXP 智能体 " + *a.Actor.AgentName
		}
		if provider, ok := a.Data["provider"].(string); ok && a.Actor.Kind == "remote" {
			who = "远程智能体 " + provider
			if a.Data["assist"] == true {
				who += "（协助）"
			}
		}
		at := a.CreatedAt
		if len(at) >= 16 {
			at = strings.Replace(at[:16], "T", " ", 1)
		}
		switch a.Kind {
		case "comment":
			fmt.Printf("\n### %s · %s\n\n%s\n", who, at, strings.TrimSpace(*a.Body))
		case "assist":
			agent, _ := a.Data["agent"].(map[string]any)
			fmt.Printf("\n### %s · %s：请 %v 协助\n\n%s\n", who, at, agent["provider"], strings.TrimSpace(*a.Body))
		case "review":
			fmt.Printf("\n### %s · %s：审查结论 %v（第 %v 轮）\n\n%s\n", who, at, a.Data["verdict"], a.Data["round"], strings.TrimSpace(*a.Body))
		case "status":
			fmt.Printf("\n- %s %s：状态 %v → %v\n", at, who, a.Data["from"], a.Data["to"])
		case "deliverable":
			fmt.Printf("\n- %s 交付：%v\n", at, a.Data["url"])
		case "artifact":
			fmt.Printf("\n- %s %s 发布了 Artifact「%v」第 %v 版（%v）\n", at, who, a.Data["title"], a.Data["version"], a.Data["artifact_id"])
		}
	}
}

// --- GitHub ------------------------------------------------------------------------------

type credentials struct {
	Token string `json:"token"`
	User  string `json:"user"`
}

var pullURL = regexp.MustCompile(`https://github\.com/[\w.-]+/[\w.-]+/pull/\d+`)

// ghCommand runs gh through AXP's GitHub App: on behalf of the user who
// authorized the App, when they have, so what it does shows as theirs (and
// what GitHub allows only a user, such as creating a repository in their
// account, works), else as the App's bot. A pull request it creates is
// recorded as the task's deliverable.
func ghCommand(args []string) error {
	c, err := loadConfig()
	if err != nil {
		return err
	}
	var creds credentials
	if err := c.call("GET", "/remote/v1/git/credentials", nil, &creds); err != nil {
		return err
	}
	if creds.User != "" {
		fmt.Fprintf(os.Stderr, "axp: 以 %s 的身份（经 AXP 的 GitHub App）运行 gh\n", creds.User)
	} else {
		fmt.Fprintln(os.Stderr, "axp: 以 GitHub App 的 bot 身份运行 gh（用户还没有授权 App）")
	}
	cmd := exec.Command("gh", args...)
	cmd.Env = append(os.Environ(), "GH_TOKEN="+creds.Token, "GITHUB_TOKEN="+creds.Token)
	var out bytes.Buffer
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, io.MultiWriter(os.Stdout, &out), os.Stderr
	runErr := cmd.Run()
	if len(args) >= 2 && args[0] == "pr" && args[1] == "create" {
		if url := pullURL.FindString(out.String()); url != "" {
			if id, err := currentTask(c, ""); err == nil {
				if err := c.call("POST", "/remote/v1/tasks/"+id+"/deliverables", map[string]string{
					"kind": "pull_request", "url": url,
				}, nil); err != nil {
					fmt.Fprintln(os.Stderr, "axp: 没能把 PR 记为交付物：", err)
				}
			}
		}
	}
	var exit *exec.ExitError
	if errors.As(runErr, &exit) {
		os.Exit(exit.ExitCode())
	}
	return runErr
}

func status() error {
	c, err := loadConfig()
	if err != nil {
		return err
	}
	fmt.Printf("电脑：%s（%s）\nAXP：%s\n中继：%s\n", c.Name, c.ComputerID, c.URL, c.RelayURL)
	for _, kind := range c.kinds() {
		out, _ := c.connector(kind, "status", "--json").Output()
		fmt.Printf("\n%s connector：\n%s", kind, out)
	}
	return nil
}
