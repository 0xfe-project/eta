// Package artifacts is static sites agents publish (docs/architecture/
// artifacts.md): an AXP agent or a remote computer's agent uploads a ZIP
// with an index.html at its root; each upload is a new, immutable version
// of an artifact. The database holds artifacts, versions and public
// shares; the store holds each version's ZIP and its files under
// artifacts/<artifact>/<version>/.
package artifacts

import (
	"archive/zip"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/objects"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/jsontime"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store is where versions' objects are (objects.S3).
type Store interface {
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error
	Get(ctx context.Context, key string) (io.ReadCloser, objects.Info, error)
	DeletePrefix(ctx context.Context, prefix string) error
}

// PreviewTTL is how long a private preview's address works.
const PreviewTTL = time.Hour

// A version still processing after this was left by a process that died
// while storing it.
const staleProcessing = time.Hour

type Service struct {
	DB *pgxpool.Pool
	// Nil when no S3 is configured: artifacts are off.
	Store  Store
	Tasks  *tasks.Service
	Secret []byte
	Limits Limits
}

// Uploader is who publishes: an AXP agent (through the runtime gateway) or
// a remote computer's agent (with the computer's token).
type Uploader struct {
	AgentID  string
	Computer *tasks.RemoteComputer
}

type UploadInput struct {
	// The artifact's title; a new version keeps the current one when empty.
	Title string
	// The task to put it on (number or id).
	Task string
	// The artifact this is a new version of; a new artifact when empty.
	Artifact string
}

// Published is the version an upload made.
type Published struct {
	ArtifactID string  `json:"artifact_id"`
	Title      string  `json:"title"`
	Version    int     `json:"version"`
	Files      int     `json:"files"`
	Bytes      int64   `json:"bytes"`
	TaskID     *string `json:"task_id,omitempty"`
}

type Artifact struct {
	ID           string            `json:"id"`
	Title        string            `json:"title"`
	AgentID      *string           `json:"agent_id" nullable:"true" doc:"The AXP agent that publishes it, in its chat."`
	AgentName    *string           `json:"agent_name" nullable:"true"`
	ComputerName *string           `json:"computer_name" nullable:"true" doc:"The remote computer whose agent publishes it."`
	TaskID       *string           `json:"task_id" nullable:"true"`
	TaskNumber   *int64            `json:"task_number" nullable:"true"`
	CreatedAt    jsontime.Time     `json:"created_at"`
	UpdatedAt    jsontime.Time     `json:"updated_at"`
	Versions     []ArtifactVersion `json:"versions" doc:"Its published versions, newest first."`
}

type ArtifactVersion struct {
	Number    int           `json:"number"`
	Files     int           `json:"files"`
	Bytes     int64         `json:"bytes" doc:"The files' total size."`
	Size      int64         `json:"size" doc:"The ZIP's size."`
	CreatedAt jsontime.Time `json:"created_at"`
	// A capability for the sandboxed preview, which sends no cookies.
	PreviewURL string         `json:"preview_url" doc:"Its files for the browser to show in a sandbox, valid for an hour (PreviewTTL); index.html is the page."`
	Share      *ArtifactShare `json:"share,omitempty" doc:"Its public link, while shared."`
}

type ArtifactShare struct {
	URL       string        `json:"url" doc:"The public page's path on AXP's address."`
	CreatedAt jsontime.Time `json:"created_at"`
}

// --- upload ---------------------------------------------------------------------

func unavailable() error {
	return apierr.New(503, "ARTIFACTS_UNAVAILABLE", "没有配置 Artifact 的对象存储（AXP_S3_*）。")
}

type artifactRow struct {
	ID         string  `db:"id"`
	Title      string  `db:"title"`
	AgentID    *string `db:"agent_id"`
	ComputerID *string `db:"computer_id"`
	TaskID     *string `db:"task_id"`
}

func (by Uploader) owns(a *artifactRow) bool {
	if by.Computer != nil {
		return a.ComputerID != nil && *a.ComputerID == by.Computer.ID
	}
	return a.AgentID != nil && *a.AgentID == by.AgentID
}

// Upload stores a ZIP as a new version, then publishes it. Nothing is
// stored for a ZIP that is not a valid site; a version whose objects fail
// to store is marked failed and its objects are removed.
func (s *Service) Upload(ctx context.Context, by Uploader, in UploadInput, body io.Reader) (*Published, error) {
	if s.Store == nil {
		return nil, unavailable()
	}
	s.sweep(ctx)
	title := strings.TrimSpace(in.Title)
	if len([]rune(title)) > 200 {
		return nil, apierr.New(422, "VALIDATION_ERROR", "标题最多 200 个字。")
	}
	var existing *artifactRow
	if in.Artifact != "" {
		id, ok := pg.ParseID(in.Artifact)
		if !ok {
			return nil, apierr.NotFound()
		}
		a, err := pg.One[artifactRow](ctx, s.DB, "SELECT id, title, agent_id, computer_id, task_id FROM artifact WHERE id = $1", id)
		if err != nil {
			return nil, err
		}
		if a == nil {
			return nil, apierr.NotFound()
		}
		if !by.owns(a) {
			return nil, apierr.New(403, "NOT_YOURS", "只能给自己发布的 Artifact 发布新版本。")
		}
		existing = a
		if in.Task == "" && a.TaskID != nil {
			in.Task = *a.TaskID
		}
	} else if title == "" {
		return nil, apierr.New(422, "VALIDATION_ERROR", "新的 Artifact 需要标题。")
	}
	var taskID *string
	if in.Task != "" {
		id, err := tasks.ArtifactTask(ctx, s.DB, by.Computer, in.Task)
		if err != nil {
			return nil, err
		}
		taskID = &id
	} else if by.Computer != nil {
		return nil, apierr.New(422, "VALIDATION_ERROR", "远程电脑上的智能体要把 Artifact 发布到任务上（--task）。")
	}

	archive, size, sum, err := spool(body, s.Limits.Archive)
	if err != nil {
		return nil, err
	}
	defer func() { _ = archive.Close(); _ = os.Remove(archive.Name()) }()
	zr, err := zip.NewReader(archive, size)
	if err != nil {
		return nil, invalidZip("不是有效的 ZIP 文件")
	}
	files, total, err := siteFiles(zr, s.Limits)
	if err != nil {
		return nil, err
	}

	v, err := pg.InTxValue(ctx, s.DB, func(tx pgx.Tx) (*versionRow, error) {
		return s.newVersion(ctx, tx, by, existing, title, taskID, size, sum, len(files), total)
	})
	if err != nil {
		return nil, err
	}
	prefix := versionPrefix(v.ArtifactID, v.ID)
	fail := func(cause error) error {
		// The request may be gone; clean up anyway.
		ctx := context.WithoutCancel(ctx)
		message := "保存文件失败"
		var product *apierr.Error
		if errors.As(cause, &product) {
			message = product.Message
		}
		if err := s.Store.DeletePrefix(ctx, prefix); err != nil {
			slog.Warn("Cannot remove a failed artifact version's objects", "version", v.ID, "error", err)
		}
		if _, err := s.DB.Exec(ctx, "UPDATE artifact_version SET status = 'failed', error = $2 WHERE id = $1", v.ID, message); err != nil {
			slog.Warn("Cannot mark an artifact version failed", "version", v.ID, "error", err)
		}
		if product != nil {
			return product
		}
		slog.Warn("Storing an artifact version failed", "version", v.ID, "error", cause)
		return apierr.Upstream("STORAGE_FAILED", "Artifact 的对象存储写入失败，请稍后再试。")
	}
	if err := s.storeFiles(ctx, prefix, files); err != nil {
		return nil, fail(err)
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return nil, fail(err)
	}
	if err := s.Store.Put(ctx, prefix+"archive.zip", archive, size, "application/zip"); err != nil {
		return nil, fail(err)
	}
	out := &Published{ArtifactID: v.ArtifactID, Title: v.Title, Version: v.Number, Files: len(files), Bytes: total, TaskID: taskID}
	err = pg.InTx(ctx, s.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "UPDATE artifact_version SET status = 'published' WHERE id = $1", v.ID); err != nil {
			return err
		}
		if taskID == nil {
			return nil
		}
		return s.Tasks.RecordArtifact(ctx, tx, *taskID, by.AgentID, by.Computer, map[string]any{
			"artifact_id": v.ArtifactID, "title": v.Title, "version": v.Number,
		})
	})
	if err != nil {
		return nil, fail(err)
	}
	return out, nil
}

