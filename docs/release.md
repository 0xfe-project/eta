# 发布

host 和桌面应用分开发版，各有各的版本号：

| tag          | 工作流                                  | 发什么                                       |
| ------------ | --------------------------------------- | -------------------------------------------- |
| `v*`         | `.github/workflows/release.yml`         | `eta-host`，Linux、macOS、Windows 各一个文件 |
| `desktop-v*` | `.github/workflows/release-desktop.yml` | 桌面应用安装包，见下面的“桌面应用”           |

GitHub 的 Latest 永远是 host 的：桌面 Release 发布时带 `--latest=false`。`eta-host upgrade` 和设置页按钮也不看 Latest 是谁，只取 `v*` tag（`apps/eta/src/upgrade/releases.ts`），所以就算桌面 Release 被手动标成了 Latest，host 取到的仍然是最新的 host。

## 打 tag

在要发布的 commit 上打 tag，通常是 `main` 的最新一次：

```sh
git fetch origin
git tag v0.2.0 origin/main
git push origin v0.2.0
```

- 版本就是 tag 去掉 `v`。host 和它带的 daemon 都是这个版本，`package.json` 里的 `version` 不参与。
- 这一节和下面几节说的都是 host。桌面应用打 `desktop-v*`，见“桌面应用”。
- 带 `-` 的是预发布，比如 `v0.2.0-rc.1`，Release 会标成 Pre-release，不算最新版本。
- tag 要写成 `vX.Y.Z` 或 `vX.Y.Z-后缀`，其它写法发不出去。

流水线的顺序：

1. `prepare`：从 tag 读版本，开一个草稿 Release。
2. `check`：和构建同时跑，完整的 `bun run check`，不是 `--affected`。没通过就不会发布，草稿留着。
3. `build`：每个平台在自己的 runner 上，干净 checkout、frozen lockfile 构建。host 单独运行一次，核对 `--version`、`/up` 和页面，过了才上传到草稿。Linux 那一份还写出 `eta-host.json`（`eta-host --version --json`），一起上传。
4. `cross`：`upgrade-cross.yml` 在 Linux 上从上一个正式版本升到这个草稿，见下面的“跨版本升级测试”。没有上一版，或者上一版比最早的种子还旧（比如不能自升级的 v0.1.0），都跳过并在运行摘要里写明。
5. `publish`：前面都成功才会跑，从草稿算出 `SHA256SUMS`，然后发布。任何一步失败，Release 都留在草稿，用户看不到。

不再构建桌面应用，也不装 WebKit 和 Xvfb，所以 host 发版不再被 Ubuntu 镜像拖慢。

失败了先看是不是已知的不稳定测试（`gh run rerun <id> --failed`）。一个平台失败时其它平台会跑完，`--failed` 只重跑失败的那个。草稿可以重跑，文件会被覆盖。Release 一旦发布就不再改动：重跑会报错，要换文件就打新 tag。

tag 的那次运行没有发生或者丢了，可以手动跑，`--ref` 必须是 tag：

```sh
gh workflow run release.yml --ref v0.2.0
```

## 产物

`v*` 的 Release：

| 文件                       | 平台        | 是什么                                                          |
| -------------------------- | ----------- | --------------------------------------------------------------- |
| `eta-host-linux-x64`       | Linux x64   | host                                                            |
| `eta-host-darwin-arm64`    | macOS arm64 | host                                                            |
| `eta-host-windows-x64.exe` | Windows x64 | host                                                            |
| `eta-host.json`            |             | `{"version","commit","minDesktop"}`，见“桌面应用和 host 的兼容” |
| `SHA256SUMS`               |             | 以上全部的校验和                                                |

host 是一个不压缩的文件，页面、数据库迁移、CLIProxyAPI 和所有平台的 daemon 都在里面。不压缩，是因为 zstd 只能省下三分之一左右（里面的 daemon 已经压缩过），却要求下载的机器有 zstd，校验的也不再是实际运行的文件。

本地构建同一个文件：`bun run --cwd apps/web build && bun apps/eta/scripts/build-host.ts`，产物在 `apps/eta/out/host/`。

host 带的 CLIProxyAPI 跟构建它的机器相关，所以每个平台要在对应的 runner 上构建。加平台就是在 `build` 的矩阵里加一行，加之前要先验证过这个平台的编译。没有 `darwin-x64`，也没有 Windows 的 daemon（`apps/daemon/scripts/build.ts` 的平台表里没有它）。

## 桌面应用

