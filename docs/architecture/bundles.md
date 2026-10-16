# 环境包

智能体的环境由它选择的环境包（bundle）构建：一个环境包是一段在构建时运行的脚本，加上它带来的[插件](plugins.md)。一个智能体可以载入任意多个环境包；载入的结果是一个 Docker 镜像，智能体的容器从它运行（见[聊天与运行时架构](chat-runtime.md)）。

## 两种来源

| 来源   | 位置                                  | 内容                                                                                     |
| ------ | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| 内置   | `bundles/<name>/`                     | `bundle.json`（`name`、`description`、`plugins`），可选 `setup` 脚本和它用到的文件；只读 |
| 自定义 | 表 `bundle`，设置里的“环境包”页面编辑 | 名称（小写字母、数字和连字符）、说明、脚本、插件                                         |

内置的环境包现在各带一个插件（agenvo、approval、artifacts、github、grok、groups、memory、oomol、routines、tasks），所以按插件选择的方式不变。新建智能体时默认载入全部内置环境包。

脚本以 root 在镜像里运行，有网络：可以 `apt-get install`、下载工具。不以 `#!` 开头的自定义脚本按 `sh -eu` 执行。脚本运行时的当前目录是环境包在镜像里的目录（`/opt/axp/bundles/<name>`，即 `BUNDLE_ROOT`），`TARGETARCH` 是目标架构。

## 配置

内置环境包可以在 `bundle.json` 里用 `config` 声明需要用户填写的值，例如某个服务的 API key。这样接入一个服务只需要新增环境包目录（脚本安装 CLI，插件带 skill），不用改任何服务：

```json
"config": {
  "type": "object",
  "additionalProperties": false,
  "required": ["EXAMPLE_API_KEY"],
  "properties": {
    "EXAMPLE_API_KEY": { "type": "string", "title": "API key", "writeOnly": true, "maxLength": 256, "description": "在 [控制台](https://example.com) 生成" },
    "EXAMPLE_REGION": { "type": "string", "title": "区域", "maxLength": 32 }
  }
}
```