type versionRow struct {
	ID         string
	ArtifactID string
	Title      string
	Number     int
}

func (s *Service) newVersion(ctx context.Context, tx pgx.Tx, by Uploader, existing *artifactRow, title string,
	taskID *string, size int64, sum string, files int, bytes int64,
) (*versionRow, error) {
	now := pg.Now()
	v := &versionRow{ID: pg.NewID(), Title: title}
	if existing == nil {
		v.ArtifactID = pg.NewID()
		var agent, computer *string
		if by.Computer != nil {
			computer = &by.Computer.ID
		} else {
			agent = &by.AgentID
		}
		if _, err := tx.Exec(ctx, `INSERT INTO artifact (id, title, agent_id, computer_id, task_id, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $6)`, v.ArtifactID, title, agent, computer, taskID, now); err != nil {
			return nil, err
		}
	} else {
		v.ArtifactID = existing.ID
		// Locked, so concurrent uploads number their versions one by one.
		err := tx.QueryRow(ctx, `UPDATE artifact SET title = COALESCE(NULLIF($2, ''), title),
			task_id = COALESCE($3, task_id), updated_at = $4 WHERE id = $1 RETURNING title`,
			existing.ID, title, taskID, now).Scan(&v.Title)
		if err != nil {
			return nil, err
		}
	}
	if err := tx.QueryRow(ctx, "SELECT COALESCE(max(number), 0) + 1 FROM artifact_version WHERE artifact_id = $1",
		v.ArtifactID).Scan(&v.Number); err != nil {
		return nil, err
	}
	_, err := tx.Exec(ctx, `INSERT INTO artifact_version (id, artifact_id, number, status, size, sha256, files, bytes, created_at)
		VALUES ($1, $2, $3, 'processing', $4, $5, $6, $7, $8)`, v.ID, v.ArtifactID, v.Number, size, sum, files, bytes, now)
	return v, err
}

