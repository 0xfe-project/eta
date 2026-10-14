package api

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strconv"

	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

// Chat attachments (internal/chat/attachments.go): the browser uploads,
// shows and drops them under /api/v1; a runtime reads its own agent's
// through the runtime gateway's /attachments.

// Shown in the page where it is safe to: raster images, and text in a
// sandbox. Everything else downloads.
var inline = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
	"text/plain": true,
}

func serveAttachment(w http.ResponseWriter, r *http.Request, a *chat.Attachment, rc io.ReadCloser) {
	defer rc.Close()
	h := w.Header()
	media, _, _ := mime.ParseMediaType(a.ContentType)
	disposition := "attachment"
	if inline[media] {
		disposition = "inline"
	}
	h.Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": a.Name}))
	h.Set("Content-Type", a.ContentType)
	h.Set("Content-Length", strconv.FormatInt(a.Size, 10))
	h.Set("Content-Security-Policy", "sandbox")
	h.Set("X-Content-Type-Options", "nosniff")
	// An attachment never changes.
	h.Set("Cache-Control", "private, max-age=86400, immutable")
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(w, rc)
}

type AttachmentPath struct {
	AttachmentID string `path:"attachment_id"`
}

func registerAttachments(api *httpapi.API, d *Deps) {
	s := d.Chat
	// The body is the file itself, streamed to storage.
	api.Router.Post("/api/v1/groups/{group_id}/attachments", func(w http.ResponseWriter, r *http.Request) {
		a, err := s.AddAttachment(r.Context(), d.DB, chi.URLParam(r, "group_id"),
			r.URL.Query().Get("name"), r.Header.Get("Content-Type"), r.ContentLength, r.Body)
		if err != nil {
			httpapi.WriteError(w, r, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(a)
	})
	api.Router.Get("/api/v1/chat/attachments/{attachment_id}", func(w http.ResponseWriter, r *http.Request) {
		a, rc, err := s.OpenAttachment(r.Context(), d.DB, chi.URLParam(r, "attachment_id"), "")
		if err != nil {
			httpapi.WriteError(w, r, err)
			return
		}
		serveAttachment(w, r, a, rc)
	})
	huma.Register(api, op("deleteAttachment", http.MethodDelete, "/api/v1/chat/attachments/{attachment_id}",
		"Drop an attachment no message carries yet", 204, "chat"),
		func(ctx context.Context, in *AttachmentPath) (*struct{}, error) {
			return nil, s.DeleteAttachment(ctx, d.DB, in.AttachmentID)
		})
}

// agentAttachment is a runtime fetching an attachment of a message to its
// agent; the runtime gateway passes on the agent whose key it checked.
func agentAttachment(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		groupID, ok := pg.ParseID(r.Header.Get("X-AXP-Group-Id"))
		if !ok {
			httpapi.WriteError(w, r, apierr.NotFound())
			return
		}
		a, rc, err := d.Chat.OpenAttachment(r.Context(), d.DB, chi.URLParam(r, "attachment_id"), groupID)
		if err != nil {
			httpapi.WriteError(w, r, err)
			return
		}
		serveAttachment(w, r, a, rc)
	}
}
