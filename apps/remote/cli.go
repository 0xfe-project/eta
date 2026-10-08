package main

import (
	"bufio"
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

func goos() string   { return runtime.GOOS }
func goarch() string { return runtime.GOARCH }

// currentTask is the task whose workspace the working directory is in:
// <root>/<task id>/…, or AXP_TASK_ID.
func currentTask(c *Config) (id, workspace string, err error) {
	if id := os.Getenv("AXP_TASK_ID"); id != "" {
		return id, filepath.Join(c.Root, id), nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", "", err
	}
	root, _ := filepath.EvalSymlinks(c.Root)
	if resolved, err := filepath.EvalSymlinks(cwd); err == nil {
		cwd = resolved
	}
	rel, err := filepath.Rel(root, cwd)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "", "", fmt.Errorf("不在任务的工作区里（%s/<任务>/）", c.Root)
	}
	id = strings.Split(rel, string(filepath.Separator))[0]
	return id, filepath.Join(c.Root, id), nil
}

type taskDetail struct {
	ID          string  `json:"id"`
	Number      int64   `json:"number"`
	Title       string  `json:"title"`
	Status      string  `json:"status"`
	Description string  `json:"description"`
	Repository  *string `json:"repository"`
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
		return errors.New("usage: axp task show | comment <text> | status <status>")
	}
	c, err := loadConfig()
	if err != nil {
		return err
	}
	id, _, err := currentTask(c)
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
		flags := flag.NewFlagSet("comment", flag.ContinueOnError)
		file := flags.String("file", "", "read the comment from a file (- for stdin)")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		body := strings.Join(flags.Args(), " ")
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
		if len(args) != 2 {
			return errors.New("usage: axp task status in_progress|in_review|blocked")
		}
		if err := c.call("POST", "/remote/v1/tasks/"+id+"/status", map[string]string{"status": args[1]}, nil); err != nil {
			return err
		}
		fmt.Println("状态已更新为", args[1])
		return nil
	}
	return fmt.Errorf("unknown task command %q", args[0])
}

func printTask(t *taskDetail) {
	fmt.Printf("# #%d %s\n\n状态：%s\n", t.Number, t.Title, t.Status)
	if t.Repository != nil {
		fmt.Printf("仓库：%s\n", *t.Repository)
	}
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
		case "checkout":
			fmt.Printf("\n- %s 拉取了 %v（分支 %v，起点 %v）\n", at, a.Data["repository"], a.Data["branch"], a.Data["base_commit"])
		case "deliverable":
			fmt.Printf("\n- %s 交付：%v\n", at, a.Data["url"])
		}
	}
}

// --- git and GitHub -----------------------------------------------------------------------

