# 发布

打一个 `v*` tag，CI 就把 `eta-host` 构建好，发成 GitHub Release。工作流是 `.github/workflows/release.yml`。

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
3. `build`：干净 checkout、frozen lockfile 构建；单独运行一次，核对 `--version`、`/up` 和页面；再上传到草稿。
4. `publish`：从草稿算出 `SHA256SUMS`，然后发布。

失败了先看是不是已知的不稳定测试（`gh run rerun <id> --failed`）。草稿可以重跑，文件会被覆盖。Release 一旦发布就不再改动：重跑会报错，要换文件就打新 tag。

tag 的那次运行没有发生或者丢了，可以手动跑，`--ref` 必须是 tag：

```sh
gh workflow run release.yml --ref v0.2.0
```

## 产物

- `eta-host-linux-x64`：host 本身，不压缩，页面、数据库迁移、CLIProxyAPI 和所有平台的 daemon 都在里面。
- `SHA256SUMS`：校验和。

不压缩，是因为 zstd 只能省下三分之一左右（里面的 daemon 已经压缩过），却要求下载的机器有 zstd，校验的也不再是实际运行的文件。

目前只有 `linux-x64`。host 带的 CLIProxyAPI 跟构建它的机器相关，所以每个平台要在对应的 runner 上构建；加平台就是在 `build` 的矩阵里加一行，加之前要先验证过这个平台的编译。

## 下载和运行

仓库是 private，下载要有权限的 token，`gh` 已登录即可：

```sh
gh release download v0.2.0 --repo 0xfe-project/eta --pattern 'eta-host-*' --pattern SHA256SUMS
sha256sum -c SHA256SUMS
chmod +x eta-host-linux-x64
./eta-host-linux-x64 --version
```

`--version` 输出 `eta-host 0.2.0 (37d8188c1234)`，括号里是 commit。

运行和装成服务都和 checkout 里构建出来的一样，见 README 的 “Running in production”。这里只负责产出文件，生产部署的方式没有变。
