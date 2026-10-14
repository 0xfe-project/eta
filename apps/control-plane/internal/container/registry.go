package container

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// The registry's HTTP API (distribution), plain HTTP inside the cluster.

var manifestTypes = strings.Join([]string{
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
}, ", ")

// digest is ref's manifest digest, empty when the registry has no such
// image. ref is <registry>/<repository>:<tag>.
func (k *Kubernetes) digest(ctx context.Context, ref string) (string, error) {
	repository, tag, ok := strings.Cut(strings.TrimPrefix(ref, k.Registry+"/"), ":")
	if !ok || !strings.HasPrefix(ref, k.Registry+"/") {
		return "", fmt.Errorf("%s is not an image in %s", ref, k.Registry)
	}
	var digest string
	err := k.registry(ctx, http.MethodHead, "/v2/"+repository+"/manifests/"+tag, func(r *http.Response) error {
		digest = r.Header.Get("Docker-Content-Digest")
		return nil
	})
	if isNotFound(err) {
		return "", nil
	}
	return digest, err
}

func (k *Kubernetes) tags(ctx context.Context, repository string) ([]string, error) {
	var list struct {
		Tags []string `json:"tags"`
	}
	err := k.registry(ctx, http.MethodGet, "/v2/"+repository+"/tags/list", func(r *http.Response) error {
		return json.NewDecoder(r.Body).Decode(&list)
	})
	if isNotFound(err) {
		return nil, nil
	}
	return list.Tags, err
}

type statusError int

func (e statusError) Error() string { return fmt.Sprintf("the registry answered %d", int(e)) }

func isNotFound(err error) bool { e, ok := err.(statusError); return ok && e == http.StatusNotFound }

func (k *Kubernetes) registry(ctx context.Context, method, path string, read func(*http.Response) error) error {
	req, err := http.NewRequestWithContext(ctx, method, "http://"+k.Registry+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", manifestTypes)
	client := k.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return statusError(resp.StatusCode)
	}
	if read != nil {
		return read(resp)
	}
	return nil
}