```sh
git tag desktop-v0.2.0 origin/main
git push origin desktop-v0.2.0
```

- 版本是 tag 去掉 `desktop-v`，由 `ETA_DESKTOP_VERSION` 交给 `electrobun.config.ts`，写进包里的 `Resources/version.json`，应用运行时从那里读（`apps/desktop/src/version.ts`）。本地打包没有这个变量，取 `apps/desktop/package.json` 的 `version`。源码里没有别处写版本号。
- 带 `-` 的是预发布。tag 要写成 `desktop-vX.Y.Z` 或 `desktop-vX.Y.Z-后缀`。
- 草稿和发布都带 `--latest=false`，不占仓库的 Latest。

流水线：`prepare` 开草稿；`check` 和 host 一样跑完整的 `bun run check`；`build` 每个平台构建页面和应用带的 host，打包，装上启动一次（`apps/desktop/scripts/try-app.ts`），Linux 上 8 分钟装不完 WebKit 就跳过启动并留 warning；`publish` 算 `SHA256SUMS` 后发布。没有跨版本升级测试，那是 host 的。

| 文件                           | 平台        | 是什么                           |
| ------------------------------ | ----------- | -------------------------------- |
| `eta-desktop-linux-x64.tar.gz` | Linux x64   | 桌面应用，里面是 `installer`     |
| `eta-desktop-darwin-arm64.dmg` | macOS arm64 | 桌面应用                         |
| `eta-desktop-windows-x64.zip`  | Windows x64 | 桌面应用，里面是 `eta-Setup.exe` |
| `SHA256SUMS`                   |             | 以上全部的校验和                 |

hutch 只为所在的机器打包，所以每个平台在对应的 runner 上构建。

### 桌面应用和 host 的兼容

两者各自升级：host 用设置页的按钮或 `eta-host upgrade`，桌面应用重新安装。窗口里的页面是 host 提供的，所以页面可能比应用新，也可能比它旧；连远程 host 时更是如此。约定在 `packages/client-contracts/src/desktop.ts`：

- **原生桥只增不改。** 应用通过 `window.__ETA_HOST__.capabilities` 列出它能做的事（`open-external`、`save-file`、`context-menu`、`window-action`、`connection`，之后只会增加）。名字一旦发布，含义和应答都不变；要改就起新名字。没有这个列表的应用是 0.1.0，按 `BASELINE_CAPABILITIES` 算。
- **页面按能力判断，不按版本判断。** 调用前用 `hasCapability(<名字>)`（`apps/web/src/lib/native.ts`）；没有这个能力就不显示对应入口，浏览器里什么都没有。
- **确实要破坏兼容时，提高 `MIN_DESKTOP`。** 页面发现应用版本低于它，就在窗口底部提示更新桌面端。`dev` 构建和说不出版本的应用不提示。这是唯一比较版本的地方，应该很少用。每个 host Release 的 `eta-host.json` 带着 `minDesktop`，应用不用下载 host 就能知道能不能跑它。

## 升级测试

有两个工作流，都复用 `scripts/upgrade-e2e/`，都只能证明 runner 上能测到的部分：重启后自启和真实登录用户的凭据要在真机上试。

- `upgrade-e2e.yml`：在真实的 macOS 和 Windows runner 上，用假的 Release 服务器（`fake-releases.ts`）在本次构建的几个变体之间升级，覆盖成功、各种失败回退和卸载，约 15 分钟。改到服务或升级相关代码的 PR 才跑，不是发布门槛。
- `upgrade-cross.yml`：两个真实版本之间的升级。

### 跨版本升级测试

一个 tag 的流水线只在 Linux 上跑一次，几分钟出结果，失败就不发布。macOS 和 Windows 的 runner 在私有仓库按 10 倍和 2 倍算分钟数，所以不是每个 tag 的门槛，要用时手动跑：

```sh
gh workflow run upgrade-cross.yml --ref v0.2.1 -f platforms=all
gh workflow run upgrade-cross.yml --ref main -f from=0.2.0 -f to=0.2.1 -f platforms=windows
```

`to` 默认是运行所在的 tag，`from` 默认是比它小的最高正式版本。

它下载两个版本的真实文件，把 `from` 装成服务，放入种子数据，然后：

1. 用 `eta-host upgrade` 升到 `to`。
2. 重新开始，用设置页按钮调用的同一个接口升到 `to`。
3. 重新开始，升到一个站不住的构建（`bad-host.ts`，会毁掉数据，答应 `/up` 后退出），看 `from` 的 worker 把文件和数据库都放回去。

