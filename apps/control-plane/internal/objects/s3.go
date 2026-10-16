// Package objects is object storage on any S3-compatible service: the
// built-in SeaweedFS (deploy/nomad/infra.nomad.hcl) or an external one. It knows keys
// and bytes, nothing about what they are.
package objects

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"sync"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// ErrNotFound is a key with no object.
var ErrNotFound = errors.New("object not found")

// Config is where the bucket is: Endpoint is the service's URL
// (http://127.0.0.1:24333, https://s3.us-east-1.amazonaws.com, ...).
type Config struct {
	Endpoint        string
	Bucket          string
	Region          string
	AccessKeyID     string
	SecretAccessKey string
}

// Info is what an object is besides its bytes.
type Info struct {
	Size        int64
	ContentType string
}

// S3 is one bucket. It creates the bucket the first time it is needed,
// when the credentials allow (an external bucket usually exists already).
type S3 struct {
	client *minio.Client
	bucket string
	region string

	mu    sync.Mutex
	ready bool
}

func NewS3(c Config) (*S3, error) {
	u, err := url.Parse(c.Endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("S3 endpoint %q is not an http(s) URL", c.Endpoint)
	}
	if c.Bucket == "" {
		return nil, errors.New("S3 bucket is empty")
	}
	client, err := minio.New(u.Host, &minio.Options{
		Creds:  credentials.NewStaticV4(c.AccessKeyID, c.SecretAccessKey, ""),
		Secure: u.Scheme == "https",
		Region: c.Region,
	})
	if err != nil {
		return nil, err
	}
	return &S3{client: client, bucket: c.Bucket, region: c.Region}, nil
}

func (s *S3) ensureBucket(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ready {
		return nil
	}
	exists, err := s.client.BucketExists(ctx, s.bucket)
	if err != nil {
		return err
	}
	if !exists {
		if err := s.client.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{Region: s.region}); err != nil {
			return fmt.Errorf("create bucket %s: %w", s.bucket, err)
		}
	}
	s.ready = true
	return nil
}

// Put writes size bytes from r at key.
func (s *S3) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	if err := s.ensureBucket(ctx); err != nil {
		return err
	}
	_, err := s.client.PutObject(ctx, s.bucket, key, r, size, minio.PutObjectOptions{ContentType: contentType})
	return err
}

// Get is the object at key; ErrNotFound when there is none.
func (s *S3) Get(ctx context.Context, key string) (io.ReadCloser, Info, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, Info{}, notFound(err)
	}
	stat, err := obj.Stat()
	if err != nil {
		_ = obj.Close()
		return nil, Info{}, notFound(err)
	}
	return obj, Info{Size: stat.Size, ContentType: stat.ContentType}, nil
}

// DeletePrefix removes every object whose key starts with prefix.
func (s *S3) DeletePrefix(ctx context.Context, prefix string) error {
	objects := s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true})
	for result := range s.client.RemoveObjects(ctx, s.bucket, objects, minio.RemoveObjectsOptions{}) {
		if result.Err != nil {
			return notFoundOK(result.Err)
		}
	}
	return nil
}

func notFound(err error) error {
	switch minio.ToErrorResponse(err).Code {
	case "NoSuchKey", "NoSuchBucket":
		return ErrNotFound
	}
	return err
}

// notFoundOK is nil when there was nothing to delete.
func notFoundOK(err error) error {
	if errors.Is(notFound(err), ErrNotFound) {
		return nil
	}
	return err
}
