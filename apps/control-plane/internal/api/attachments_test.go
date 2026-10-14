package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/chat"
)

// attach uploads a file for a message to the agent.
func (c *controlEnv) attach(agentID, name, contentType, data string) chat.Attachment {
	c.t.Helper()
	r := do(c.t, c.public, http.MethodPost, "/api/v1/groups/"+c.direct(agentID)+"/attachments?name="+name, data,
		map[string]string{"Content-Type": contentType})
	if r.status != 201 {
		c.t.Fatalf("attach: %d %s", r.status, r.body)
	}
	var a chat.Attachment
	r.json(c.t, &a)
	return a
}

func newAttachmentEnv(t *testing.T) (*controlEnv, *memStore) {
	c := newControl(t)
	store := &memStore{objects: map[string]stored{}}
	c.chat.Store = store
	return c, store
}

func TestAMessageCarriesAttachmentsAmongItsText(t *testing.T) {
	c, store := newAttachmentEnv(t)
	shot := c.attach(c.agent.ID, "../shot.png", "image/png", "PNG")
	data := c.attach(c.agent.ID, "data.csv", "text/csv; charset=utf-8", "a,b\n")
	expect(t, shot.Name, "shot.png") // no directories
	expect(t, shot.Size, int64(3))
	expect(t, data.ContentType, "text/csv; charset=utf-8")
	expect(t, store.keys("attachments/"), 2)

	long := strings.Repeat("日志\n", 20_000)
	r := c.post("/chat/messages", map[string]any{"group_id": c.direct(c.agent.ID), "parts": []map[string]any{
		{"type": "text", "text": "看图："},
		{"type": "attachment", "attachment_id": shot.ID},
		{"type": "text", "text": long},
		{"type": "attachment", "attachment_id": data.ID},
	}})
	expect(t, r.status, 202)
	var sent chat.Sent
	r.json(t, &sent)
	blocks := sent.Message.Blocks
	expect(t, len(blocks), 4)
	expect(t, blocks[0].Text, "看图：")
	expect(t, blocks[1].Attachment.ID, shot.ID)
	expect(t, blocks[2].Text, long)
	expect(t, blocks[3].Attachment.Name, "data.csv")

	// The runtime gets the parts in order, attachments with what it needs.
	c.wake()
	c.boot()
	body := c.runtimes.called("/prompt")[0]
	expect(t, strings.HasSuffix(body["text"].(string), "\n看图："+long), true)
	parts := body["parts"].([]any)[1:] // after the group header
	expect(t, len(parts), 4)
	expect(t, parts[1].(map[string]any)["id"], any(shot.ID))
	expect(t, parts[1].(map[string]any)["content_type"], any("image/png"))
	expect(t, parts[2].(map[string]any)["text"], any(long))

	// Sent: it stays with history.
	status, code := c.delete("/chat/attachments/" + shot.ID).error()
	expect(t, status, 409)
	expect(t, code, "ATTACHMENT_SENT")
}

func TestARuntimeReadsOnlyItsOwnAgentsAttachments(t *testing.T) {
	c, _ := newAttachmentEnv(t)
	other := c.createAgent("另一个")
	a := c.attach(c.agent.ID, "notes.txt", "text/plain", "hello")
	own := do(t, c.internal, http.MethodGet, "/attachments/v1/"+a.ID, nil, map[string]string{"X-AXP-Group-Id": c.direct(c.agent.ID)})
	expect(t, own.status, 200)
	expect(t, string(own.body), "hello")
	expect(t, own.header.Get("X-Content-Type-Options"), "nosniff")
	theirs := do(t, c.internal, http.MethodGet, "/attachments/v1/"+a.ID, nil, map[string]string{"X-AXP-Group-Id": c.direct(other.ID)})
	expect(t, theirs.status, 404)
	none := do(t, c.internal, http.MethodGet, "/attachments/v1/"+a.ID, nil, nil)
	expect(t, none.status, 404)

	// Nor can a message to another agent carry it.
	r := c.post("/chat/messages", map[string]any{"group_id": c.direct(other.ID), "parts": []map[string]any{
		{"type": "attachment", "attachment_id": a.ID},
	}})
	status, code := r.error()
	expect(t, status, 422)
	expect(t, code, "ATTACHMENT_NOT_FOUND")
}

func TestTheBrowserShowsDownloadsAndDropsAttachments(t *testing.T) {
	c, store := newAttachmentEnv(t)
	img := c.attach(c.agent.ID, "a.png", "image/png", "PNG")
	page := c.attach(c.agent.ID, "x.html", "text/html", "<script>alert(1)</script>")
	r := c.get("/chat/attachments/" + img.ID)
	expect(t, r.status, 200)
	expect(t, r.header.Get("Content-Disposition"), `inline; filename=a.png`)
	r = c.get("/chat/attachments/" + page.ID)
	expect(t, r.header.Get("Content-Disposition"), `attachment; filename=x.html`)
	expect(t, r.header.Get("Content-Security-Policy"), "sandbox")

	expect(t, c.delete("/chat/attachments/"+page.ID).status, 204)
	expect(t, c.get("/chat/attachments/"+page.ID).status, 404)
	expect(t, store.keys("attachments/"), 1)
}

func TestAttachmentLimits(t *testing.T) {
	c, store := newAttachmentEnv(t)
	r := do(t, c.public, http.MethodPost, "/api/v1/groups/"+c.direct(c.agent.ID)+"/attachments?name=big.bin",
		strings.Repeat("x", chat.MaxAttachmentBytes+1), map[string]string{"Content-Type": "application/octet-stream"})
	status, code := r.error()
	expect(t, status, 413)
	expect(t, code, "ATTACHMENT_TOO_LARGE")
	expect(t, store.keys("attachments/"), 0)

	parts := []map[string]any{}
	for range chat.MaxAttachments + 1 {
		parts = append(parts, map[string]any{"type": "attachment", "attachment_id": c.attach(c.agent.ID, "f.txt", "text/plain", "x").ID})
	}
	status, code = c.post("/chat/messages", map[string]any{"group_id": c.direct(c.agent.ID), "parts": parts}).error()
	expect(t, status, 422)
	expect(t, code, "TOO_MANY_ATTACHMENTS")

	// Text and parts at once, or nothing to send, are refused.
	expect(t, c.post("/chat/messages", map[string]any{"group_id": c.direct(c.agent.ID), "text": "hi", "parts": parts[:1]}).status, 422)
	expect(t, c.post("/chat/messages", map[string]any{"group_id": c.direct(c.agent.ID), "parts": []map[string]any{{"type": "text", "text": "  "}}}).status, 422)
}

func TestAttachmentsNeedStorage(t *testing.T) {
	c := newControl(t)
	r := do(t, c.public, http.MethodPost, "/api/v1/groups/"+c.direct(c.agent.ID)+"/attachments?name=a.txt", "x", map[string]string{"Content-Type": "text/plain"})
	status, code := r.error()
	expect(t, status, 503)
	expect(t, code, "ATTACHMENTS_UNAVAILABLE")
}