每次之后都校验：文件版本、服务运行、`/up`、页面能打开、种子数量和内容、migration 记录、加密值能解开、会话能打开、接着发一条消息能得到回复。

### 种子数据

`test/upgrade-seed/<版本>/` 是那个版本的 host 真实留下的数据目录（`data/`），和之后要校验的内容（`manifest.json`）。里面全是假数据，`data/secret.key` 也只能解开这些假值。测试取不高于 `from` 的最新一份，由 `from` 自己迁移上来。

schema 或存储格式变了的版本，补一份种子。在隔离环境里做，脚本会清空 `/tmp/eta-seed-home`：

```sh
gh release download v0.3.0 --repo <owner>/<name> --pattern eta-host-linux-x64
chmod +x eta-host-linux-x64
bun scripts/upgrade-e2e/seed.ts ./eta-host-linux-x64 0.3.0
docker run --rm -v "$PWD:/repo:ro" zricethezav/gitleaks detect --source /repo/test/upgrade-seed --no-git
```

脚本用这个版本的二进制起一个 host，HOME 在 `/tmp/eta-seed-home`，模型是 `fake-model.ts`，然后像页面一样通过 wire 调用：建智能体、项目、对话，发消息，让模型发布两版产物、建任务并跑完，存邮箱账号、插件配置，登记机器，建例行任务，改设置。host 退出后把数据目录复制过来并生成 `manifest.json`，再校验一遍。不要手写 SQL，也不要放真实数据，主机名要是假的（`--hostname eta-seed` 的容器里生成）。

## 没有签名

这些文件都没有签名和公证。桌面应用没有自动更新：新版本要重新下载安装。macOS 和 Windows 第一次打开时都会拦下来，放行一次之后就正常了。

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

## 装成服务

`eta-host install-service <参数>` 把这个文件注册成服务，开机或登录时启动，崩溃了会重启。再运行一次就是换参数并重启。`eta-host uninstall-service` 去掉服务，数据留在 `~/.eta`。

| 平台    | 是什么                          | 什么时候启动          | 要什么权限     |
| ------- | ------------------------------- | --------------------- | -------------- |
| Linux   | systemd 用户 unit `io.eta.host` | 登录时，linger 后开机 | 不用           |
| macOS   | LaunchAgent `io.eta.host`       | 登录时                | 不用           |
| Windows | Windows 服务 `io.eta.host`      | 开机                  | 安装时要管理员 |

### Windows 服务

在**管理员终端**里运行（开始菜单搜 Terminal，右键“以管理员身份运行”）：

```powershell
.\eta-host.exe install-service --port 8787
```

文件放在自己能写的目录里，比如 `%LOCALAPPDATA%\eta`，不要放 `Program Files`：host 升级时要替换它旁边的文件，host 本身没有管理员权限。

服务以**运行这条命令的账号**运行。host 下面的智能体要读这个用户的 Claude、Codex 和 `gh` 登录状态和 `~/.eta`，换成 LocalSystem 既读不到，智能体以 SYSTEM 运行也太危险。所以安装时要输入一次 Windows 密码：

- 密码从控制台读取，不回显，通过 `CreateServiceW` 交给 Windows 保存，不进命令行、日志和磁盘文件。脚本里可以从标准输入传一行。
- 这个账号会得到“作为服务登录”权限。卸载时收回，账号原来就有的不动。
- 这个账号可以不用管理员启动和停止这两个服务，所以 `eta-host upgrade` 和设置里的按钮都不需要管理员。
- **账号是管理员时，host 和智能体都带完整的管理员权限**，没有 UAC 提示：UAC 只拆分交互登录，服务拿到的是完整令牌。这比 Linux、macOS 的用户服务权限大。不能用受限令牌解决：在 session 0 里，受限令牌启动不了控制台程序（`0xC0000142`），而 host 要启动 git、gh 和智能体。介意的话，用一个普通账号（不在 Administrators 组）装服务。
- 改了 Windows 密码之后服务登录不上。运行 `uninstall-service` 再 `install-service`。
- 用微软账号登录的电脑，输入的是微软账号的密码，不是 PIN。

Windows 服务要响应系统的服务控制，这部分用 `bun:ffi` 直接调 `advapi32.dll`（`apps/daemon/src/windows-api.ts`），没有别的二进制，还是一个文件。Windows 运行的是 `eta-host.exe service-run`（`windows-shell.ts`），它只做三件事：启动 `eta-host.exe <参数>`；把“停止”转成 host 的优雅停止，90 秒没结束才强杀；host 崩溃时 10 秒后重启。host 和它启动的所有进程都在一个 job object 里，所以 CLIProxyAPI 这些子进程不会残留。

