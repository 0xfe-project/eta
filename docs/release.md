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

运行和装成服务都和 checkout 里构建出来的一样，见 README 的 “Running in production”。

## 升级

已经装好的 `eta-host` 可以自己升级，不需要 checkout：

```sh
eta-host upgrade              # 最新正式版
eta-host upgrade 0.2.0-rc.1   # 指定版本，预发布只能这样装
eta-host upgrade --check      # 只报告有没有新版本，什么都不改
```

第一个带 `upgrade` 的版本要用 `bun run host:install` 或手动替换文件装上，更早的版本没有这条命令。

下载走 GitHub API，公开仓库不需要 token；私有仓库按 `GH_TOKEN`、`GITHUB_TOKEN`、`gh` 的登录依次取 token。`ETA_RELEASES_URL` 可以换一个仓库（`https://api.github.com/repos/<owner>/<repo>`）。指向 GitHub 以外的服务器时，这些 GitHub 凭据都不会发出去，只用 `ETA_RELEASES_TOKEN`。

顺序是这样，前一半不影响正在运行的 host：

1. 找到版本。已经是这个版本就结束。比当前版本旧的拒绝，要回退用下面的办法。
2. 下载到可执行文件旁边的 `eta-host.next`，核对 `SHA256SUMS`。
3. 试运行：`--version` 要和版本对上；`--migrations` 列出它带的迁移，数据库里有它不认识的迁移就拒绝（数据库比这个版本新，比如 host 是从更新的 main 构建的）。`v0.1.0` 列不出迁移：从 checkout 构建的 host 不能升到它，因为无法判断数据库是否更新。
4. 等智能体：`task_run`、`routine_run` 和进行中的回复（包括刚排队和等用户回答的）都结束才继续，默认等 10 分钟（`--wait <分钟>`），等不到就退出，什么都没改。`--force` 不等，重启会杀掉它们。
5. 停服务，备份数据库，替换文件（旧文件留作 `eta-host.prev`），启动。
6. 验证：`/up` 要在 2 分钟内应答，之后 5 秒里继续应答且进程不变，新版本的迁移都在数据库里。

第 6 步失败，就停服务、换回 `.prev`、恢复数据库、再启动旧版本，然后报错退出，退出码 1。新版本运行期间写入的内容会随数据库恢复丢掉。如果回退也失败，错误信息里有旧文件和备份的路径，要手动处理。

第 5 步之前按 Ctrl-C 可以放弃，什么都不会留下。从第 5 步开始 `SIGINT`、`SIGTERM`、`SIGHUP` 都被忽略，中途断开终端不会把服务留在半路。

重启只发生在 `io.eta.host` 正在运行（或崩溃后等 systemd 重新启动）、而且运行的就是这个文件时：

- 服务运行的是别的文件：拒绝，要用那个文件的 `upgrade`。
- 在服务内部运行（比如 host 下面的智能体）：拒绝，因为重启会把 `upgrade` 自己杀掉。智能体可以用 `systemd-run --user --scope <文件的完整路径> upgrade --force` 跳出去，它自己算正在运行，所以要 `--force`，重启时也会被杀掉，结果要从外面看。
- 服务没装或者没在运行：备份数据库并替换文件，重启由你来做，不做验证和回退。

服务重启后 daemon 重新连上，host 会把它们换成自己带的版本。

### 备份

备份在 `~/.eta/backups/upgrade-<UTC 时间>-<旧版本>.sqlite`，用 `VACUUM INTO` 写成，权限 0600，写完做一次 `quick_check`。每次备份后只留最新的 3 个，这个目录里别的文件不动。每个备份和数据库一样大。

服务先停再备份，所以回退不丢数据。只备份 `eta.sqlite`，`~/.eta` 里的会话文件和配置不动。

### 手动回退

迁移不一定能反向执行（比如 `0042` 删了列），所以回到旧版本要同时回到旧数据库：

```sh
systemctl --user stop io.eta.host
cd ~/.local/share/eta/host && mv eta-host.prev eta-host
cp ~/.eta/backups/upgrade-<时间>-<旧版本>.sqlite ~/.eta/eta.sqlite
rm -f ~/.eta/eta.sqlite-wal ~/.eta/eta.sqlite-shm
systemctl --user start io.eta.host
```

升级之后写入的数据不在备份里，手动回退会丢掉。
