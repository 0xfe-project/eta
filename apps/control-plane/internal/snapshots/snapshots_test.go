package snapshots

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
)

func TestKeysSortByTimeAndParseBack(t *testing.T) {
	agent := uuid.NewString()
	command := uuid.NewString()
	key := Key(agent, timeAt(1_791_000_000_123_456_789), KindTurn, command)
	s, ok := parse(agent, key, 7, timeAt(0))
	if !ok || s.Kind != KindTurn || s.Ref != command || s.SavedAt.UnixNano() != 1_791_000_000_123_456_789 || s.Size != 7 {
		t.Fatalf("%+v %v", s, ok)
	}
	if early := Key(agent, timeAt(999), KindTurn, command); early >= key {
		t.Fatalf("%s sorts after %s", early, key)
	}
	if legacy, ok := parse(agent, legacyKey(agent), 3, timeAt(5)); !ok || legacy.Kind != KindLegacy {
		t.Fatalf("%+v", legacy)
	}
	if _, ok := parse(agent, "agents/"+agent+"/other.txt", 1, timeAt(0)); ok {
		t.Fatal("not a snapshot")
	}
}

// Against development's SeaweedFS: AXP_TEST_S3=http://172.30.0.1:8333.
func TestHistoryRestoreAndCopyOnS3(t *testing.T) {
	endpoint := os.Getenv("AXP_TEST_S3")
	if endpoint == "" {
		t.Skip("AXP_TEST_S3 is not set")
	}
	ctx := context.Background()
	s, err := NewS3(endpoint, "axp-dev", "axp-dev-secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureBucket(ctx); err != nil {
		t.Fatal(err)
	}
	agent, other := uuid.NewString(), uuid.NewString()
	t.Cleanup(func() {
		for _, a := range []string{agent, other} {
			for o := range s.client.ListObjects(ctx, bucket, minio.ListObjectsOptions{Prefix: prefix(a), Recursive: true}) {
				_ = s.client.RemoveObject(ctx, bucket, o.Key, minio.RemoveObjectOptions{})
			}
		}
	})
	// The one snapshot an agent had before.
	if _, err := s.client.PutObject(ctx, bucket, legacyKey(agent), bytes.NewReader([]byte("legacy")), 6,
		minio.PutObjectOptions{}); err != nil {
		t.Fatal(err)
	}
	put := func(url, body string) {
		req, _ := http.NewRequest(http.MethodPut, url, bytes.NewReader([]byte(body)))
		resp, err := http.DefaultClient.Do(req)
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("put %v %v", resp, err)
		}
		resp.Body.Close()
	}
	get := func(snapshot Snapshot) string {
		url, err := s.DownloadURL(ctx, snapshot)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		return string(data)
	}
	for i := 1; i <= Keep+1; i++ {
		url, err := s.UploadURL(ctx, agent, uuid.NewString())
		if err != nil {
			t.Fatal(err)
		}
		put(url, fmt.Sprintf("turn %d", i))
	}
	list, err := s.List(ctx, agent)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != Keep || get(list[0]) != fmt.Sprintf("turn %d", Keep+1) || get(list[Keep-1]) != "turn 2" {
		t.Fatalf("kept %d: %+v", len(list), list)
	}
	restored, err := s.Restore(ctx, agent, list[2].ID)
	if err != nil || restored == nil || restored.Kind != KindRestore || restored.Ref != list[2].ID {
		t.Fatalf("%+v %v", restored, err)
	}
	latest, err := Latest(ctx, s, agent)
	if err != nil || latest.ID != restored.ID || get(*latest) != get(list[2]) {
		t.Fatalf("latest %+v %v", latest, err)
	}
	if copied, err := s.CopyLatest(ctx, agent, other); err != nil || !copied {
		t.Fatal(copied, err)
	}
	copy, _ := Latest(ctx, s, other)
	if copy == nil || copy.Kind != KindCopy || copy.Ref != agent || get(*copy) != get(*latest) {
		t.Fatalf("copy %+v", copy)
	}
	if copied, err := s.CopyLatest(ctx, uuid.NewString(), other); err != nil || copied {
		t.Fatal("copied from an agent with no snapshot")
	}
}

func timeAt(nanos int64) time.Time { return time.Unix(0, nanos) }