host 是子进程而不在服务进程里，是因为 Windows 自己的崩溃重启取消不掉，可能正好落在回退恢复数据库的时候；服务没有 stdout，崩溃输出会丢；host 卡死时，它自己的计时器也不会走。

Windows 没有 SIGTERM。壳每次启动时生成一个命名管道的名字，通过 `ETA_STOP_PIPE` 告诉 host（host 读完就从环境里删掉，不传给智能体），host 收到一行就走和 SIGTERM 一样的退出流程。

出问题时看这些：

| 看什么       | 在哪                                                                  |
| ------------ | --------------------------------------------------------------------- |
| host 的输出  | `~/.eta/service/io.eta.host.log`                                      |
| 升级的输出   | `~/.eta/service/io.eta.host-upgrade.log`                              |
| 服务配置     | `~/.eta/service/io.eta.host.json`：运行的命令、环境变量、停止等待时间 |
| 运行状态     | `~/.eta/service/io.eta.host.state.json`，`sc query io.eta.host`       |
| Windows 记录 | 事件查看器：Windows 日志 → 系统，来源 Service Control Manager         |

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

Windows 上要在装服务的那个账号下运行，不需要管理员。别的账号运行会被拒绝，提示是谁装的。

服务在运行时，升级交给一个单独的 worker `io.eta.host-upgrade` 来做。它由服务管理器启动，不是 host 的子进程，所以停服务不会杀掉它。`eta-host upgrade` 只是跟着打印进度：关掉终端、杀掉这条命令、host 停掉，都不影响它。进度写在 `~/.eta/upgrade-status.json`。这个文件不放数据库，因为回退时数据库会被换掉。

| 平台    | worker 是什么                                   | 日志                                         |
| ------- | ----------------------------------------------- | -------------------------------------------- |
| Linux   | 临时用户 unit，不在 host 的 cgroup 里           | `journalctl --user -u io.eta.host-upgrade`   |
| macOS   | 临时 launchd 任务，有自己的进程组               | `~/Library/Logs/eta/io.eta.host-upgrade.log` |
| Windows | 安装时一起注册的一次性服务，不在 host 的 job 里 | `~/.eta/service/io.eta.host-upgrade.log`     |

Windows 上运行中的 exe 不能覆盖或删除，但能改名，所以有两点不同：worker 从 `~/.eta/service` 里的临时副本运行，结束后删除；换文件总是先把旧文件改名成 `.prev`。上一次的 `.prev` 如果还有进程在用（比如还没退出的 `eta-host upgrade`），会先改名成 `.prev.<pid>.old`。回退时同样先把失败的版本改名成 `.prev.<pid>.failed.old`，再换回旧版本：刚运行过的文件可能被占用一阵子，这时能改名，但不能被覆盖。这些 `.old` 文件下次升级时清理，每个约 390 MB。下载的新文件要经过杀毒软件扫描，所以试运行的超时是 2 分钟，其它平台是 20 秒。

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

重启只发生在 `io.eta.host` 正在运行（或崩溃后等服务管理器重新启动）、而且运行的就是这个文件时：

- 服务运行的是别的文件：拒绝，要用那个文件的 `upgrade`。
- 服务没装或者没在运行：备份数据库并替换文件，重启由你来做，不做验证和回退。

host 下面的智能体也可以直接运行 `upgrade`。它自己算在运行的智能体里，所以要加 `--force`，重启时它会被杀掉，升级继续。

服务重启后 daemon 重新连上，host 会把它们换成自己带的版本。

## 升级的来源

上游决定这台 host 运行谁的代码。`SHA256SUMS` 和文件来自同一个地方，只能说明文件完整，防不了上游本身有问题。

按顺序取第一个有的：

1. 命令行 `--repo`，只管这一次。
2. 环境变量 `ETA_RELEASES_URL`。
3. 设置里“更新”一节保存的值，存在 host 的数据库里，服务和后台 worker 都读得到。
4. 编译时写进二进制的默认值：CI 构建的是它自己所在的仓库，本地构建是 `0xfe-project/eta`。`eta-host upgrade --help` 会显示这个值。

设置里只有用户能改，智能体的工具碰不到。服务的环境里有 `ETA_RELEASES_URL` 时它优先，设置页会说明，不提供修改。

四种来源的写法相同：

