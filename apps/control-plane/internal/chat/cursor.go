package chat

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strconv"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/apierr"
)

// Cursors are opaque and signed: "<sequence>.<signature>". Event cursors hold
// a ui_event sequence of the default conversation, so a cursor issued before
// the conversation exists (sequence 0) stays valid after it is created.
// History cursors hold a message sequence.
type Cursors struct{ Secret []byte }

const (
	eventCursor   = "chat.event-cursor"
	historyCursor = "chat.history-cursor"
)

func (c Cursors) sign(kind string, seq int64) string {
	mac := hmac.New(sha256.New, c.Secret)
	mac.Write([]byte(kind + ":" + strconv.FormatInt(seq, 10)))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:16])
}

func (c Cursors) encode(kind string, seq int64) string {
	return strconv.FormatInt(seq, 10) + "." + c.sign(kind, seq)
}

func (c Cursors) decode(kind, cursor string) (int64, error) {
	invalid := apierr.New(400, "INVALID_CURSOR", "游标无效。")
	value, signature, ok := strings.Cut(cursor, ".")
	if !ok {
		return 0, invalid
	}
	seq, err := strconv.ParseInt(value, 10, 64)
	if err != nil || seq < 0 || strconv.FormatInt(seq, 10) != value {
		return 0, invalid
	}
	if !hmac.Equal([]byte(signature), []byte(c.sign(kind, seq))) {
		return 0, invalid
	}
	return seq, nil
}

func (c Cursors) Event(seq int64) string                     { return c.encode(eventCursor, seq) }
func (c Cursors) DecodeEvent(cursor string) (int64, error)   { return c.decode(eventCursor, cursor) }
func (c Cursors) History(seq int64) string                   { return c.encode(historyCursor, seq) }
func (c Cursors) DecodeHistory(cursor string) (int64, error) { return c.decode(historyCursor, cursor) }