// spool writes the request's body to a temporary file (a ZIP is read from
// its end), with its size and sha256; over limit bytes is 413.
func spool(body io.Reader, limit int64) (*os.File, int64, string, error) {
	f, err := os.CreateTemp("", "axp-artifact-*.zip")
	if err != nil {
		return nil, 0, "", err
	}
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, hash), io.LimitReader(body, limit+1))
	if err == nil && n > limit {
		err = apierr.New(413, "PAYLOAD_TOO_LARGE", fmt.Sprintf("ZIP 超过 %d MiB。", limit>>20))
	}
	if err == nil && n == 0 {
		err = invalidZip("请求里没有 ZIP")
	}
	if err != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return nil, 0, "", err
	}
	return f, n, hex.EncodeToString(hash.Sum(nil)), nil
}

func (s *Service) storeFiles(ctx context.Context, prefix string, files []file) error {
	for _, f := range files {
		rc, err := f.entry.Open()
		if err != nil {
			return invalidZip("无法读取 %s：%v", f.name, err)
		}
		r := &readErr{r: rc}
		err = s.Store.Put(ctx, prefix+"files/"+f.name, r, int64(f.entry.UncompressedSize64), contentType(f.name))
		_ = rc.Close()
		if r.err != nil {
			// The entry's bytes, not the store: a corrupt or lying ZIP.
			return invalidZip("无法读取 %s：%v", f.name, r.err)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// readErr keeps the error reading the entry failed with, if any.
type readErr struct {
	r   io.Reader
	err error
}

func (r *readErr) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	if err != nil && err != io.EOF {
		r.err = err
	}
	return n, err
}

func contentType(name string) string {
	if t := mime.TypeByExtension(path.Ext(name)); t != "" {
		return t
	}
	return "application/octet-stream"
}

func versionPrefix(artifactID, versionID string) string {
	return "artifacts/" + artifactID + "/" + versionID + "/"
}

// sweep fails versions a dead process left processing, and removes what
// it had stored of them.
func (s *Service) sweep(ctx context.Context) {
	rows, err := pg.All[struct {
		ID         string `db:"id"`
		ArtifactID string `db:"artifact_id"`
	}](ctx, s.DB, `UPDATE artifact_version SET status = 'failed', error = '上传中断'
		WHERE status = 'processing' AND created_at < $1 RETURNING id, artifact_id`, pg.Now().Add(-staleProcessing))
	if err != nil {
		slog.Warn("Cannot sweep artifact versions", "error", err)
		return
	}
	for _, v := range rows {
		if err := s.Store.DeletePrefix(ctx, versionPrefix(v.ArtifactID, v.ID)); err != nil {
			slog.Warn("Cannot remove an interrupted artifact version's objects", "version", v.ID, "error", err)
		}
	}
}

// --- reading and managing ----------------------------------------------------------

const artifactSelect = `SELECT a.id, a.title, a.agent_id, ag.name AS agent_name, c.name AS computer_name,
	a.task_id, t.number AS task_number, a.created_at, a.updated_at
	FROM artifact a LEFT JOIN agent ag ON ag.id = a.agent_id LEFT JOIN computer c ON c.id = a.computer_id
	LEFT JOIN task t ON t.id = a.task_id`

type listRow struct {
	ID           string    `db:"id"`
	Title        string    `db:"title"`
	AgentID      *string   `db:"agent_id"`
	AgentName    *string   `db:"agent_name"`
	ComputerName *string   `db:"computer_name"`
	TaskID       *string   `db:"task_id"`
	TaskNumber   *int64    `db:"task_number"`
	CreatedAt    time.Time `db:"created_at"`
	UpdatedAt    time.Time `db:"updated_at"`
}

type versionListRow struct {
	ID         string     `db:"id"`
	ArtifactID string     `db:"artifact_id"`
	Number     int        `db:"number"`
	Files      int        `db:"files"`
	Bytes      int64      `db:"bytes"`
	Size       int64      `db:"size"`
	CreatedAt  time.Time  `db:"created_at"`
	ShareToken *string    `db:"share_token"`
	SharedAt   *time.Time `db:"shared_at"`
}

// List is the artifacts with a published version, most recently updated
// first; only a task's when taskID is set.
func (s *Service) List(ctx context.Context, taskID string) ([]Artifact, error) {
	where, args := " WHERE EXISTS (SELECT 1 FROM artifact_version v WHERE v.artifact_id = a.id AND v.status = 'published')", []any{}
	if taskID != "" {
		id, ok := pg.ParseID(taskID)
		if !ok {
			return []Artifact{}, nil
		}
		where, args = where+" AND a.task_id = $1", append(args, id)
	}
	rows, err := pg.All[listRow](ctx, s.DB, artifactSelect+where+" ORDER BY a.updated_at DESC", args...)
	if err != nil {
		return nil, err
	}
	return s.withVersions(ctx, rows)
}

// Get is one artifact with its published versions.
func (s *Service) Get(ctx context.Context, id string) (*Artifact, error) {
	parsed, ok := pg.ParseID(id)
	if !ok {
		return nil, apierr.NotFound()
	}
	row, err := pg.One[listRow](ctx, s.DB, artifactSelect+" WHERE a.id = $1", parsed)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apierr.NotFound()
	}
	out, err := s.withVersions(ctx, []*listRow{row})
	if err != nil {
		return nil, err
	}
	if len(out[0].Versions) == 0 {
		return nil, apierr.NotFound()
	}
	return &out[0], nil
}

func (s *Service) withVersions(ctx context.Context, rows []*listRow) ([]Artifact, error) {
	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	versions, err := pg.All[versionListRow](ctx, s.DB, `SELECT v.id, v.artifact_id, v.number, v.files, v.bytes, v.size,
		v.created_at, sh.token AS share_token, sh.created_at AS shared_at
		FROM artifact_version v LEFT JOIN artifact_share sh ON sh.version_id = v.id AND sh.revoked_at IS NULL
		WHERE v.artifact_id = ANY($1) AND v.status = 'published' ORDER BY v.number DESC`, ids)
	if err != nil {
		return nil, err
	}
	byArtifact := map[string][]ArtifactVersion{}
	now := time.Now()
	for _, v := range versions {
		out := ArtifactVersion{
			Number: v.Number, Files: v.Files, Bytes: v.Bytes, Size: v.Size, CreatedAt: jsontime.From(v.CreatedAt),
			PreviewURL: s.PreviewPath(v.ID, now),
		}
		if v.ShareToken != nil {
			out.Share = &ArtifactShare{URL: SharePath(*v.ShareToken), CreatedAt: jsontime.From(*v.SharedAt)}
		}
		byArtifact[v.ArtifactID] = append(byArtifact[v.ArtifactID], out)
	}
	out := make([]Artifact, 0, len(rows))
	for _, r := range rows {
		vs := byArtifact[r.ID]
		if vs == nil {
			vs = []ArtifactVersion{}
		}
		out = append(out, Artifact{
			ID: r.ID, Title: r.Title, AgentID: r.AgentID, AgentName: r.AgentName, ComputerName: r.ComputerName,
			TaskID: r.TaskID, TaskNumber: r.TaskNumber, CreatedAt: jsontime.From(r.CreatedAt),
			UpdatedAt: jsontime.From(r.UpdatedAt), Versions: vs,
		})
	}
	return out, nil
}

// version is the id of an artifact's published version.
func (s *Service) version(ctx context.Context, db pg.DB, artifactID string, number int) (string, error) {
	parsed, ok := pg.ParseID(artifactID)
	if !ok {
		return "", apierr.NotFound()
	}
	var id string
	err := db.QueryRow(ctx, `SELECT id FROM artifact_version WHERE artifact_id = $1 AND number = $2
		AND status = 'published'`, parsed, number).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", apierr.NotFound()
	}
	return id, err
}

