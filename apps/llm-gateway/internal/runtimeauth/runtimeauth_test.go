package runtimeauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	sdkaccess "github.com/router-for-me/CLIProxyAPI/v7/sdk/access"
)

func TestAuthenticate(t *testing.T) {
	var calls atomic.Int32
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/internal/v1/runtime-instances/inst-1/identity" || r.Header.Get("Authorization") != "Bearer good" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = w.Write([]byte(`{"agent_id":"agent-1","instance_id":"inst-1","generation":2}`))
	}))
	defer internal.Close()
	p := New(internal.URL + "/")

	auth := func(header string) (*sdkaccess.Result, *sdkaccess.AuthError) {
		r := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
		if header != "" {
			r.Header.Set("Authorization", header)
		}
		return p.Authenticate(context.Background(), r)
	}

	res, err := auth("Bearer inst-1.good")
	if err != nil || res.Principal != "agent-1" || res.Metadata["instance_id"] != "inst-1" {
		t.Fatalf("valid key: %+v %v", res, err)
	}
	if _, err := auth("Bearer inst-1.good"); err != nil || calls.Load() != 1 {
		t.Fatalf("second call should hit the cache: %v, %d calls", err, calls.Load())
	}
	for _, header := range []string{"Bearer inst-1.bad", "Bearer no-dot", "Bearer .x"} {
		if _, err := auth(header); !sdkaccess.IsAuthErrorCode(err, sdkaccess.AuthErrorCodeInvalidCredential) {
			t.Fatalf("%q: %v", header, err)
		}
	}
	if _, err := auth(""); !sdkaccess.IsAuthErrorCode(err, sdkaccess.AuthErrorCodeNoCredentials) {
		t.Fatalf("missing key: %v", err)
	}
}

func TestControlPlaneDown(t *testing.T) {
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer internal.Close()
	r := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	r.Header.Set("Authorization", "Bearer inst-1.good")
	_, err := New(internal.URL).Authenticate(context.Background(), r)
	if !sdkaccess.IsAuthErrorCode(err, sdkaccess.AuthErrorCodeInternal) {
		t.Fatalf("err = %v", err)
	}
}
