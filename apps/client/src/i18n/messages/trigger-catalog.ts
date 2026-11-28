import { clientMessages } from "./index";

type Text = readonly [english: string, chinese: string];

interface FieldText {
  title: Text;
  description: Text;
  /** Chinese labels by enum value, for fields whose options are fixed by the backend. */
  options?: Record<string, Text>;
}

interface TriggerText {
  name: Text;
  description: Text;
  fields: Record<string, FieldText>;
}

interface ProviderText {
  label: Text;
  sources: Record<string, Text>;
  triggers: Record<string, TriggerText>;
}

/**
 * Chinese text for the built-in trigger providers' catalogs, which the backend sends in English
 * only. Keyed by id: provider, then source or trigger slug, then config field key. The English
 * side is the backend's own text; a test fails when the backend adds or rewords an entry.
 * Composio's catalog comes from a third party and is not translated.
 */
export const triggerCatalogText: Record<string, ProviderText> = {
  webhook: {
    label: ["Webhook", "Webhook"],
    sources: {
      http: ["Inbound Webhook", "入站 Webhook"],
    },
    triggers: {
      WEBHOOK_RECEIVED: {
        name: ["Webhook received", "收到 Webhook"],
        description: [
          "Triggers when an external service sends an HTTP POST request to this routine's dedicated webhook URL.",
          "外部服务向此定时任务专属的 Webhook 地址发送 HTTP POST 请求时触发。",
        ],
        fields: {
          authMode: {
            title: ["Authentication", "验证方式"],
            description: [
              "How incoming requests are verified in addition to the secret URL token.",
              "除了地址里的密钥令牌，如何验证收到的请求。",
            ],
            options: {
              none: ["URL token only (none)", "仅地址令牌（无）"],
              header: ["Shared secret header", "共享密钥请求头"],
              "hmac-sha256": ["HMAC-SHA256 signature", "HMAC-SHA256 签名"],
            },
          },
          headerName: {
            title: ["Header name", "请求头名称"],
            description: [
              "Optional HTTP header name (defaults to Authorization for header auth, or X-Hub-Signature-256 for HMAC-SHA256).",
              "可选的 HTTP 请求头名称（请求头验证默认用 Authorization，HMAC-SHA256 默认用 X-Hub-Signature-256）。",
            ],
          },
          includeKeywords: {
            title: ["Include keywords", "包含关键词"],
            description: [
              "Optional comma-separated keywords (case-insensitive). Payload text must match at least one.",
              "可选，用逗号分隔的关键词（不区分大小写）。请求内容至少要匹配其中一个。",
            ],
          },
          excludeKeywords: {
            title: ["Exclude keywords", "排除关键词"],
            description: [
              "Optional comma-separated keywords (case-insensitive). Skip requests matching any keyword.",
              "可选，用逗号分隔的关键词（不区分大小写）。匹配任意一个的请求会被跳过。",
            ],
          },
        },
      },
    },
  },
  "web-monitor": {
    label: ["Web Monitor", "网页监控"],
    sources: {
      http: ["Web / JSON Monitor", "网页 / JSON 监控"],
    },
    triggers: {
      WEB_CONTENT_CHANGED: {
        name: ["Web / JSON content changed", "网页 / JSON 内容变化"],
        description: [
          "Polls an HTTP/HTTPS webpage or JSON API and triggers when extracted content changes.",
          "轮询 HTTP/HTTPS 网页或 JSON 接口，提取的内容发生变化时触发。",
        ],
        fields: {
          url: {
            title: ["URL", "地址"],
            description: [
              "HTTP or HTTPS URL to monitor.",
              "要监控的 HTTP 或 HTTPS 地址。",
            ],
          },
          selector: {
            title: ["CSS selector", "CSS 选择器"],
            description: [
              "Optional CSS selector for HTML pages (leave empty when using JSON path or monitoring the whole page).",
              "可选，用于 HTML 页面的 CSS 选择器（使用 JSON 路径或监控整个页面时留空）。",
            ],
          },
          jsonPath: {
            title: ["JSON path", "JSON 路径"],
            description: [
              "Optional JSON path for JSON APIs (e.g. $.data.version or items[0].title).",
              "可选，用于 JSON 接口的 JSON 路径（例如 $.data.version 或 items[0].title）。",
            ],
          },
          method: {
            title: ["HTTP method", "HTTP 方法"],
            description: [
              "HTTP method used when polling the target URL.",
              "轮询目标地址时使用的 HTTP 方法。",
            ],
          },
          headers: {
            title: ["Request headers", "请求头"],
            description: [
              "Optional plain-text HTTP headers as a JSON object (secrets are not supported).",
              "可选，以 JSON 对象填写的明文 HTTP 请求头（不支持密钥）。",
            ],
          },
        },
      },
    },
  },
  "file-watch": {
    label: ["File Watch", "文件监听"],
    sources: {
      fs: ["Local Filesystem", "本地文件系统"],
    },
    triggers: {
      FILE_CHANGED: {
        name: ["File or directory changed", "文件或目录变化"],
        description: [
          "Watches a local file or directory (with fs.watch and periodic stat fallback) and triggers on created, modified, or deleted files.",
          "监听本地文件或目录（使用 fs.watch，并定期 stat 兜底），文件被创建、修改或删除时触发。",
        ],
        fields: {
          path: {
            title: ["Watch path", "监听路径"],
            description: [
              "Absolute path or ~/... path to a local file or directory on this machine.",
              "本机文件或目录的绝对路径，或 ~/... 形式的路径。",
            ],
          },
          glob: {
            title: ["Include glob", "包含的 glob"],
            description: [
              "Optional glob pattern(s) relative to the watched directory (comma-separated, e.g. **/*.md, *.txt).",
              "可选，相对于监听目录的 glob 规则（用逗号分隔，例如 **/*.md, *.txt）。",
            ],
          },
          ignore: {
            title: ["Ignore glob", "忽略的 glob"],
            description: [
              "Optional glob pattern(s) to exclude (comma-separated; .git is always ignored).",
              "可选，要排除的 glob 规则（用逗号分隔；.git 始终被忽略）。",
            ],
          },
          debounceMs: {
            title: ["Debounce (ms)", "防抖（毫秒）"],
            description: [
              "Quiet window in milliseconds to merge rapid changes into a single event (0–60000).",
              "把连续的快速变化合并为一次事件的静默时间，单位毫秒（0–60000）。",
            ],
          },
        },
      },
    },
  },
  rss: {
    label: ["RSS", "RSS"],
    sources: {
      feed: ["RSS / Atom / JSON Feed", "RSS / Atom / JSON Feed 订阅"],
    },
    triggers: {
      RSS_NEW_ITEM: {
        name: ["New feed item", "新订阅条目"],
        description: [
          "Triggers when a new entry is published to an RSS 2.0, Atom 1.0, or JSON Feed 1.1 feed.",
          "RSS 2.0、Atom 1.0 或 JSON Feed 1.1 订阅源发布新条目时触发。",
        ],
        fields: {
          url: {
            title: ["Feed URL", "订阅地址"],
            description: [
              "RSS 2.0, Atom 1.0, or JSON Feed 1.1 URL (http/https).",
              "RSS 2.0、Atom 1.0 或 JSON Feed 1.1 的地址（http/https）。",
            ],
          },
          includeKeywords: {
            title: ["Include keywords", "包含关键词"],
            description: [
              "Optional comma-separated keywords (case-insensitive). Item title or summary must match at least one.",
              "可选，用逗号分隔的关键词（不区分大小写）。条目标题或摘要至少要匹配其中一个。",
            ],
          },
          excludeKeywords: {
            title: ["Exclude keywords", "排除关键词"],
            description: [
              "Optional comma-separated keywords (case-insensitive). Skip items matching any keyword.",
              "可选，用逗号分隔的关键词（不区分大小写）。匹配任意一个的条目会被跳过。",
            ],
          },
        },
      },
    },
  },
  "eta-events": {
    label: ["Eta Events", "eta 事件"],
    sources: {
      tasks: ["eta Tasks", "eta 任务"],
    },
    triggers: {
      "task.status.changed": {
        name: ["Task status changed", "任务状态变化"],
        description: [
          "Triggers when a task changes status (for example moving into in_review, done, or blocked).",
          "任务状态变化时触发（例如进入待验收、已完成或已阻塞）。",
        ],
        fields: {
          to: {
            title: ["Target statuses", "目标状态"],
            description: [
              "Optional target statuses to match (leave empty to match any status change).",
              "可选，要匹配的目标状态（留空则匹配任何状态变化）。",
            ],
            options: taskStatusOptions(),
          },
          from: {
            title: ["Previous statuses", "原状态"],
            description: [
              "Optional previous statuses to match (leave empty to match any).",
              "可选，要匹配的原状态（留空则匹配任意状态）。",
            ],
            options: taskStatusOptions(),
          },
          ...taskOriginFields(),
        },
      },
      "task.run.finished": {
        name: ["Task run finished", "任务运行结束"],
        description: [
          "Triggers when a task run ends (completed, failed, or interrupted).",
          "任务运行结束时触发（已完成、失败或已停止）。",
        ],
        fields: {
          status: {
            title: ["Run statuses", "运行状态"],
            description: [
              "Optional run outcomes to match (leave empty to match any finished run).",
              "可选，要匹配的运行结果（留空则匹配任何已结束的运行）。",
            ],
            options: {
              completed: clientMessages.completed,
              failed: clientMessages.failed,
              interrupted: clientMessages.runStatusStopped,
            },
          },
          ...taskOriginFields(),
        },
      },
    },
  },
};

