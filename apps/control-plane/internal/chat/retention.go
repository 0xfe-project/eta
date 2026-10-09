package chat

import (
	"context"
	"time"

	"github.com/akarachen/axp/packages/service-go/pg"
)

// What the event logs keep. ui_event is what a browser replays from its
// cursor; one behind by more than ReplayLimit events, or by events no longer
// kept, gets 410 and loads a fresh snapshot instead. agent_event is the
// runtimes' raw events: item.updated rows are projected onto messages as
// they arrive and only kept a little while; the rest a month.
const (
	UIEventRetention    = 7 * 24 * time.Hour
	ItemEventRetention  = 24 * time.Hour
	AgentEventRetention = 30 * 24 * time.Hour
	ReplayLimit         = 1000
)

// Prune deletes events older than their retention. Both logs are ordered by
// the conversation's sequence, so each deletion is a range on its
// (conversation_id, seq) index: the first sequence still kept is found by
// time, and everything before it goes.
func Prune(ctx context.Context, db pg.DB, now time.Time) error {
	conversationID, err := DefaultConversationID(ctx, db)
	if err != nil || conversationID == "" {
		return err
	}
	if _, err := db.Exec(ctx, `DELETE FROM ui_event WHERE conversation_id = $1 AND seq < COALESCE(
		(SELECT seq FROM ui_event WHERE conversation_id = $1 AND created_at >= $2 ORDER BY seq LIMIT 1),
		(SELECT last_ui_event_seq + 1 FROM conversation WHERE id = $1))`,
		conversationID, now.Add(-UIEventRetention)); err != nil {
		return err
	}
	for _, cut := range []struct {
		types  []string
		before time.Time
	}{
		{[]string{"item.updated"}, now.Add(-ItemEventRetention)},
		{nil, now.Add(-AgentEventRetention)},
	} {
		if _, err := db.Exec(ctx, `DELETE FROM agent_event WHERE conversation_id = $1
			AND ($3::text[] IS NULL OR type = ANY($3)) AND seq < COALESCE(
			(SELECT seq FROM agent_event WHERE conversation_id = $1 AND created_at >= $2 ORDER BY seq LIMIT 1),
			(SELECT last_event_seq + 1 FROM conversation WHERE id = $1))`,
			conversationID, cut.before, cut.types); err != nil {
			return err
		}
	}
	return nil
}
