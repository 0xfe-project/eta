# 环境包

智能体的环境由它选择的环境包（bundle）构建：一个环境包是一段在构建时运行的脚本，加上它带来的[插件](plugins.md)。一个智能体可以载入任意多个环境包；载入的结果是一个 Docker 镜像，智能体的容器从它运行（见[聊天与运行时架构](chat-runtime.md)）。

## 两种来源

| 来源   | 位置                                  | 内容                                                                                     |
| ------ | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| 内置   | `apps/agent-runtime/bundles/<name>/`  | `bundle.json`（`name`、`description`、`plugins`），可选 `setup` 脚本和它用到的文件；只读 |
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

- 它是标准的 JSON Schema（2020-12）。能写什么由 `apps/control-plane/internal/bundles/config.schema.json` 这个元 schema 规定：`type: object`，`additionalProperties: false`，属性只能是字符串且必须写 `maxLength`（不超过 4096），另外可选 `title`、`description`（Markdown）、`writeOnly`（机密值）、`minLength`、`pattern`。属性名就是环境变量名（大写字母、数字和下划线），不能以 `AXP_`、`OTEL_`、`CODEX_`、`AKHOOK_`、`NODE_`、`LD_` 开头，也不能是 `PATH`、`HOME` 这类系统变量。校验全部由 [jsonschema-go](https://github.com/google/jsonschema-go) 完成：读取环境包时用元 schema 校验它的 `config`（不合法则控制面启动失败）；保存时用环境包自己的 schema 校验值（必填项除外，允许分次填写）；必填项都有值并通过完整校验时为 `ready`。库的报错会引用值，值里可能有机密，所以 422 `CONFIG_INVALID` 只列出不合格的项名。
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

## 必选环境包

内置的 `groups` 和 `memory` 在 `bundle.json` 中声明 `required: true`，没有用户必填配置。`POST/PATCH /agents` 保存选择时自动包含必选项，编辑器把它们显示为已选且不可取消。必选只约束智能体的选择，不另建启用状态。旧智能体的补齐属于 #237 的手工迁移，controller 启动时不改数据库。