// ShareVersion makes a version public, or keeps its current link.
func (s *Service) ShareVersion(ctx context.Context, artifactID string, number int) (*ArtifactShare, error) {
	return pg.InTxValue(ctx, s.DB, func(tx pgx.Tx) (*ArtifactShare, error) {
		versionID, err := s.version(ctx, tx, artifactID, number)
		if err != nil {
			return nil, err
		}
		// One version's shares serialize on the version.
		if _, err := tx.Exec(ctx, "SELECT 1 FROM artifact_version WHERE id = $1 FOR UPDATE", versionID); err != nil {
			return nil, err
		}
		var token string
		var at time.Time
		err = tx.QueryRow(ctx, `SELECT token, created_at FROM artifact_share WHERE version_id = $1 AND revoked_at IS NULL`,
			versionID).Scan(&token, &at)
		if errors.Is(err, pgx.ErrNoRows) {
			token, at = newToken(), pg.Now()
			_, err = tx.Exec(ctx, "INSERT INTO artifact_share (token, version_id, created_at) VALUES ($1, $2, $3)", token, versionID, at)
		}
		if err != nil {
			return nil, err
		}
		return &ArtifactShare{URL: SharePath(token), CreatedAt: jsontime.From(at)}, nil
	})
}

// RevokeShare ends a version's public link; it never works again.
func (s *Service) RevokeShare(ctx context.Context, artifactID string, number int) error {
	versionID, err := s.version(ctx, s.DB, artifactID, number)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(ctx, "UPDATE artifact_share SET revoked_at = $2 WHERE version_id = $1 AND revoked_at IS NULL", versionID, pg.Now())
	return err
}

