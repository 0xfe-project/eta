# eta-config

eta 自己的配置 schema,结构对齐 opencode 的 `opencode.json`:

- `model`(默认模型,`provider/model-id`)
- `small_model`(轻量任务独立模型,可选)
- `provider`(`provider-id` → `{ options, models }`)

供 `eta-anycodingagent-config-reader` 迁入的目标格式。纯 schema 叶子 crate,只依赖 serde / serde_json。
