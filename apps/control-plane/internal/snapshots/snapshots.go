// Package snapshots keeps agent snapshots in S3: one object per agent,
// replaced after every turn.
//
// Runtimes never hold storage credentials: they get short-lived presigned
// URLs for their own agent's object only.
package snapshots

import (
	"context"
	"net/url"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

const (
	bucket  = "axp-agents"
	urlLife = time.Hour
)

// Store is where snapshots are.
type Store interface {
	Exists(ctx context.Context, agentID string) (bool, error)
	UploadURL(ctx context.Context, agentID string) (string, error)
	DownloadURL(ctx context.Context, agentID string) (string, error)
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

func key(agentID string) string { return "agents/" + agentID + "/snapshot.tar.zst" }

func (s *S3) EnsureBucket(ctx context.Context) error {
	exists, err := s.client.BucketExists(ctx, bucket)
	if err != nil || exists {
		return err
	}
	return s.client.MakeBucket(ctx, bucket, minio.MakeBucketOptions{Region: "us-east-1"})
}

func (s *S3) Exists(ctx context.Context, agentID string) (bool, error) {
	_, err := s.client.StatObject(ctx, bucket, key(agentID), minio.StatObjectOptions{})
	if err != nil {
		if code := minio.ToErrorResponse(err).Code; code == "NoSuchKey" || code == "NotFound" {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func (s *S3) UploadURL(ctx context.Context, agentID string) (string, error) {
	u, err := s.client.PresignedPutObject(ctx, bucket, key(agentID), urlLife)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func (s *S3) DownloadURL(ctx context.Context, agentID string) (string, error) {
	u, err := s.client.PresignedGetObject(ctx, bucket, key(agentID), urlLife, nil)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}