// Delete removes an artifact, its versions, shares and objects.
func (s *Service) Delete(ctx context.Context, artifactID string) error {
	parsed, ok := pg.ParseID(artifactID)
	if !ok {
		return apierr.NotFound()
	}
	if s.Store == nil {
		return unavailable()
	}
	exists, err := pg.Exists(ctx, s.DB, "SELECT 1 FROM artifact WHERE id = $1", parsed)
	if err != nil {
		return err
	}
	if !exists {
		return apierr.NotFound()
	}
	// Objects first: a failure leaves the rows to delete again.
	if err := s.Store.DeletePrefix(ctx, "artifacts/"+parsed+"/"); err != nil {
		slog.Warn("Cannot delete an artifact's objects", "artifact", parsed, "error", err)
		return apierr.Upstream("STORAGE_FAILED", "Artifact 的对象存储删除失败，请稍后再试。")
	}
	_, err = s.DB.Exec(ctx, "DELETE FROM artifact WHERE id = $1", parsed)
	return err
}

// --- serving ---------------------------------------------------------------------

// Served is a version as its pages serve it.
type Served struct {
	VersionID  string `db:"id"`
	ArtifactID string `db:"artifact_id"`
	Number     int    `db:"number"`
	Title      string `db:"title"`
}

const servedSelect = `SELECT v.id, v.artifact_id, v.number, a.title FROM artifact_version v
	JOIN artifact a ON a.id = v.artifact_id`

// Shared is the version a public link names, while it is shared.
func (s *Service) Shared(ctx context.Context, token string) (*Served, error) {
	if !validToken(token) {
		return nil, apierr.NotFound()
	}
	return s.served(ctx, servedSelect+` JOIN artifact_share sh ON sh.version_id = v.id
		WHERE sh.token = $1 AND sh.revoked_at IS NULL AND v.status = 'published'`, token)
}