| 写法                                      | 是什么                               |
| ----------------------------------------- | ------------------------------------ |
| `owner/name`                              | github.com 上的仓库                  |
| `https://github.com/owner/name`           | 同上                                 |
| `https://api.github.com/repos/owner/name` | 同上                                 |
| `https://<主机>/api/v3/repos/owner/name`  | GitHub Enterprise                    |
| 其它 `http(s)` 地址                       | 其它服务器，要答和 GitHub 一样的 API |

地址里不能带账号密码或查询参数：它会显示在页面上，也会写进日志。

取第一个有的 token：

| 上游              | 顺序                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| github.com        | `GH_TOKEN`、`GITHUB_TOKEN`、设置里保存的、`gh auth token --hostname github.com`，都没有就匿名                    |
| GitHub Enterprise | `GH_ENTERPRISE_TOKEN`、`GH_TOKEN`、`GITHUB_TOKEN`、设置里保存的、`gh auth token --hostname <主机>`，都没有就匿名 |
| 其它服务器        | 只用 `ETA_RELEASES_TOKEN`                                                                                        |

环境变量和 `gh` 每次现取，不保存。设置里的“访问令牌”是 eta 唯一保存的 token，适合服务够不着 `gh` 登录的情况：

- 它用 host 的密钥（`~/.eta/secret.key`）加密，存在数据库的 `setting` 表里。数据库备份里也是密文。
- 保存时绑定当时上游的主机，只发给这个主机。之后把上游换到别的主机，它就不再使用，页面会说明。
- 保存后不再显示，页面只知道它属于哪个主机。
- 服务器环境变量里的 token 优先于它，页面会说明。上游是其它服务器时不能保存，也不显示这一行。

token 不进日志、状态文件和错误信息。

GitHub 的凭据不会发给其它服务器，也不会发给下载重定向到的签名地址。只有 `https` 且路径是 `/api/v3/repos/<owner>/<name>` 的地址才算 GitHub Enterprise，所以这个判断只看地址：填了一个这样的地址，`GH_TOKEN` 就会发过去。

服务能走通 `gh`，前提是 `gh` 在它的 `PATH` 上（`PATH` 是 `install-service` 时的 shell 给的），而且读得到登录状态。读不到时错误信息会分开说：

- 没有 `gh`：装上，在设置里保存一个 token，或者给服务设置 `GH_TOKEN`。
- `gh` 没有这个主机的登录：用服务的用户运行 `gh auth login`（Enterprise 加 `--hostname <主机>`），或者在设置里保存一个 token。
- `gh` 有登录但读不到：登录存在钥匙串里，服务够不着。运行 `gh auth login --insecure-storage`，在设置里保存一个 token，或者给服务设置 `GH_TOKEN`。
- 有 token 但读不到仓库：token 没有这个仓库的权限，或者仓库不存在。
- token 被拒绝：过期或者被吊销了。

## Fork 怎么发版

fork 用同一份 `release.yml`，什么都不用改：工作流把 `github.repository` 写进二进制，所以 fork 打 tag 发出的版本默认从 fork 自己升级，用户不用配置。

1. 在 fork 的 Actions 页面启用工作流。private fork 默认是关的。
2. 打 tag 并推到 fork（桌面应用是 `desktop-v*`，同理）：

   ```sh
   git tag v0.2.0
   git push <fork 的 remote> v0.2.0
   ```

3. 等 Release 发布。`check` 里 Turborepo Remote Cache 只属于上游，那一步在 fork 上失败不影响结果，只是第一次跑得久一些。macOS 和 Windows runner 在 private 仓库按倍数计算 Actions 分钟数。
4. 下载 fork 的 `eta-host` 安装，或者已经在跑上游版本的 host 用 `eta-host upgrade --repo <owner>/<name>` 升上来。之后这台 host 默认跟着 fork。

版本要比正在运行的新：比当前版本旧的 release 会被拒绝。fork 是 private 时，host 上要有读得到它的 token，见上一节。

### 设置里的更新按钮

`upgrade` 这个 wire target 提供 `check`、`start`、`cancel`，页面用它们启动 worker。进度走普通 HTTP：页面轮询 `/upgrade/status`，这个地址和页面一样要 token。socket 在重启时最先断、最后恢复，轮询这个地址只需要有没有应答，所以能分清“host 在重启”和“升级结束了”。

下载和等智能体的时候页面照常可用，这时候可能还需要回答智能体。服务一停就显示全屏的等待页，host 回来后读结果：成功就重新载入页面，回退了就说明原因。别的标签页如果在 host 停掉之前没读到进度，看到的是平常的断线提示，host 回来后会提示刷新。

