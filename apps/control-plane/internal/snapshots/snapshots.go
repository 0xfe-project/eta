// Package snapshots keeps agent snapshots in S3: the agent's home after each
// turn, the newest Keep of them, under agents/<agent>/snapshots/. The newest
// is what the agent's next runtime starts from; an earlier one comes back by
// being copied as the newest (Restore), and another agent starts from a
// copy of this one's newest (CopyLatest).
//
// Runtimes never hold storage credentials: they get short-lived presigned
// URLs for their own agent's objects only.
package snapshots

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

const (
	bucket  = "axp-agents"
	urlLife = time.Hour
	// Keep is how many snapshots an agent keeps: up to 2 GiB each.
	Keep = 5
)

// Kinds of snapshot.
const (
	// The home after a turn (Ref: its command).
	KindTurn = "turn"
	// An earlier snapshot made the newest again (Ref: its id).
	KindRestore = "restore"
	// Another agent's newest, for a copy of that agent (Ref: its id).
	KindCopy = "copy"
	// The one snapshot an agent had before snapshots were kept.
	KindLegacy = "legacy"
)

// Snapshot is one of an agent's snapshots.
type Snapshot struct {
	ID      string
	Kind    string
	Ref     string
	SavedAt time.Time
	Size    int64
	key     string
}

// Store is where snapshots are.
type Store interface {
	// List is the agent's snapshots, newest first.
	List(ctx context.Context, agentID string) ([]Snapshot, error)
	// UploadURL is where the agent's next snapshot, after the turn of
	// commandID, goes; snapshots beyond Keep make room for it.
	UploadURL(ctx context.Context, agentID, commandID string) (string, error)
	DownloadURL(ctx context.Context, s Snapshot) (string, error)
	// Restore copies one of the agent's snapshots as its newest.
	Restore(ctx context.Context, agentID, id string) (*Snapshot, error)
	// CopyLatest gives agent to a copy of agent from's newest snapshot;
	// false when from has none.
	CopyLatest(ctx context.Context, from, to string) (bool, error)
}

// Latest is the agent's newest snapshot, or nil.
func Latest(ctx context.Context, s Store, agentID string) (*Snapshot, error) {
	list, err := s.List(ctx, agentID)
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return &list[0], nil
}

func prefix(agentID string) string { return "agents/" + agentID + "/" }

func legacyKey(agentID string) string { return prefix(agentID) + "snapshot.tar.zst" }

// Key is a new snapshot's object: its time first (fixed width, so names
// sort by it), then what it is.
func Key(agentID string, at time.Time, kind, ref string) string {
	return fmt.Sprintf("%ssnapshots/%019d-%s-%s.tar.zst", prefix(agentID), at.UnixNano(), kind, ref)
}

// parse reads a snapshot from its object; false for other objects.
func parse(agentID, key string, size int64, modified time.Time) (Snapshot, bool) {
	if key == legacyKey(agentID) {
		return Snapshot{ID: KindLegacy, Kind: KindLegacy, SavedAt: modified, Size: size, key: key}, true
	}
	name, ok := strings.CutPrefix(key, prefix(agentID)+"snapshots/")
	if !ok {
		return Snapshot{}, false
	}
	id, ok := strings.CutSuffix(name, ".tar.zst")
	if !ok {
		return Snapshot{}, false
	}
	at, rest, ok := strings.Cut(id, "-")
	kind, ref, _ := strings.Cut(rest, "-")
	nanos, err := strconv.ParseInt(at, 10, 64)
	if !ok || err != nil || kind == "" {
		return Snapshot{}, false
	}
	return Snapshot{ID: id, Kind: kind, Ref: ref, SavedAt: time.Unix(0, nanos), Size: size, key: key}, true
}

// S3 is SeaweedFS's S3 API.
type S3 struct{ client *minio.Client }

func NewS3(endpoint, accessKey, secretKey string) (*S3, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	client, err := minio.New(u.Host, &minio.Options{
		Creds:        credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure:       u.Scheme == "https",
		Region:       "us-east-1",
		BucketLookup: minio.BucketLookupPath,
	})
	if err != nil {
		return nil, err
	}
	return &S3{client: client}, nil
}

func (s *S3) EnsureBucket(ctx context.Context) error {
	exists, err := s.client.BucketExists(ctx, bucket)
	if err != nil || exists {
		return err
	}
	return s.client.MakeBucket(ctx, bucket, minio.MakeBucketOptions{Region: "us-east-1"})
}

func (s *S3) List(ctx context.Context, agentID string) ([]Snapshot, error) {
	var list []Snapshot
	for object := range s.client.ListObjects(ctx, bucket, minio.ListObjectsOptions{Prefix: prefix(agentID), Recursive: true}) {
		if object.Err != nil {
			return nil, object.Err
		}
		if snapshot, ok := parse(agentID, object.Key, object.Size, object.LastModified); ok {
			list = append(list, snapshot)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].SavedAt.After(list[j].SavedAt) })
	return list, nil
}

func (s *S3) UploadURL(ctx context.Context, agentID, commandID string) (string, error) {
	list, err := s.List(ctx, agentID)
	if err != nil {
		return "", err
	}
	for i := Keep - 1; i < len(list); i++ {
		if err := s.client.RemoveObject(ctx, bucket, list[i].key, minio.RemoveObjectOptions{}); err != nil {
			return "", err
		}
	}
	if commandID == "" {
		commandID = "unknown"
	}
	u, err := s.client.PresignedPutObject(ctx, bucket, Key(agentID, time.Now(), KindTurn, commandID), urlLife)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func (s *S3) DownloadURL(ctx context.Context, snapshot Snapshot) (string, error) {
	u, err := s.client.PresignedGetObject(ctx, bucket, snapshot.key, urlLife, nil)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func (s *S3) copy(ctx context.Context, from Snapshot, to string) error {
	_, err := s.client.CopyObject(ctx,
		minio.CopyDestOptions{Bucket: bucket, Object: to},
		minio.CopySrcOptions{Bucket: bucket, Object: from.key})
	return err
}

func (s *S3) Restore(ctx context.Context, agentID, id string) (*Snapshot, error) {
	list, err := s.List(ctx, agentID)
	if err != nil {
		return nil, err
	}
	for _, snapshot := range list {
		if snapshot.ID == id {
			key := Key(agentID, time.Now(), KindRestore, id)
			if err := s.copy(ctx, snapshot, key); err != nil {
				return nil, err
			}
			restored, _ := parse(agentID, key, snapshot.Size, time.Now())
			return &restored, nil
		}
	}
	return nil, nil
}

func (s *S3) CopyLatest(ctx context.Context, from, to string) (bool, error) {
	latest, err := Latest(ctx, s, from)
	if err != nil || latest == nil {
		return false, err
	}
	return true, s.copy(ctx, *latest, Key(to, time.Now(), KindCopy, from))
}
