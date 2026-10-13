package artifacts

import (
	"archive/zip"
	"bytes"
	"io/fs"
	"strings"
	"testing"
)

type entry struct {
	name string
	body string
	mode fs.FileMode
}

func zipOf(t *testing.T, entries ...entry) *zip.Reader {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.mode != 0 {
			h.SetMode(e.mode)
		}
		f, err := w.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.Write([]byte(e.body))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	r, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestASiteIsItsFilesUnderARootIndex(t *testing.T) {
	files, total, err := siteFiles(zipOf(t,
		entry{name: "index.html", body: "<p>hi</p>"},
		entry{name: "assets/", mode: fs.ModeDir | 0o755},
		entry{name: "assets/css/site.css", body: "p{}"},
		entry{name: "./app.js", body: "1"},
	), DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range files {
		names = append(names, f.name)
	}
	if strings.Join(names, ",") != "index.html,assets/css/site.css,app.js" || total != 13 {
		t.Fatalf("%v %d", names, total)
	}
}

func TestZipsThatAreNotASafeSiteAreRefused(t *testing.T) {
	index := entry{name: "index.html", body: "x"}
	for name, tc := range map[string]struct {
		entries []entry
		message string
	}{
		"no index":       {[]entry{{name: "about.html"}}, "根目录没有 index.html"},
		"index in a dir": {[]entry{{name: "dist/index.html"}}, "现在在 dist/ 里"},
		"parent":         {[]entry{index, {name: "../evil.html"}}, "相对路径"},
		"inner parent":   {[]entry{index, {name: "a/../../evil.html"}}, "相对路径"},
		"absolute":       {[]entry{index, {name: "/etc/passwd"}}, "相对路径"},
		"backslash":      {[]entry{index, {name: "..\\evil.html"}}, "反斜杠"},
		"drive":          {[]entry{index, {name: "C:/evil.html"}}, "冒号"},
		"symlink":        {[]entry{index, {name: "link", body: "/etc/passwd", mode: fs.ModeSymlink | 0o777}}, "符号链接"},
		"duplicate":      {[]entry{index, {name: "index.html"}}, "重复"},
		"double slash":   {[]entry{index, {name: "a//b.js"}}, "相对路径"},
		"too many files": {[]entry{index, {name: "a.js"}, {name: "b.js"}}, "超过 2 个"},
		"too many bytes": {[]entry{index, {name: "big.bin", body: strings.Repeat("x", 2<<20)}}, "超过 1 MiB"},
		"device file":    {[]entry{index, {name: "dev", mode: fs.ModeDevice | 0o644}}, "普通文件"},
	} {
		t.Run(name, func(t *testing.T) {
			_, _, err := siteFiles(zipOf(t, tc.entries...), Limits{Archive: 1 << 20, Files: 2, Bytes: 1 << 20})
			if err == nil || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("%v, want %q", err, tc.message)
			}
		})
	}
}
