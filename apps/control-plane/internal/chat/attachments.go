package chat

import (
	"context"
	"errors"
	"io"
	"mime"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/akarachen/axp/apps/control-plane/internal/objects"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

// Attachments are files the user sends an agent with a message. The browser
// uploads each one while the message is written; the message names them in
// order among its text (Part). The runtime fetches them through the runtime
// gateway, as the agent the message went to, onto the agent's volume, and
// hands them to Codex: images as images, every file as a path to read.

const (
	// MaxAttachmentBytes is one file's limit.
	MaxAttachmentBytes = 20 << 20
	// MaxAttachments a message carries at most.
	MaxAttachments = 10
	// MaxMessageText is a message's text, all its parts together.
	MaxMessageText = 100_000
)

// Store is where attachments' bytes are (objects.S3).
type Store interface {
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error
	Get(ctx context.Context, key string) (io.ReadCloser, objects.Info, error)
	DeletePrefix(ctx context.Context, prefix string) error
}

type Attachment struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
}

type attachmentRow struct {
	ID          string     `db:"id"`
	GroupID     string     `db:"group_id"`
	Name        string     `db:"name"`
	ContentType string     `db:"content_type"`
	Size        int64      `db:"size"`
	CreatedAt   time.Time  `db:"created_at"`
	SentAt      *time.Time `db:"sent_at"`
}

func (r *attachmentRow) public() Attachment {
	return Attachment{ID: r.ID, Name: r.Name, ContentType: r.ContentType, Size: r.Size}
}

// Part is a piece of a message as the user wrote it: text, or an attachment
// where it stands among the text.
type Part struct {
	Type         string `json:"type" enum:"text,attachment"`
	Text         string `json:"text,omitempty" doc:"A text part's text, verbatim."`
	AttachmentID string `json:"attachment_id,omitempty" doc:"An attachment part's attachment, uploaded to the same group."`
}

func attachmentKey(id string) string { return "attachments/" + id }

func unavailable() error {
	return apierr.New(503, "ATTACHMENTS_UNAVAILABLE", "没有配置附件的对象存储（AXP_S3_*）。")
}