- 它是标准的 JSON Schema（2020-12）。能写什么由 `apps/control-plane/internal/bundles/config.schema.json` 这个元 schema 规定：`type: object`，`additionalProperties: false`，属性只能是字符串且必须写 `maxLength`（不超过 4096），另外可选 `title`、`description`（Markdown）、`writeOnly`（机密值）、`minLength`、`pattern`。属性名就是环境变量名（大写字母、数字和下划线），不能以 `AXP_`、`SENTRY_`、`CODEX_`、`AKHOOK_`、`NODE_`、`LD_` 开头，也不能是 `PATH`、`HOME` 这类系统变量。校验全部由 [jsonschema-go](https://github.com/google/jsonschema-go) 完成：读取环境包时用元 schema 校验它的 `config`（不合法则控制面启动失败）；保存时用环境包自己的 schema 校验值（必填项除外，允许分次填写）；必填项都有值并通过完整校验时为 `ready`。库的报错会引用值，值里可能有机密，所以 422 `CONFIG_INVALID` 只列出不合格的项名。
- 设置 →「连接」为每个声明了配置的内置环境包生成一张卡片和表单。机密值只写不读，留空表示不替换。值属于环境包，全局只有一份，不分智能体。
- 接口：`GET /api/v1/bundles/{name}/config` 返回非机密的值、已设置的项和 `ready`（必填项都有值）；`PATCH` 的 `values` 里写字符串表示设置，`null` 表示清除，没写的项保持不变；`DELETE` 清除全部。值以 JSON 存在表 `bundle_config` 中，用 AES-256-GCM 加密（密钥由 `AXP_SECRET_KEY` 派生，`auth.Seal`）。`AXP_SECRET_KEY` 换了以后解不开，按未设置处理。
- controller 把 `ready` 的环境包的值作为环境变量放进载入它的智能体的容器。不 `ready` 的环境包，它的插件写进 `AXP_DISABLED_PLUGINS`（其他载入的环境包也带这个插件时除外），runtime 安装插件时跳过它们，智能体看不到用不了的 skill 和工具。值也是容器 spec 的一部分，所以设置、修改或清除之后，容器会在两轮之间被替换。
- 这些值在智能体的容器里，智能体执行的命令也读得到（Codex 0.162.1 默认的 `shell_environment_policy` 会透传名字带 `KEY`、`TOKEN` 的变量，已实测）。所以只适合交给智能体自己使用的凭据。需要对智能体隐藏的凭据，仍然应该像 GitHub、LLM 那样放在服务端，经 runtime 网关代理。

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

镜像的标签是内容的摘要：基础镜像的 ID、Dockerfile、每个环境包的文件（或脚本）和每个插件的文件。所以环境包相同的智能体共用一个镜像；改一个环境包、一个插件，或部署了新的 runtime，摘要就变，controller 构建新镜像，再在智能体空闲时替换它的容器。构建在后台一次一个，用本机的 Docker（`docker build`，controller 挂着它的 socket），镜像留在本机，Nomad 从那里运行（没有镜像仓库）；没有智能体在用的旧镜像每 10 分钟删除。环境包目录里的 `service/` 不进智能体的镜像。

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

## 必选环境包

内置的 `groups` 和 `memory` 在 `bundle.json` 中声明 `required: true`，没有用户必填配置。`POST/PATCH /agents` 保存选择时自动包含必选项，编辑器把它们显示为已选且不可取消。必选只约束智能体的选择，不另建启用状态。旧智能体的补齐属于 #237 的手工迁移，controller 启动时不改数据库。

## 服务

环境包可以带一个和 AXP 一起运行的服务，供载入它的智能体使用（[#243](https://github.com/AkaraChen/axp/issues/243)）。内置的 `memory`（[记忆](memory.md)）和 `agenvo`（远程电脑的中继，见[任务与远程电脑](tasks.md)）就是这样：它们必选，没有关闭开关。

```json
"service": { "protocol": "axp.memory/1", "uses": ["llm"], "database": true }
```

- **jobspec** 是一份普通的 Nomad job（HCL）：内置环境包的在 `service/job.nomad.hcl`，自定义环境包的在 `POST/PATCH /api/v1/bundles` 的 `service.jobspec`。它必须是 `service` 类型；job 的 ID 和命名空间由 controller 改成 `bundle-<name>` 和 AXP 的命名空间（前缀让环境包的名字占不到 AXP 自己的 job，如 `axp`、`infra`），jobspec 里写什么都不算。
- **约定**：有一个与环境包同名的 `service`（`provider = "nomad"`），指向它的 HTTP 端口；用 `address_mode = "alloc"` 注册容器在 bridge 网络上的地址，就不会在宿主上发布端口。网关从 Nomad 的服务发现拿到地址（job 里的 template 按服务渲染路由，变了就热重载），不用为新服务改配置。智能体经 runtime 网关的 `/bundles/<name>/x` 访问它（服务收到 `/<name>/x`，只有载入了这个环境包的智能体能访问，身份在 `X-AXP-Agent-Id`），用户经公共网关的 `/api/bundles/<name>/x`（服务收到 `/api/<name>/x`）。服务按路径前缀区分两者。
- **AXP 给它的**放进每个 task 的环境变量（jobspec 自己写的同名变量会被覆盖）：`AXP_GATEWAY_URL`（runtime 网关）、配置了 Sentry 时的 `SENTRY_DSN`（控制面的项目，经 runtime 网关的 `/sentry`，只有公钥）、`AXP_PUBLIC_URL`、`AXP_VERSION`、`AXP_BUNDLE_SECRET`（它自己的密钥，控制面也能派生）、声明了 `uses` 时的 `AXP_BUNDLE_TOKEN`、`database: true` 时的 `DATABASE_URL`（AXP 在自己的 PostgreSQL 上建的库 `<主库>_bundle_<name>` 和同名账号，带 pgvector，地址是容器看到的宿主 `172.26.64.1`），以及环境包配置（`config`）完整时的值。
- **令牌**只能用 `uses` 里声明的：`llm`（模型的 `/v1`）和其他环境包的服务（按名字）。它碰不到插件路由、GitHub 凭据和管理接口。
- **镜像**：名字是 `axp-<x>`、没有仓库和标签的镜像是 AXP 自己构建的，换成本机 Docker 里本次部署的版本；其他镜像原样使用（Nomad 会拉取）。
- **日志**：controller 关掉每个 task 的 Nomad 日志收集（`logs { disabled = true }`，见 `deploy/README.md`），输出用 `docker logs` 看，错误和日志发到 Rustrak（`SENTRY_DSN`）。
- **卷**：jobspec 里 `type = "host"` 的 `volume`，controller 先在命名空间里创建同名的 host volume（`mkdir` 插件，任何用户可写），再运行 job。
- **共享**：每个 AXP 只有一份，所有载入它的智能体共用，服务自己按智能体隔离数据。
- **发现**：`protocol` 写了时，服务就绪后 controller 读一次它的 `/.well-known/axp-service`（`{"protocol", "version"}`），协议不同就是 `incompatible`。

controller 每 5 秒按环境包目录调谐一次（`internal/bundlesvc`）：算出修订（jobspec、镜像版本和环境变量的摘要），与 job 的 meta 里记的不同时，请 Nomad 解析 jobspec（`/v1/jobs/parse`），改成环境包的，注册它（Nomad 开一次 deployment，滚动替换）；相同时看 deployment 的状态。状态（`deploying`、`ready`、`incompatible`、`error`，加上解析和校验的错误）记在表 `bundle_service`，`GET /api/v1/bundles` 的 `service_status` 就是它；`nomad job status -namespace <ns>` 看 job 本身。环境包或它的服务没了，就停掉并清除 job；**卷和数据库保留**。

服务不就绪时，载入它的智能体照常运行，访问它的路由返回网关的 503；控制面的就绪不依赖任何环境包的服务。