只有编译出来的 host，而且 `io.eta.host` 或桌面应用正在运行这个文件时才有按钮，三个平台都一样。从源码运行、没装服务、服务运行别的文件时只显示原因；Windows 上没装服务时还会说要用管理员终端运行 `install-service`。

### 桌面应用

桌面应用本机模式下自己就是 host 的服务，和 systemd、launchd、Windows 服务并列（`apps/desktop/src/bun/service.ts`，host 一侧是 `apps/eta/src/upgrade/desktop.ts`）。它不跑包里那份 host：第一次启动把包里的 `eta-host` 复制到 `~/.eta/desktop/host/eta-host`，之后一直从那里启动，包里的只是种子。应用升级不会用新种子盖掉已经在那里的 host，host 只从设置里的按钮升级，所以安装包里的文件从来不被改，签名不受影响。

壳在本机回环上开一个只有它和 host 知道 token 的端口，地址和 token 放进 host 的环境变量（host 一启动就从环境里拿掉，它启动的进程看不到）。点按钮后流程和服务一样：host 请壳启动 `eta-host upgrade --worker`，worker 是壳的子进程，不是 host 的，所以 host 停了它还在；它下载、校验、试跑，再请壳停 host、备份数据库、换文件、请壳在原来的端口上启动新版、看 `/up` 和迁移，不行就换回 `eta-host.prev`、恢复数据库、再启动旧版。端口不变，窗口不用换，页面自己的等待页等 host 回来再刷新。壳只替 host 运行 `<host 文件> upgrade …`，别的命令一律拒绝。

升级中途退出应用：还没停 host 的升级会被取消；已经停了 host 的，应用等它做完（成功或者回退）再退出。

本机已经有 host 在用 `~/.eta`（命令行装的 `io.eta.host`，或者在终端里跑的一个）时，壳不再启动第二个，直接打开那一个，也不管它的升级，它的设置页说的是它自己的情况。判断方法是问 host 文件（`eta-host running`）：先看运行中的 host 写的 `~/.eta/running-host.json`（pid 活着、`/up` 有应答才算），再问系统的服务管理器，所以没写这个文件的旧版服务也认得出。那个 host 停了，窗口和远程模式一样 30 秒后显示失败页，重试时重新判断，可能就换成应用自己的 host。

壳被强杀时 host 不会留下：壳和 host 之间的包装脚本每秒看一次壳还在不在，不在了就停掉 host。

Windows 上按钮由服务发起，host 没有管理员权限也够用：安装时已经给这个账号授了启动和停止两个服务的权限。

### 备份

备份在 `~/.eta/backups/upgrade-<UTC 时间>-<旧版本>.sqlite`，用 `VACUUM INTO` 写成，权限 0600，写完做一次 `quick_check`。每次备份后只留最新的 3 个，这个目录里别的文件不动。每个备份和数据库一样大。

服务先停再备份，所以回退不丢数据。只备份 `eta.sqlite`，`~/.eta` 里的会话文件和配置不动。

### 手动回退

迁移不一定能反向执行（比如 `0042` 删了列），所以回到旧版本要同时回到旧数据库。桌面应用的 host 在 `~/.eta/desktop/host/`，先退出应用，换完文件和数据库再打开，不用下面的服务命令：

```sh
systemctl --user stop io.eta.host
cd ~/.local/share/eta/host && mv eta-host.prev eta-host
cp ~/.eta/backups/upgrade-<时间>-<旧版本>.sqlite ~/.eta/eta.sqlite
rm -f ~/.eta/eta.sqlite-wal ~/.eta/eta.sqlite-shm
systemctl --user start io.eta.host
```

macOS 上第一行和最后一行换成 `launchctl bootout gui/$(id -u)/io.eta.host` 和 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.eta.host.plist`。Windows 上是 `sc stop io.eta.host` 和 `sc start io.eta.host`，中间换文件：

```powershell
sc stop io.eta.host
Move-Item -Force eta-host.exe.prev eta-host.exe
Copy-Item -Force "$HOME\.eta\backups\upgrade-<时间>-<旧版本>.sqlite" "$HOME\.eta\eta.sqlite"
Remove-Item -Force "$HOME\.eta\eta.sqlite-wal", "$HOME\.eta\eta.sqlite-shm" -ErrorAction SilentlyContinue
sc start io.eta.host
```

升级之后写入的数据不在备份里，手动回退会丢掉。
