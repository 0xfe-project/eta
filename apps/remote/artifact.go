package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

// Uploads take as long as the ZIP needs; the server bounds its size.
var uploadClient = &http.Client{Timeout: 10 * time.Minute}

// artifactCommand publishes a static site for the current task: a ZIP, or
// a directory zipped here. The same upload AXP's own agents use.
func artifactCommand(args []string) error {
	const usage = "usage: axp artifact upload <dir|zip> --title <title> [--artifact <id>] [--task N]"
	if len(args) == 0 || args[0] != "upload" {
		return errors.New(usage)
	}
	a, err := parseArgs(args[1:], "task", "title", "artifact")
	if err != nil {
		return err
	}
	if len(a.positional) != 1 {
		return errors.New(usage)
	}
	c, err := loadConfig()
	if err != nil {
		return err
	}
	task, err := currentTask(c, a.flags["task"])
	if err != nil {
		return err
	}
	body, err := siteZip(a.positional[0])
	if err != nil {
		return err
	}
	q := url.Values{"task": {task}}
	for _, name := range []string{"title", "artifact"} {
		if v := a.flags[name]; v != "" {
			q.Set(name, v)
		}
	}
	var out struct {
		ArtifactID string `json:"artifact_id"`
		Title      string `json:"title"`
		Version    int    `json:"version"`
		Files      int    `json:"files"`
	}
	if err := send(uploadClient, c.URL, c.Token, "POST", "/remote/v1/artifacts?"+q.Encode(), "application/zip", body, &out); err != nil {
		return err
	}
	fmt.Printf("已发布「%s」第 %d 版（%d 个文件），在任务的时间线上。\nartifact：%s（发布新版本时用 --artifact %s）\n",
		out.Title, out.Version, out.Files, out.ArtifactID, out.ArtifactID)
	return nil
}

// siteZip is the ZIP at path, or a directory's files zipped (no links;
// .git and node_modules left out).
func siteZip(path string) (io.Reader, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return os.Open(path)
	}
	if _, err := os.Stat(filepath.Join(path, "index.html")); err != nil {
		return nil, fmt.Errorf("%s 的根目录没有 index.html", path)
	}
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	err = filepath.WalkDir(path, func(file string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if file != path && (d.Name() == ".git" || d.Name() == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("不能打包符号链接或特殊文件：%s", file)
		}
		name, _ := filepath.Rel(path, file)
		f, err := w.Create(filepath.ToSlash(name))
		if err != nil {
			return err
		}
		src, err := os.Open(file)
		if err != nil {
			return err
		}
		defer src.Close()
		_, err = io.Copy(f, src)
		return err
	})
	if err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return &buf, nil
}
