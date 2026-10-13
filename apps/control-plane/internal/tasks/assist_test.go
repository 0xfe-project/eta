package tasks

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The forge answers a pull request with its head, or an error to show.
func TestForgePullHeadReadsTheForgesAnswer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/forge/v1/pulls" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("url") == "https://github.com/acme/web/pull/7" {
			_, _ = w.Write([]byte(`{"url":"https://github.com/acme/web/pull/7","head_sha":"0123456789abcdef0123456789abcdef01234567"}`))
			return
		}
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":{"code":"GITHUB_ERROR","message":"GitHub 不让读这个仓库"}}`))
	}))
	defer srv.Close()
	head := ForgePullHead(srv.URL + "/")
	if sha, err := head(context.Background(), "https://github.com/acme/web/pull/7"); err != nil || sha != "0123456789abcdef0123456789abcdef01234567" {
		t.Fatal(sha, err)
	}
	if _, err := head(context.Background(), "https://github.com/acme/other/pull/1"); err == nil || err.Error() != "GitHub 不让读这个仓库" {
		t.Fatal(err)
	}
	if ForgePullHead("") != nil {
		t.Fatal("no forge, no reader")
	}
}