type credentials struct {
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expires_at"`
	Identity  *struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"identity"`
}

func gitCredentials(c *Config) (*credentials, error) {
	var creds credentials
	if err := c.call("GET", "/remote/v1/git/credentials", nil, &creds); err != nil {
		return nil, err
	}
	return &creds, nil
}

// gitCredential is git's credential helper for github.com: the App's token.
func gitCredential(args []string) error {
	if len(args) == 0 || args[0] != "get" {
		return nil
	}
	host := ""
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		if v, ok := strings.CutPrefix(scanner.Text(), "host="); ok {
			host = v
		}
	}
	if host != "github.com" {
		return nil
	}
	c, err := loadConfig()
	if err != nil {
		return err
	}
	creds, err := gitCredentials(c)
	if err != nil {
		return err
	}
	fmt.Printf("username=x-access-token\npassword=%s\n", creds.Token)
	return nil
}

var repoPattern = regexp.MustCompile(`^(?:https://github\.com/|git@github\.com:)?([\w.-]+)/([\w.-]+?)(?:\.git)?/?$`)

func git(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(out)), nil
}

// repoCommand clones a GitHub repository into the task workspace on the
// task's own branch, like multica's `repo checkout`. A checkout that already
// exists is kept as it is: only its remote refs are fetched.
func repoCommand(args []string) error {
	if len(args) == 0 || args[0] != "checkout" {
		return errors.New("usage: axp repo checkout <owner/name> [--ref <branch|commit>]")
	}
	flags := flag.NewFlagSet("checkout", flag.ContinueOnError)
	ref := flags.String("ref", "", "branch or commit to start from (default: the default branch)")
	// Flags may follow the repository.
	var repo string
	rest := args[1:]
	if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		repo, rest = rest[0], rest[1:]
	}
	if err := flags.Parse(rest); err != nil {
		return err
	}
	if repo == "" && flags.NArg() > 0 {
		repo = flags.Arg(0)
	}
	m := repoPattern.FindStringSubmatch(repo)
	if m == nil {
		return errors.New("usage: axp repo checkout <owner/name> [--ref <branch|commit>]")
	}
	owner, name := m[1], m[2]
	c, err := loadConfig()
	if err != nil {
		return err
	}
	id, workspace, err := currentTask(c)
	if err != nil {
		return err
	}
	var task taskDetail
	if err := c.call("GET", "/remote/v1/tasks/"+id, nil, &task); err != nil {
		return err
	}
	creds, err := gitCredentials(c)
	if err != nil {
		return err
	}
	dir := filepath.Join(workspace, name)
	helper := "!" + self() + " git-credential"
	branch := fmt.Sprintf("axp/%d", task.Number)
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		if _, err := git(dir, "fetch", "--quiet", "origin"); err != nil {
			return err
		}
		head, _ := git(dir, "rev-parse", "--abbrev-ref", "HEAD")
		fmt.Printf("%s 已经拉取过，保持原样（分支 %s），只更新了远端引用。\n", dir, head)
		return nil
	}
	url := "https://github.com/" + owner + "/" + name + ".git"
	// Only AXP's helper: a credential the computer's user has must not be
	// used instead of the App's.
	if _, err := git(workspace, "-c", "credential.helper=", "-c", "credential.helper="+helper, "clone", "--quiet", url, dir); err != nil {
		return err
	}
	settings := [][]string{
		{"config", "--replace-all", "credential.helper", ""},
		{"config", "--add", "credential.helper", helper},
	}
	if creds.Identity != nil {
		settings = append(settings, []string{"config", "user.name", creds.Identity.Name}, []string{"config", "user.email", creds.Identity.Email})
	}
	for _, s := range settings {
		if _, err := git(dir, s...); err != nil {
			return err
		}
	}
	if *ref != "" {
		if _, err := git(dir, "checkout", "--quiet", *ref); err != nil {
			return err
		}
	}
	if _, err := git(dir, "switch", "--quiet", "-c", branch); err != nil {
		return err
	}
	base, err := git(dir, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	if err := c.call("POST", "/remote/v1/tasks/"+id+"/checkouts", map[string]string{
		"repository": owner + "/" + name, "branch": branch, "base_commit": base, "path": dir,
	}, nil); err != nil {
		return err
	}
	fmt.Printf("已拉取 %s/%s 到 %s，分支 %s（起点 %s）。git push 和 gh 都以 AXP 的 GitHub App 身份进行。\n",
		owner, name, dir, branch, base[:12])
	return nil
}

var pullURL = regexp.MustCompile(`https://github\.com/[\w.-]+/[\w.-]+/pull/\d+`)

// ghCommand runs gh as the App; a pull request it creates is recorded as
// the task's deliverable.
func ghCommand(args []string) error {
	c, err := loadConfig()
	if err != nil {
		return err
	}
	creds, err := gitCredentials(c)
	if err != nil {
		return err
	}
	cmd := exec.Command("gh", args...)
	cmd.Env = append(os.Environ(), "GH_TOKEN="+creds.Token, "GITHUB_TOKEN="+creds.Token)
	var out bytes.Buffer
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, io.MultiWriter(os.Stdout, &out), os.Stderr
	runErr := cmd.Run()
	if len(args) >= 2 && args[0] == "pr" && args[1] == "create" {
		if url := pullURL.FindString(out.String()); url != "" {
			if id, _, err := currentTask(c); err == nil {
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
	fmt.Printf("电脑：%s（%s）\nAXP：%s\n中继：%s\n任务工作区：%s\n", c.Name, c.ComputerID, c.URL, c.RelayOrigin, c.Root)
	for _, kind := range c.kinds() {
		k := &connector{kind: kind, c: c}
		if device := k.pairedDevice(); device != "" {
			fmt.Printf("%s：已配对（设备 %s）\n", kind, device)
		} else {
			fmt.Printf("%s：等待在 AXP 中批准配对\n", kind)
		}
	}
	err = c.call("GET", "/remote/v1/git/credentials", nil, &credentials{})
	var apiErr *apiError
	if errors.As(err, &apiErr) && apiErr.Status == 401 {
		fmt.Println("AXP：这台电脑的凭据无效（已被移除？）")
	} else {
		fmt.Println("AXP：已连接", time.Now().Format(time.TimeOnly))
	}
	return nil
}