// Previewed is the version a preview capability names, until it expires.
func (s *Service) Previewed(ctx context.Context, capability string) (*Served, error) {
	versionID, ok := s.checkPreview(capability, time.Now())
	if !ok {
		return nil, apierr.NotFound()
	}
	return s.served(ctx, servedSelect+" WHERE v.id = $1 AND v.status = 'published'", versionID)
}

// Archived is a published version, by its artifact and number.
func (s *Service) Archived(ctx context.Context, artifactID string, number int) (*Served, error) {
	parsed, ok := pg.ParseID(artifactID)
	if !ok {
		return nil, apierr.NotFound()
	}
	return s.served(ctx, servedSelect+" WHERE v.artifact_id = $1 AND v.number = $2 AND v.status = 'published'", parsed, number)
}

func (s *Service) served(ctx context.Context, sql string, args ...any) (*Served, error) {
	if s.Store == nil {
		return nil, unavailable()
	}
	v, err := pg.One[Served](ctx, s.DB, sql, args...)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, apierr.NotFound()
	}
	return v, nil
}

// File is one of a version's files: name is its path under the site's
// root, a directory's ("" or ending in "/") being its index.html.
func (s *Service) File(ctx context.Context, v *Served, name string) (io.ReadCloser, objects.Info, error) {
	if name == "" || strings.HasSuffix(name, "/") {
		name += "index.html"
	}
	if checkPath(name) != nil {
		return nil, objects.Info{}, apierr.NotFound()
	}
	return s.object(ctx, versionPrefix(v.ArtifactID, v.VersionID)+"files/"+name)
}

// Archive is the ZIP a version was uploaded as.
func (s *Service) Archive(ctx context.Context, v *Served) (io.ReadCloser, objects.Info, error) {
	return s.object(ctx, versionPrefix(v.ArtifactID, v.VersionID)+"archive.zip")
}

func (s *Service) object(ctx context.Context, key string) (io.ReadCloser, objects.Info, error) {
	rc, info, err := s.Store.Get(ctx, key)
	if errors.Is(err, objects.ErrNotFound) {
		return nil, info, apierr.NotFound()
	}
	if err != nil {
		slog.Warn("Cannot read an artifact's object", "key", key, "error", err)
		return nil, info, apierr.Upstream("STORAGE_FAILED", "Artifact 的对象存储读取失败，请稍后再试。")
	}
	return rc, info, nil
}

// --- addresses -------------------------------------------------------------------

// SharePrefix and PreviewPrefix are the only paths outside the edge's
// access control besides /remote (docs/architecture/artifacts.md).
const (
	SharePrefix   = "/share/artifacts/"
	PreviewPrefix = "/preview/artifacts/"
)

func SharePath(token string) string { return SharePrefix + token + "/" }

// newToken is a share's token: 256 random bits.
func newToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func validToken(token string) bool {
	b, err := base64.RawURLEncoding.DecodeString(token)
	return err == nil && len(b) == 32
}

// PreviewPath is where the browser loads a version's files from for an
// hour: "<version>.<expiry>.<signature>" in the path, so every relative
// file under it works without cookies (a sandboxed frame sends none).
func (s *Service) PreviewPath(versionID string, now time.Time) string {
	// Expiries round up to the next minute, so a page's reads share one URL.
	expiry := strconv.FormatInt(now.Add(PreviewTTL).Truncate(time.Minute).Add(time.Minute).Unix(), 10)
	return PreviewPrefix + versionID + "." + expiry + "." + s.previewSignature(versionID, expiry) + "/files/"
}

func (s *Service) previewSignature(versionID, expiry string) string {
	mac := hmac.New(sha256.New, s.Secret)
	mac.Write([]byte("artifact-preview:" + versionID + ":" + expiry))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Service) checkPreview(capability string, now time.Time) (string, bool) {
	parts := strings.Split(capability, ".")
	if len(parts) != 3 {
		return "", false
	}
	versionID, ok := pg.ParseID(parts[0])
	expiry, err := strconv.ParseInt(parts[1], 10, 64)
	if !ok || versionID != parts[0] || err != nil || now.Unix() >= expiry {
		return "", false
	}
	return versionID, hmac.Equal([]byte(parts[2]), []byte(s.previewSignature(versionID, parts[1])))
}
