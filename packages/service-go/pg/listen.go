package pg

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

// Listen calls fn with the payload of every notification on channel
// (pg_notify), on a connection of its own, until ctx ends. It reconnects
// after a failure; notifications sent meanwhile are lost, so what they
// announce must also be found some other way (a periodic scan).
func Listen(ctx context.Context, url, channel string, fn func(payload string)) {
	for ctx.Err() == nil {
		conn, err := pgx.Connect(ctx, url)
		if err == nil {
			if _, err = conn.Exec(ctx, "LISTEN "+pgx.Identifier{channel}.Sanitize()); err == nil {
				for {
					notification, waitErr := conn.WaitForNotification(ctx)
					if waitErr != nil {
						err = waitErr
						break
					}
					fn(notification.Payload)
				}
			}
			conn.Close(context.Background())
		}
		if ctx.Err() != nil {
			return
		}
		slog.Warn("Listening for notifications failed; retrying", "channel", channel, "error", err)
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
}
