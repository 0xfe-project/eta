package telemetry

import (
	"bufio"
	"context"
	"log/slog"
	"os"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// RedirectStdout routes what the process writes to os.Stdout through logger,
// one record per line. It is for libraries that print or log there on their
// own (the llm-gateway's embedded CLIProxyAPI). Their level, request id and
// source are kept when a line uses CLIProxyAPI's or logrus's text format;
// other lines are logged at info. Its access lines are leveled by status; a
// successful GET of a quiet path (a path.Match pattern: health checks, the
// web's polling) is not logged. The returned function restores os.Stdout
// and waits for the remaining lines; call it before the Setup shutdown.
func RedirectStdout(logger *slog.Logger, quiet ...string) (restore func(), err error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	original := os.Stdout
	os.Stdout = w
	done := make(chan struct{})
	go func() {
		defer close(done)
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 64<<10), 1<<20)
		for scanner.Scan() {
			if line := strings.TrimSpace(scanner.Text()); line != "" {
				level, message, attrs := parseLine(line, quiet)
				logger.LogAttrs(context.Background(), level, message, attrs...)
			}
		}
	}()
	return func() {
		os.Stdout = original
		_ = w.Close()
		<-done
		_ = r.Close()
	}, nil
}

var (
	// [2006-01-02 15:04:05] [request-id] [info ] [file.go:12] message
	cliproxyLine = regexp.MustCompile(`^\[[^\]]*\] \[([^\]]*)\] \[(\w+)\s*\] (?:\[([^\]]+:\d+)\] )?(.*)$`)
	// time="..." level=info msg="message"
	logrusLine = regexp.MustCompile(`level=(\w+) msg=("(?:[^"\\]|\\.)*"|\S+)`)
	// 200 |   12ms |  127.0.0.1 | GET     "/v1/models"
	accessLine = regexp.MustCompile(`^(\d{3}) \|[^|]*\|(?:[^|]*\| (\w+)\s+"([^"?]*))?`)
)

func parseLine(line string, quiet []string) (slog.Level, string, []slog.Attr) {
	level, message, attrs := parseFormat(line)
	if a := accessLine.FindStringSubmatch(message); a != nil {
		level = accessLevel(a[1], a[2], a[3], quiet)
	}
	return level, message, attrs
}

func parseFormat(line string) (slog.Level, string, []slog.Attr) {
	if m := cliproxyLine.FindStringSubmatch(line); m != nil {
		var attrs []slog.Attr
		if id := m[1]; id != "" && strings.Trim(id, "-") != "" {
			attrs = append(attrs, slog.String("request_id", id))
		}
		if m[3] != "" {
			attrs = append(attrs, slog.String("source", m[3]))
		}
		return parseLevel(m[2]), m[4], attrs
	}
	if m := logrusLine.FindStringSubmatch(line); m != nil {
		message := m[2]
		if unquoted, err := strconv.Unquote(message); err == nil {
			message = unquoted
		}
		return parseLevel(m[1]), message, nil
	}
	return slog.LevelInfo, line, nil
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "trace", "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error", "fatal", "panic":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// accessLevel is an access line's level: error for a server error, warn for
// a client error, debug (dropped) for a successful GET of a quiet path, info
// otherwise.
func accessLevel(status, method, target string, quiet []string) slog.Level {
	switch {
	case status >= "500":
		return slog.LevelError
	case status >= "400":
		return slog.LevelWarn
	case method == "GET" && slices.ContainsFunc(quiet, func(p string) bool { ok, _ := path.Match(p, target); return ok }):
		return slog.LevelDebug
	default:
		return slog.LevelInfo
	}
}