// cleanName is the file's own name, without directories or control
// characters, at most 200 bytes.
func cleanName(name string) string {
	name = path.Base(strings.ReplaceAll(name, `\`, "/"))
	name = strings.Map(func(c rune) rune {
		if c < ' ' || c == 0x7f {
			return -1
		}
		return c
	}, strings.TrimSpace(name))
	if name == "" || name == "." || name == "/" || name == ".." {
		return "file"
	}
	for len(name) > 200 {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	return name
}

// cleanType is a media type without its parameters' surprises; anything
// unparseable is plain bytes.
func cleanType(contentType string) string {
	media, params, err := mime.ParseMediaType(contentType)
	if err != nil || !strings.Contains(media, "/") {
		return "application/octet-stream"
	}
	if charset := params["charset"]; charset != "" && strings.HasPrefix(media, "text/") {
		return mime.FormatMediaType(media, map[string]string{"charset": charset})
	}
	return media
}

type counter struct {
	r io.Reader
	n int64
}

func (c *counter) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// AddAttachment stores a file for a message to the agent. size is -1 when
// unknown; r is read up to just past MaxAttachmentBytes.
func (s *Service) AddAttachment(ctx context.Context, db pg.DB, groupID, name, contentType string, size int64, r io.Reader) (*Attachment, error) {
	if s.Store == nil {
		return nil, unavailable()
	}
	if size > MaxAttachmentBytes {
		return nil, tooLarge()
	}
	id, ok := pg.ParseID(groupID)
	if !ok {
		return nil, apierr.NotFound()
	}
	if live, err := pg.Exists(ctx, db, "SELECT 1 FROM chat_group WHERE id = $1 AND NOT archived", id); err != nil {
		return nil, err
	} else if !live {
		return nil, apierr.NotFound()
	}
	row := &attachmentRow{ID: pg.NewID(), GroupID: id, Name: cleanName(name), ContentType: cleanType(contentType), CreatedAt: pg.Now()}
	body := &counter{r: io.LimitReader(r, MaxAttachmentBytes+1)}
	if err := s.Store.Put(ctx, attachmentKey(row.ID), body, size, row.ContentType); err != nil {
		return nil, apierr.Upstream("STORAGE_FAILED", "附件写入对象存储失败，请重试。")
	}
	if body.n > MaxAttachmentBytes {
		_ = s.Store.DeletePrefix(context.WithoutCancel(ctx), attachmentKey(row.ID))
		return nil, tooLarge()
	}
	row.Size = body.n
	if _, err := db.Exec(ctx, `INSERT INTO chat_attachment (id, group_id, name, content_type, size, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)`, row.ID, row.GroupID, row.Name, row.ContentType, row.Size, row.CreatedAt); err != nil {
		_ = s.Store.DeletePrefix(context.WithoutCancel(ctx), attachmentKey(row.ID))
		return nil, err
	}
	a := row.public()
	return &a, nil
}

func tooLarge() error {
	return apierr.New(413, "ATTACHMENT_TOO_LARGE", "单个附件不能超过 20 MB。")
}

// OpenAttachment is the attachment's bytes. groupID, when not empty, is the
// only agent it may belong to (a runtime reading its own).
func (s *Service) OpenAttachment(ctx context.Context, db pg.DB, id, groupID string) (*Attachment, io.ReadCloser, error) {
	if s.Store == nil {
		return nil, nil, unavailable()
	}
	row, err := findAttachment(ctx, db, id)
	if err != nil {
		return nil, nil, err
	}
	if groupID != "" && row.GroupID != groupID {
		return nil, nil, apierr.NotFound()
	}
	rc, _, err := s.Store.Get(ctx, attachmentKey(row.ID))
	if errors.Is(err, objects.ErrNotFound) {
		return nil, nil, apierr.NotFound()
	} else if err != nil {
		return nil, nil, apierr.Upstream("STORAGE_FAILED", "读取附件失败，请稍后再试。")
	}
	a := row.public()
	return &a, rc, nil
}

// DeleteAttachment drops an attachment no message carries yet: the user
// took it out of the message being written. Sent ones stay with history.
func (s *Service) DeleteAttachment(ctx context.Context, db pg.DB, id string) error {
	if s.Store == nil {
		return unavailable()
	}
	row, err := findAttachment(ctx, db, id)
	if err != nil {
		return err
	}
	if row.SentAt != nil {
		return apierr.New(409, "ATTACHMENT_SENT", "已发送的附件不能删除。")
	}
	if _, err := db.Exec(ctx, "DELETE FROM chat_attachment WHERE id = $1 AND sent_at IS NULL", row.ID); err != nil {
		return err
	}
	if err := s.Store.DeletePrefix(ctx, attachmentKey(row.ID)); err != nil {
		return apierr.Upstream("STORAGE_FAILED", "删除附件失败，请稍后再试。")
	}
	return nil
}

func findAttachment(ctx context.Context, db pg.DB, id string) (*attachmentRow, error) {
	parsed, ok := pg.ParseID(id)
	if !ok {
		return nil, apierr.NotFound()
	}
	row, err := pg.One[attachmentRow](ctx, db, "SELECT * FROM chat_attachment WHERE id = $1", parsed)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apierr.NotFound()
	}
	return row, nil
}

// content is a message's parts as blocks, and as the command's input parts
// (attachments with what the runtime needs to fetch and describe them). The
// attachments must be the agent's; they are marked sent.
func content(ctx context.Context, tx pgx.Tx, groupID string, parts []Part) ([]Block, []map[string]any, string, error) {
	blocks := []Block{}
	input := []map[string]any{}
	var text strings.Builder
	attached := 0
	for _, p := range parts {
		switch p.Type {
		case "text":
			if p.Text == "" {
				continue
			}
			text.WriteString(p.Text)
			blocks = append(blocks, textBlock(p.Text))
			input = append(input, map[string]any{"type": "text", "text": p.Text})
		case "attachment":
			attached++
			row, err := findAttachment(ctx, tx, p.AttachmentID)
			if err != nil || row.GroupID != groupID {
				return nil, nil, "", apierr.New(422, "ATTACHMENT_NOT_FOUND", "附件不存在或不属于这个群，请重新添加。")
			}
			if row.SentAt == nil {
				if _, err := tx.Exec(ctx, "UPDATE chat_attachment SET sent_at = $2 WHERE id = $1", row.ID, pg.Now()); err != nil {
					return nil, nil, "", err
				}
			}
			a := row.public()
			blocks = append(blocks, Block{ID: strings.ReplaceAll(pg.NewID(), "-", ""), Type: "attachment", Attachment: &a})
			input = append(input, map[string]any{
				"type": "attachment", "id": a.ID, "name": a.Name, "content_type": a.ContentType, "size": a.Size,
			})
		default:
			return nil, nil, "", apierr.Invalid()
		}
	}
	if attached > MaxAttachments {
		return nil, nil, "", apierr.New(422, "TOO_MANY_ATTACHMENTS", "一条消息最多带 10 个附件。")
	}
	if utf8.RuneCountInString(text.String()) > MaxMessageText {
		return nil, nil, "", apierr.New(422, "MESSAGE_TOO_LONG", "消息文本不能超过 100000 字符，更长的内容请作为文件发送。")
	}
	if attached == 0 && strings.TrimSpace(text.String()) == "" {
		return nil, nil, "", apierr.Invalid()
	}
	return blocks, input, text.String(), nil
}
