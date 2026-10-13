package objects

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// A real S3: AXP_TEST_S3_ENDPOINT (development's is http://127.0.0.1:18333)
// with AXP_TEST_S3_ACCESS_KEY_ID, AXP_TEST_S3_SECRET_ACCESS_KEY and,
// optionally, AXP_TEST_S3_BUCKET and AXP_TEST_S3_REGION.
func TestS3StoresReadsAndDeletesByPrefix(t *testing.T) {
	endpoint := os.Getenv("AXP_TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("AXP_TEST_S3_ENDPOINT is not set")
	}
	bucket := os.Getenv("AXP_TEST_S3_BUCKET")
	if bucket == "" {
		bucket = "axp-test-" + uuid.NewString()[:8]
	}
	s, err := NewS3(Config{
		Endpoint: endpoint, Bucket: bucket, Region: os.Getenv("AXP_TEST_S3_REGION"),
		AccessKeyID: os.Getenv("AXP_TEST_S3_ACCESS_KEY_ID"), SecretAccessKey: os.Getenv("AXP_TEST_S3_SECRET_ACCESS_KEY"),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	prefix := "test/" + uuid.NewString() + "/"
	for _, name := range []string{"a/index.html", "a/x/y.css", "b.js"} {
		if err := s.Put(ctx, prefix+name, strings.NewReader(name), int64(len(name)), "text/plain"); err != nil {
			t.Fatal(err)
		}
	}
	rc, info, err := s.Get(ctx, prefix+"a/x/y.css")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(rc)
	_ = rc.Close()
	if string(data) != "a/x/y.css" || info.Size != 9 || info.ContentType != "text/plain" {
		t.Fatalf("%q %+v", data, info)
	}
	if _, _, err := s.Get(ctx, prefix+"missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if err := s.DeletePrefix(ctx, prefix+"a/"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Get(ctx, prefix+"a/index.html"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted: %v", err)
	}
	if _, _, err := s.Get(ctx, prefix+"b.js"); err != nil {
		t.Fatalf("outside the prefix: %v", err)
	}
	_ = s.DeletePrefix(ctx, prefix)
}

func TestS3NeedsAnHTTPEndpointAndABucket(t *testing.T) {
	for _, c := range []Config{{Endpoint: "axp-s3:8333", Bucket: "b"}, {Endpoint: "ftp://x", Bucket: "b"}, {Endpoint: "http://x"}} {
		if _, err := NewS3(c); err == nil {
			t.Errorf("%+v", c)
		}
	}
}
