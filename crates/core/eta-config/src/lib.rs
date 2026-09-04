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
    /// Persona names to load from built-ins or `*.persona.md` files.
    #[serde(default)]
    pub persona: Vec<String>,
}

/// Load configured personas, with custom markdown cards overriding the built-in
/// presets from `eta-system-prompts`. Both sets share the same name namespace.
pub fn load_personas(
    config: &Config,
    directory: impl AsRef<std::path::Path>,
) -> BTreeMap<String, String> {
    let mut available = eta_system_prompts::builtin_personas();
    if let Ok(entries) = std::fs::read_dir(directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md")
                || !path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .ends_with(".persona.md")
            {
                continue;
            }
            if let (Some(stem), Ok(content)) = (
                path.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.trim_end_matches(".persona.md").to_owned()),
                std::fs::read_to_string(&path),
            ) {
                available.insert(stem, content);
            }
        }
    }
    config
        .persona
        .iter()
        .filter_map(|name| available.get(name).map(|body| (name.clone(), body.clone())))
        .collect()
}

/// 单个 provider 的配置。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// 该 provider 用的 wire 协议,只有三种。
    #[serde(default)]
    pub format: ProviderFormat,
    /// 请求 / 认证选项(apiKey / baseURL / timeout / chunkTimeout / setCacheKey …),弱类型。
    #[serde(default)]
    pub options: serde_json::Value,
    /// model-id → 该 model 的配置(name + limit)。
    #[serde(default)]
    pub models: BTreeMap<String, ModelConfig>,
}

/// 三种 wire 协议。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderFormat {
    #[serde(rename = "openai/chat-completion")]
    #[default]
    OpenAiChatCompletion,
    #[serde(rename = "openai/responses")]
    OpenAiResponses,
    #[serde(rename = "anthropic/messages")]
    AnthropicMessages,
}

impl ProviderFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderFormat::OpenAiChatCompletion => "openai/chat-completion",
            ProviderFormat::OpenAiResponses => "openai/responses",
            ProviderFormat::AnthropicMessages => "anthropic/messages",
        }
    }
}

/// 一个 model 的配置:展示名 + 上下文/输出上限。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelConfig {
    pub name: String,
    #[serde(default)]
    pub limit: ModelLimit,
    /// Per-model wire extras (e.g. `reasoningEffort`), merged into request
    /// bodies by providers. Weakly typed, like `ProviderConfig::options`.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub options: serde_json::Value,
}

impl ModelConfig {
    /// A model entry with no limits and no extra wire options.
    pub fn bare(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            limit: ModelLimit::default(),
            options: serde_json::Value::Null,
        }
    }
}

/// 上下文窗口与单次最大输出 token 数。0 表示未知。
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct ModelLimit {
    pub context: u64,
    pub output: u64,
}
