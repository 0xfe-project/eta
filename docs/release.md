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

运行和装成服务都和 checkout 里构建出来的一样，见 README 的 “Running in production”。

Windows 上 host 只能手动运行：`install-service` 只有 systemd 和 launchd，在 Windows 上会报错。

## 升级

已经装好的 `eta-host` 可以自己升级，不需要 checkout：

```sh
eta-host upgrade              # 最新正式版
eta-host upgrade 0.2.0-rc.1   # 指定版本，预发布只能这样装
eta-host upgrade --check      # 只报告有没有新版本，什么都不改
eta-host upgrade --status     # 上一次升级的结果，或者正在进行的阶段
eta-host upgrade --cancel     # 取消正在进行的升级，服务已经停了就取消不了
```

设置里的“更新”一节做的是同一件事，只升到最新正式版。

第一个带 `upgrade` 的版本要用 `bun run host:install` 或手动替换文件装上，更早的版本没有这条命令。

下载走 GitHub API，公开仓库不需要 token；私有仓库按 `GH_TOKEN`、`GITHUB_TOKEN`、`gh` 的登录依次取 token。`ETA_RELEASES_URL` 可以换一个仓库（`https://api.github.com/repos/<owner>/<repo>`）。指向 GitHub 以外的服务器时，这些 GitHub 凭据都不会发出去，只用 `ETA_RELEASES_TOKEN`。

服务在运行时，升级交给一个单独的用户 unit `io.eta.host-upgrade` 来做，它不在 host 的 cgroup 里。`eta-host upgrade` 只是跟着打印进度：关掉终端、杀掉这条命令、host 停掉，都不影响它。进度写在 `~/.eta/upgrade-status.json`，日志在 `journalctl --user -u io.eta.host-upgrade`。这个文件不放数据库，因为回退时数据库会被换掉。

顺序是这样，前一半不影响正在运行的 host：

1. 找到版本。已经是这个版本就结束。比当前版本旧的拒绝，要回退用下面的办法。
2. 下载到可执行文件旁边的 `eta-host.next`，核对 `SHA256SUMS`。
3. 试运行：`--version` 要和版本对上；`--migrations` 列出它带的迁移，数据库里有它不认识的迁移就拒绝（数据库比这个版本新，比如 host 是从更新的 main 构建的）。`v0.1.0` 列不出迁移：从 checkout 构建的 host 不能升到它，因为无法判断数据库是否更新。
4. 等智能体：`task_run`、`routine_run` 和进行中的回复（包括刚排队和等用户回答的）都结束才继续，默认等 10 分钟（`--wait <分钟>`），等不到就退出，什么都没改。`--force` 不等，重启会杀掉它们。
5. 停服务，备份数据库，替换文件（旧文件留作 `eta-host.prev`），启动。
6. 验证：`/up` 要在 2 分钟内应答，之后 5 秒里继续应答且进程不变，新版本的迁移都在数据库里。

第 6 步失败，就停服务、换回 `.prev`、恢复数据库、再启动旧版本，然后报错退出，退出码 1。新版本运行期间写入的内容会随数据库恢复丢掉。如果回退也失败，错误信息里有旧文件和备份的路径，要手动处理。

第 5 步之前可以用 `--cancel` 放弃，什么都不会留下。从第 5 步开始 worker 忽略 `SIGINT`、`SIGTERM`、`SIGHUP`，不会把服务留在半路。

按 Ctrl-C 只是不再跟着看，升级继续。

重启只发生在 `io.eta.host` 正在运行（或崩溃后等 systemd 重新启动）、而且运行的就是这个文件时：

- 服务运行的是别的文件：拒绝，要用那个文件的 `upgrade`。
- 服务没装或者没在运行：备份数据库并替换文件，重启由你来做，不做验证和回退。

host 下面的智能体也可以直接运行 `upgrade`。它自己算在运行的智能体里，所以要加 `--force`，重启时它会被杀掉，升级继续。

服务重启后 daemon 重新连上，host 会把它们换成自己带的版本。

### 设置里的更新按钮

`upgrade` 这个 wire target 提供 `check`、`start`、`cancel`，页面用它们启动 worker。进度走普通 HTTP：页面轮询 `/upgrade/status`，这个地址和页面一样要 token。socket 在重启时最先断、最后恢复，轮询这个地址只需要有没有应答，所以能分清“host 在重启”和“升级结束了”。

下载和等智能体的时候页面照常可用，这时候可能还需要回答智能体。服务一停就显示全屏的等待页，host 回来后读结果：成功就重新载入页面，回退了就说明原因。别的标签页如果在 host 停掉之前没读到进度，看到的是平常的断线提示，host 回来后会提示刷新。

只有编译出来的 host，而且 `io.eta.host` 正在运行这个文件时才有按钮。从源码运行、没装服务、服务运行别的文件时只显示原因。

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
