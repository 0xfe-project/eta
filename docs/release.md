# 发布

打一个 `v*` tag，CI 就在 Linux、macOS 和 Windows 上把 `eta-host` 和桌面应用构建好，发成 GitHub Release。工作流是 `.github/workflows/release.yml`。

## 打 tag

在要发布的 commit 上打 tag，通常是 `main` 的最新一次：

```sh
git fetch origin
git tag v0.2.0 origin/main
git push origin v0.2.0
```

- 版本就是 tag 去掉 `v`。host 和它带的 daemon 都是这个版本，`package.json` 里的 `version` 不参与。
- 带 `-` 的是预发布，比如 `v0.2.0-rc.1`，Release 会标成 Pre-release，不算最新版本。
- tag 要写成 `vX.Y.Z` 或 `vX.Y.Z-后缀`，其它写法发不出去。

流水线的顺序：

1. `check`：跑完整的 `bun run check`，不是 `--affected`。没通过就到此为止，不会留下草稿。
2. `prepare`：从 tag 读版本，开一个草稿 Release。
3. `build`：每个平台在自己的 runner 上，干净 checkout、frozen lockfile 构建。host 单独运行一次，核对 `--version`、`/up` 和页面；桌面应用打成安装包，装上启动，看它带的 host 答应；两样都过了才上传到草稿。只有一个例外：Linux 上启动要先从 Ubuntu 的镜像装 WebKit，8 分钟装不完就跳过这次启动，运行里留一条 warning，host 的检查不受影响。
4. `publish`：所有平台都成功才会跑，从草稿算出 `SHA256SUMS`，然后发布。任何一个平台失败，Release 都留在草稿，用户看不到。

失败了先看是不是已知的不稳定测试（`gh run rerun <id> --failed`）。一个平台失败时其它平台会跑完，`--failed` 只重跑失败的那个。草稿可以重跑，文件会被覆盖。Release 一旦发布就不再改动：重跑会报错，要换文件就打新 tag。

tag 的那次运行没有发生或者丢了，可以手动跑，`--ref` 必须是 tag：

```sh
gh workflow run release.yml --ref v0.2.0
```

## 产物

| 文件                           | 平台        | 是什么                           |
| ------------------------------ | ----------- | -------------------------------- |
| `eta-host-linux-x64`           | Linux x64   | host                             |
| `eta-host-darwin-arm64`        | macOS arm64 | host                             |
| `eta-host-windows-x64.exe`     | Windows x64 | host                             |
| `eta-desktop-linux-x64.tar.gz` | Linux x64   | 桌面应用，里面是 `installer`     |
| `eta-desktop-darwin-arm64.dmg` | macOS arm64 | 桌面应用                         |
| `eta-desktop-windows-x64.zip`  | Windows x64 | 桌面应用，里面是 `eta-Setup.exe` |
| `SHA256SUMS`                   |             | 以上全部的校验和                 |

host 是一个不压缩的文件，页面、数据库迁移、CLIProxyAPI 和所有平台的 daemon 都在里面。不压缩，是因为 zstd 只能省下三分之一左右（里面的 daemon 已经压缩过），却要求下载的机器有 zstd，校验的也不再是实际运行的文件。桌面应用里带着同一个 host。

host 带的 CLIProxyAPI 跟构建它的机器相关，hutch 也只为所在的机器打包，所以每个平台要在对应的 runner 上构建。加平台就是在 `build` 的矩阵里加一行，加之前要先验证过这个平台的编译。没有 `darwin-x64`，也没有 Windows 的 daemon（`apps/daemon/scripts/build.ts` 的平台表里没有它）。

## 没有签名

这些文件都没有签名和公证，也没有自动更新：新版本要重新下载安装。macOS 和 Windows 第一次打开时都会拦下来，放行一次之后就正常了。

macOS 上，从 DMG 把 eta 拖进“应用程序”，然后去掉下载带上的隔离标记，否则系统会说应用已损坏：

```sh
xattr -dr com.apple.quarantine /Applications/eta.app
```

下载的 host 同样处理：`xattr -d com.apple.quarantine eta-host-darwin-arm64`。

Windows 上，解压 zip，运行 `eta-Setup.exe`。SmartScreen 提示“Windows 已保护你的电脑”时，点“更多信息”，再点“仍要运行”。

## 下载和运行

仓库是 private，下载要有权限的 token，`gh` 已登录即可：

```sh
gh release download v0.2.0 --repo 0xfe-project/eta --pattern 'eta-*' --pattern SHA256SUMS
sha256sum -c SHA256SUMS
```

只下一个平台时，用 `--pattern` 写具体文件名，校验时加 `--ignore-missing`。macOS 没有 `sha256sum`，用 `shasum -a 256 -c SHA256SUMS --ignore-missing`；Windows 上用 PowerShell 的 `Get-FileHash <文件>`，和 `SHA256SUMS` 里那一行对比。

然后：

```sh
chmod +x eta-host-linux-x64
./eta-host-linux-x64 --version
```

`--version` 输出 `eta-host 0.2.0 (37d8188c1234)`，括号里是 commit。

运行和装成服务都和 checkout 里构建出来的一样，见 README 的 “Running in production”。这里只负责产出文件，生产部署的方式没有变。

Windows 上 host 只能手动运行：`install-service` 只有 systemd 和 launchd，在 Windows 上会报错。