/** The task statuses' names, as the tasks pages show them. */
function taskStatusOptions(): Record<string, Text> {
  return {
    backlog: clientMessages.backlog,
    todo: clientMessages.taskToDo,
    in_progress: clientMessages.taskInProgress,
    in_review: clientMessages.taskInReview,
    done: clientMessages.taskCompleted,
    blocked: clientMessages.taskBlocked,
    cancelled: clientMessages.taskCancelled,
  };
}

/**
 * The group, creator and assignee dropdowns of both eta-events triggers. Their options are group
 * and agent names from the user's own data, so only the title and description are translated.
 */
function taskOriginFields(): Record<string, FieldText> {
  return {
    group: {
      title: ["Source group", "来源群聊"],
      description: [
        "Optional group chat the task was proposed in, Captain's included (leave empty for any).",
        "可选，任务是在哪个群聊里提出的，包括 Captain 的对话（留空则不限）。",
      ],
    },
    creator: {
      title: ["Creator", "创建者"],
      description: [
        "Optional agent that created the task (leave empty for any creator).",
        "可选，创建任务的智能体（留空则不限创建者）。",
      ],
    },
    assignee: {
      title: ["Assignee", "执行者"],
      description: [
        "Optional executor agent to match (leave empty for any assignee).",
        "可选，要匹配的执行智能体（留空则不限）。",
      ],
    },
  };
}
