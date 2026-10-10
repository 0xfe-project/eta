# 环境包

智能体的环境由它选择的环境包（bundle）构建：一个环境包是一段在构建时运行的脚本，加上它带来的[插件](plugins.md)。一个智能体可以载入任意多个环境包；载入的结果是一个 Docker 镜像，智能体的容器从它运行（见[聊天与运行时架构](chat-runtime.md)）。

## 两种来源

| 来源   | 位置                                  | 内容                                                                                     |
| ------ | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| 内置   | `apps/agent-runtime/bundles/<name>/`  | `bundle.json`（`name`、`description`、`plugins`），可选 `setup` 脚本和它用到的文件；只读 |
| 自定义 | 表 `bundle`，设置里的“环境包”页面编辑 | 名称（小写字母、数字和连字符）、说明、脚本、插件                                         |

内置的环境包现在各带一个插件（agenvo、github、grok、memory、routines、tasks），所以按插件选择的方式不变。新建智能体时默认载入全部内置环境包。

脚本以 root 在镜像里运行，有网络：可以 `apt-get install`、下载工具。不以 `#!` 开头的自定义脚本按 `sh -eu` 执行。脚本运行时的当前目录是环境包在镜像里的目录（`/opt/axp/bundles/<name>`，即 `BUNDLE_ROOT`），`TARGETARCH` 是目标架构。

## 镜像

controller 为每个智能体算出它的镜像：

```dockerfile
FROM axp-agent-runtime:<环境>          # apps/agent-runtime 的基础镜像
ARG TARGETARCH
COPY bundles/<a> /opt/axp/bundles/<a> # 每个环境包，按目录顺序
RUN cd /opt/axp/bundles/<a> && BUNDLE_ROOT=... ./setup
...
COPY plugins /opt/axp/plugins # 这些环境包的插件
RUN axp-plugins chat /opt/axp/plugins /etc/codex /opt/axp/plugins
```

最后一步运行插件自己的 `setup`、把插件编译成 Codex plugin 的本地 marketplace、在 `/etc/codex/config.toml` 里免除插件工具的确认，并把插件的 hook 合成一份 akhook 配置（[插件](plugins.md#chat-目标编译成-codex-plugin)）。

镜像的标签是内容的摘要：基础镜像的 ID、Dockerfile、每个环境包的文件（或脚本）和每个插件的文件。所以环境包相同的智能体共用一个镜像；改一个环境包、一个插件，或部署了新的 runtime，摘要就变，controller 构建新镜像，再在智能体空闲时替换它的容器。构建在后台一次一个，用宿主机 Docker 的 BuildKit（`docker build`，生产的 controller 镜像里带着 Docker CLI）；没有容器在用的旧镜像每 10 分钟清理一次。

构建失败时，智能体显示为不可用，编辑器里显示构建输出的末尾。修改环境包、修改智能体或重启智能体后再构建。

## 接口

| 接口                            | 说明                                                 |
| ------------------------------- | ---------------------------------------------------- |
| `GET /api/v1/bundles`           | 全部环境包：内置的在前，各按名称                     |
| `POST /api/v1/bundles`          | 新建自定义环境包；与内置的重名时 `409 BUNDLE_EXISTS` |
| `PATCH /api/v1/bundles/{name}`  | 修改说明、脚本或插件；载入它的智能体的插件立即更新   |
| `DELETE /api/v1/bundles/{name}` | 删除；还有智能体载入时 `409 BUNDLE_IN_USE`           |
| `GET /api/v1/plugins`           | 环境包可以带的插件                                   |

智能体的 `bundles` 在 `POST /api/v1/agents` 和 `PATCH /api/v1/agents/{id}` 里设置，按目录顺序保存。
