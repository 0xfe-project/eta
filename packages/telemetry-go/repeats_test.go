package telemetry

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestRepeatsAreLoggedWhenTheyChangeAndNowAndThen(t *testing.T) {
	var logs bytes.Buffer
	defer slog.SetDefault(slog.Default())
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	clock := time.Unix(0, 0)
	r := Repeats{now: func() time.Time { return clock }}
	ctx := context.Background()
	for _, step := range []struct {
		err   error
		after time.Duration
	}{
		{errors.New("offline"), 0},               // logged
		{errors.New("offline"), time.Minute},     // same, soon
		{errors.New("refused"), time.Minute},     // logged: changed
		{nil, time.Minute},                       // recovered
		{errors.New("refused"), time.Minute},     // logged: new again
		{errors.New("refused"), RepeatEvery - 1}, // same, not yet due
		{errors.New("refused"), time.Second},     // logged: due
	} {
		clock = clock.Add(step.after)
		r.Log(ctx, slog.LevelWarn, "a", step.err, "failed")
	}
	if got := strings.Count(logs.String(), "msg=failed"); got != 4 {
		t.Fatalf("logged %d times: %s", got, logs.String())
	}
}
