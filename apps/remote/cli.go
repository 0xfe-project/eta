package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"regexp"
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
	Activity    []struct {
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
		return errors.New("usage: axp task show | comment <text> | status <status> [--task N]")
	}
	c, err := loadConfig()
	if err != nil {
		return err
	}
	flags := flag.NewFlagSet("task "+args[0], flag.ContinueOnError)
	task := flags.String("task", "", "the task's number or id (default: the one this directory belongs to)")
	file := flags.String("file", "", "comment: read the comment from a file (- for stdin)")
	// Flags may come after the text.
	var positional []string
	rest := args[1:]
	for len(rest) > 0 {
		if err := flags.Parse(rest); err != nil {
			return err
		}
		if flags.NArg() == 0 {
			break
		}
		positional = append(positional, flags.Arg(0))
		rest = flags.Args()[1:]
	}
	id, err := currentTask(c, *task)
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
		body := strings.Join(positional, " ")
		if *file != "" {
			var data []byte
			if *file == "-" {
				data, err = io.ReadAll(os.Stdin)
			} else {
				data, err = os.ReadFile(*file)
			}
			if err != nil {
				return err
			}
			body = string(data)
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
	}
	return fmt.Errorf("unknown task command %q", args[0])
}

func printTask(t *taskDetail) {
	fmt.Printf("# #%d %s\n\n状态：%s\n", t.Number, t.Title, t.Status)
	if strings.TrimSpace(t.Description) != "" {
		fmt.Printf("\n%s\n", strings.TrimSpace(t.Description))
	}
	fmt.Println("\n## 时间线")
	for _, a := range t.Activity {
		who := map[string]string{"user": "用户", "agent": "AXP 智能体", "remote": "你（远程智能体）", "system": "AXP"}[a.Actor.Kind]
		if a.Actor.AgentName != nil {
			who = "AXP 智能体 " + *a.Actor.AgentName
		}
		at := a.CreatedAt
		if len(at) >= 16 {
			at = strings.Replace(at[:16], "T", " ", 1)
		}
		switch a.Kind {
		case "comment":
			fmt.Printf("\n### %s · %s\n\n%s\n", who, at, strings.TrimSpace(*a.Body))
		case "status":
			fmt.Printf("\n- %s %s：状态 %v → %v\n", at, who, a.Data["from"], a.Data["to"])
		case "deliverable":
			fmt.Printf("\n- %s 交付：%v\n", at, a.Data["url"])
		}
	}
}

// --- GitHub ------------------------------------------------------------------------------

type credentials struct {
	Token string `json:"token"`
	User  string `json:"user"`
}

var pullURL = regexp.MustCompile(`https://github\.com/[\w.-]+/[\w.-]+/pull/\d+`)

// ghCommand runs gh as AXP's GitHub App; a pull request it creates is
// recorded as the task's deliverable. gh pr runs on behalf of the user who
// authorized the App, when they have, so pull requests and their comments
// show as theirs.
func ghCommand(args []string) error {
	c, err := loadConfig()
	if err != nil {
		return err
	}
	path := "/remote/v1/git/credentials"
	if len(args) >= 1 && args[0] == "pr" {
		path += "?as=user"
	}
	var creds credentials
	if err := c.call("GET", path, nil, &creds); err != nil {
		return err
	}
	if creds.User != "" {
		fmt.Fprintf(os.Stderr, "axp: 以 %s 的身份（经 AXP 的 GitHub App）运行 gh\n", creds.User)
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
	fmt.Printf("电脑：%s（%s）\nAXP：%s\n中继：%s\n", c.Name, c.ComputerID, c.URL, c.RelayOrigin)
	for _, kind := range c.kinds() {
		out, _ := c.connector(kind, "status", "--json").Output()
		fmt.Printf("\n%s connector：\n%s", kind, out)
	}
	return nil
}
