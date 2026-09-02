# eta-config

eta 自己的配置 schema,结构对齐 opencode 的 `opencode.json`:

- `model`(默认模型,`provider/model-id`)
- `small_model`(轻量任务独立模型,可选)
- `provider`(`provider-id` → `{ options, models }`)

供 `eta-anycodingagent-config-reader` 迁入的目标格式。内置 persona 文案统一放在
`eta-system-prompts`,本 crate 负责读取自定义 `*.persona.md` 并与内置 preset 合并。
