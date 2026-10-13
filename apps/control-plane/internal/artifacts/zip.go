package artifacts

import (
	"archive/zip"
	"fmt"
	"io/fs"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/akarachen/axp/packages/service-go/apierr"
)

// Limits are what an upload may hold. Entries' sizes are checked as
// declared before anything is stored; archive/zip fails an entry whose
// bytes do not match its header as it is read.
type Limits struct {
	// The ZIP itself.
	Archive int64
	// Files in it (directories do not count) and their total size once
	// extracted.
	Files int
	Bytes int64
}

// DefaultLimits keep a request under the gateway's limit for uploads
// (apps/gateway/public.caddy) and a site small enough to preview.
var DefaultLimits = Limits{Archive: 90 << 20, Files: 5000, Bytes: 512 << 20}

// file is one file of a site: its path under the site's root and its entry.
type file struct {
	name  string
	entry *zip.File
}

func invalidZip(format string, args ...any) error {
	return apierr.New(422, "INVALID_ARTIFACT", fmt.Sprintf(format, args...))
}

// siteFiles checks a ZIP is a static site and lists its files: an
// index.html at the root, every path relative and inside it, no links,
// nothing encrypted or compressed other than stored or deflated, and
// within the limits.
func siteFiles(r *zip.Reader, limits Limits) ([]file, int64, error) {
	var files []file
	var total uint64
	seen := map[string]bool{}
	for _, f := range r.File {
		name := f.Name
		mode := f.Mode()
		if mode.IsDir() || strings.HasSuffix(name, "/") {
			continue // nothing is stored for a directory
		}
		if mode&fs.ModeSymlink != 0 {
			return nil, 0, invalidZip("ZIP 里不能有符号链接：%s", name)
		}
		if !mode.IsRegular() {
			return nil, 0, invalidZip("ZIP 里只能有普通文件：%s", name)
		}
		name = strings.TrimPrefix(name, "./")
		if err := checkPath(name); err != nil {
			return nil, 0, err
		}
		if seen[name] {
			return nil, 0, invalidZip("ZIP 里有重复的文件：%s", name)
		}
		seen[name] = true
		if f.Flags&0x1 != 0 {
			return nil, 0, invalidZip("ZIP 里不能有加密的文件：%s", name)
		}
		if f.Method != zip.Store && f.Method != zip.Deflate {
			return nil, 0, invalidZip("不支持 %s 的压缩方式（只支持 stored 和 deflate）", name)
		}
		if len(files) == limits.Files {
			return nil, 0, invalidZip("文件超过 %d 个", limits.Files)
		}
		total += f.UncompressedSize64
		if total > uint64(limits.Bytes) {
			return nil, 0, invalidZip("解压后超过 %d MiB", limits.Bytes>>20)
		}
		files = append(files, file{name: name, entry: f})
	}
	if !seen["index.html"] {
		for name := range seen {
			if dir, base := path.Split(name); base == "index.html" && strings.Count(dir, "/") == 1 {
				return nil, 0, invalidZip("index.html 必须在 ZIP 的根目录，现在在 %s 里：在这个目录里面打包（cd %s && zip -r ../site.zip .）", dir, strings.TrimSuffix(dir, "/"))
			}
		}
		return nil, 0, invalidZip("ZIP 的根目录没有 index.html")
	}
	return files, int64(total), nil
}

// checkPath is whether name is a clean relative path under the site's
// root, the same on every system.
func checkPath(name string) error {
	switch {
	case name == "" || len(name) > 1024 || !utf8.ValidString(name):
		return invalidZip("ZIP 里有无效的路径：%q", name)
	case strings.ContainsAny(name, "\\\x00:"):
		return invalidZip("路径里不能有反斜杠、冒号或空字符：%q", name)
	case strings.HasPrefix(name, "/") || path.Clean(name) != name:
		return invalidZip("路径必须是根目录下的相对路径：%q", name)
	}
	for part := range strings.SplitSeq(name, "/") {
		if part == ".." || part == "." || len(part) > 255 {
			return invalidZip("路径必须是根目录下的相对路径：%q", name)
		}
	}
	return nil
}
