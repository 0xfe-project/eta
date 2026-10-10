package tasks

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

func TestServedConnectorVersionIsTheTarballsPackageVersion(t *testing.T) {
	empty, dist := t.TempDir(), t.TempDir()
	f, err := os.Create(filepath.Join(dist, "agenvo-herdr.tgz"))
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for name, body := range map[string]string{"package/dist/cli.js": "", "package/package.json": `{"name":"@agenvo/herdr","version":"0.2.0"}`} {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))})
		_, _ = tw.Write([]byte(body))
	}
	_ = tw.Close()
	_ = gz.Close()
	_ = f.Close()
	if v := ServedConnectorVersion(empty + ":" + dist); v != "0.2.0" {
		t.Fatalf("version %q", v)
	}
	if v := ServedConnectorVersion(empty); v != "" {
		t.Fatalf("no tarballs: %q", v)
	}
}
