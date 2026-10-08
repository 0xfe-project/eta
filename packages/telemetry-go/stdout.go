package telemetry

import (
	"bufio"
	"context"
	"log/slog"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// RedirectStdout routes what the process writes to os.Stdout through logger,
// one record per line. It is for libraries that print or log there on their
// own (the llm-gateway's embedded CLIProxyAPI). Their level, request id and
// source are kept when a line uses CLIProxyAPI's or logrus's text format;
// other lines are logged at info. The returned function restores os.Stdout
// and waits for the remaining lines; call it before the Setup shutdown.
func RedirectStdout(logger *slog.Logger) (restore func(), err error) {
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
				level, message, attrs := parseLine(line)
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
)

func parseLine(line string) (slog.Level, string, []slog.Attr) {
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
