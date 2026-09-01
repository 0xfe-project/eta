#![doc = include_str!("../README.md")]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// eta 配置 schema,结构对齐 opencode 的 `opencode.json`。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    /// 默认模型,格式 `provider/model-id`(同 opencode)。
    pub model: String,
    /// 轻量任务的独立模型(标题生成等),可选。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub small_model: Option<String>,
    /// provider-id → 该 provider 的配置。
    #[serde(default)]
    pub provider: BTreeMap<String, ProviderConfig>,
}

/// 单个 provider 的配置(同 opencode 的 `provider.<id>`)。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// 请求 / 认证选项(apiKey / baseURL / timeout / chunkTimeout / setCacheKey …),弱类型。
    #[serde(default)]
    pub options: serde_json::Value,
    /// model-id → 该 model 的覆盖配置(name / limit / cost / reasoning …),弱类型。
    #[serde(default)]
    pub models: BTreeMap<String, serde_json::Value>,
}
