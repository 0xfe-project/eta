package telemetry

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

func TestRepeatsAreLoggedOncePerChange(t *testing.T) {
	var logs bytes.Buffer
	defer slog.SetDefault(slog.Default())
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	var r Repeats
	ctx := context.Background()
	for _, err := range []error{errors.New("offline"), errors.New("offline"), errors.New("refused"), nil, errors.New("refused")} {
		r.Log(ctx, slog.LevelWarn, "a", err, "failed")
	}
	if got := strings.Count(logs.String(), "msg=failed"); got != 3 {
		t.Fatalf("logged %d times: %s", got, logs.String())
	}
}
