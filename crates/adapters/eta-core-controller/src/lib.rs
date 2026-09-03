//! Session/agent lifecycle helpers shared by the TUI and other clients.
//!
//! This crate owns the glue between an `eta-core` `Agent` and the concrete
//! adapters (provider selection, config loading, adapter prompt building) so
//! embedders stay thin renderers over the engine.

mod config;

pub use config::{
    config_path, empty_config, load_config_persisted, read_config, set_active_model,
    upsert_provider, write_config,
};

use std::sync::Arc;

use eta_llm::{Model, Provider};
use eta_mcp::{CallTool, GetTools, McpClient, McpRegistry, StdioMcpTransport};
use eta_provider_anthropic::AnthropicProvider;
use eta_provider_openai::OpenAiProvider;

/// Load MCP registry from `~/.eta/mcp.json`. Returns an empty registry when
/// the file does not exist.
pub fn load_mcp_registry() -> McpRegistry {
    McpRegistry::load(eta_fs::mcp_json()).unwrap_or_default()
}

/// Build MCP GetTools and CallTool adapters for all servers in the registry.
///
/// Returns a list of boxed `Tool` implementations ready to inject into the
/// agent's tool list.
pub fn mcp_tools(registry: &McpRegistry) -> Vec<Arc<dyn eta_core::Tool>> {
    let mut tools: Vec<Arc<dyn eta_core::Tool>> = Vec::new();
    let transport = StdioMcpTransport::new(registry.clone());
    let client = Arc::new(McpClient::new(transport));
    for server in registry.servers.keys() {
        tools.push(Arc::new(GetTools::new(client.clone(), server)));
        tools.push(Arc::new(CallTool::new(client.clone(), server)));
    }
    tools
}

/// Load the user's provider/model catalog.
///
/// `~/.eta/eta.json` is the single source of truth. On first launch (no
/// `eta.json` yet) a one-time import from installed coding-agent configs
/// (codex/claude/opencode/pi) runs and the merged result is persisted
/// immediately; later launches read the file directly. No default model is
/// invented: with nothing configured the returned config has an empty `model`
/// and callers decide how to surface that (e.g. open a picker).
pub fn load_config() -> eta_config::Config {
    load_config_persisted()
}

/// The model that is currently selected, either from `~/.eta/eta.json` or the
/// `ETA_MODEL` env override. Empty when nothing is configured.
pub fn configured_model(config: &eta_config::Config) -> Option<String> {
    std::env::var("ETA_MODEL")
        .ok()
        .filter(|m| !m.is_empty())
        .or_else(|| (!config.model.is_empty()).then(|| config.model.clone()))
}

/// Whether the config yields at least one usable `provider/model` entry.
pub fn has_models(config: &eta_config::Config) -> bool {
    config_provider_models(config).next().is_some()
}

/// All `provider/model` entries in the config (sorted).
pub fn model_entries(config: &eta_config::Config) -> Vec<String> {
    let mut entries: Vec<String> = config_provider_models(config).collect();
    entries.sort();
    entries
}

/// Iterate `provider/model` pairs from a config's provider model maps.
fn config_provider_models(config: &eta_config::Config) -> impl Iterator<Item = String> + '_ {
    config.provider.iter().flat_map(|(provider_id, provider)| {
        provider
            .models
            .keys()
            .map(move |model_id| format!("{provider_id}/{model_id}"))
    })
}

/// Resolve a `provider/model` entry into a provider + model carrying the
/// provider's base URL and wire protocol.
///
/// Returns `None` when the provider id is not in the config — the caller
/// decides how to surface "no such provider" (a config prompt) rather than
/// falling back to a default that was never chosen.
pub fn resolve_provider_model(
    model_id: &str,
    config: &eta_config::Config,
) -> Option<(Arc<dyn Provider>, Model)> {
    let (provider_id, model_id_only) = model_id.split_once('/').unwrap_or((model_id, model_id));
    let provider_cfg = config.provider.get(provider_id)?;
    let base = provider_cfg
        .options
        .get("baseURL")
        .or_else(|| provider_cfg.options.get("base_url"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let key = provider_cfg
        .options
        .get("apiKey")
        .or_else(|| provider_cfg.options.get("api_key"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let mut model = Model::new(model_id_only);
    model.api = Some(provider_cfg.format.as_str().to_string());
    model.base_url = Some(base.to_string());
    if let Some(cfg) = provider_cfg.models.get(model_id_only) {
        model.context_window = (cfg.limit.context > 0).then_some(cfg.limit.context);
        model.max_tokens = (cfg.limit.output > 0).then_some(cfg.limit.output);
    }
    if model.context_window.is_none() {
        model.context_window = known_context_window(&model.id);
    }
    let provider: Arc<dyn Provider> =
        if provider_cfg.format == eta_config::ProviderFormat::AnthropicMessages {
            Arc::new(AnthropicProvider::new(
                (!key.is_empty()).then(|| key.to_string()),
                base,
            ))
        } else {
            Arc::new(OpenAiProvider::new(
                (!key.is_empty()).then(|| key.to_string()),
                base,
            ))
        };
    Some((provider, model))
}

/// Known context-window sizes for common model families, keyed by id prefix.
///
/// Used only as a fallback when the config does not specify a limit. Values are
/// token counts, mirrored from the models each provider documents.
pub fn known_context_window(model_id: &str) -> Option<u64> {
    match model_id {
        id if id.starts_with("gpt-4o") => Some(128_000),
        id if id.starts_with("gpt-4-turbo") => Some(128_000),
        id if id.starts_with("gpt-4") => Some(8_192),
        id if id.starts_with("gpt-3.5") => Some(16_385),
        id if id.starts_with("o1") || id.starts_with("o3") || id.starts_with("o4") => Some(200_000),
        id if id.starts_with("claude-3-5")
            || id.starts_with("claude-3.5")
            || id.starts_with("claude-3")
            || id.starts_with("claude-sonnet")
            || id.starts_with("claude-opus")
            || id.starts_with("claude-fable") =>
        {
            Some(200_000)
        }
        id if id.starts_with("deepseek") => Some(64_000),
        _ => None,
    }
}

/// Build the client/adapter system prompt describing the environment, host
/// layout, and available tools so the model knows where it is running.
pub fn build_adapter_system_prompt(
    session_id: &str,
    agent_name: &str,
    model_id: &str,
    tool_names: &[String],
) -> String {
    let sessions_dir = eta_fs::sessions_dir();
    let agents_dir = eta_fs::agents_dir();
    let mcp_json = eta_fs::mcp_json();
    let cwd = std::env::current_dir().unwrap_or_default();
    let tool_lines = tool_names
        .iter()
        .map(|name| format!("- {name}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"You are running as agent "{agent_name}" in session {session_id}.

## Environment
- Sessions directory: {sessions}
- Agents directory: {agents}
- MCP config: {mcp}
- Working directory: {cwd}
- Model: {model_id}

## Available tools
{tool_lines}

You can reference your own session at {sessions}/{session_id}.sqlite and read other agent memories from {agents}/<name>.sqlite."#,
        sessions = sessions_dir.display(),
        agents = agents_dir.display(),
        mcp = mcp_json.display(),
        cwd = cwd.display(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use eta_config::{ModelConfig, ModelLimit, ProviderConfig, ProviderFormat};

    fn config_with(provider_id: &str) -> eta_config::Config {
        let mut config = eta_config::Config {
            model: "openai/gpt-4o".into(),
            small_model: None,
            provider: Default::default(),
            persona: vec![],
        };
        config.provider.insert(
            provider_id.into(),
            ProviderConfig {
                format: ProviderFormat::OpenAiChatCompletion,
                options: serde_json::json!({
                    "baseURL": "https://api.example.com/v1",
                    "apiKey": "sk-test",
                }),
                models: [(
                    "gpt-4o".into(),
                    ModelConfig {
                        name: "gpt-4o".into(),
                        limit: ModelLimit {
                            context: 128_000,
                            output: 4_096,
                        },
                    },
                )]
                .into_iter()
                .collect(),
            },
        );
        config
    }

    #[test]
    fn no_default_model_when_absent() {
        let config = eta_config::Config {
            model: String::new(),
            small_model: None,
            provider: Default::default(),
            persona: vec![],
        };
        assert_eq!(configured_model(&config), None);
        assert!(!has_models(&config));
        assert!(model_entries(&config).is_empty());
    }

    #[test]
    fn configured_model_returns_eta_model_first() {
        let config = config_with("openai");
        // No ETA_MODEL in test env, so the config's model wins.
        assert_eq!(configured_model(&config).as_deref(), Some("openai/gpt-4o"));
    }

    #[test]
    fn model_entries_flatten_providers() {
        let config = config_with("openai");
        assert_eq!(model_entries(&config), vec!["openai/gpt-4o".to_string()]);
        assert!(has_models(&config));
    }

    #[test]
    fn resolves_known_model_and_context_window() {
        let config = config_with("openai");
        let (_provider, model) =
            resolve_provider_model("openai/gpt-4o", &config).expect("provider resolves");
        assert_eq!(model.id, "gpt-4o");
        assert_eq!(model.context_window, Some(128_000));
        assert_eq!(model.max_tokens, Some(4_096));
    }

    #[test]
    fn missing_provider_returns_none_not_fallback() {
        let config = config_with("openai");
        let resolved = resolve_provider_model("nope/claude", &config);
        assert!(
            resolved.is_none(),
            "unknown provider must not silently fall back"
        );
    }

    #[test]
    fn known_context_windows_match_families() {
        assert_eq!(known_context_window("gpt-4o-mini"), Some(128_000));
        assert_eq!(known_context_window("claude-sonnet-5"), Some(200_000));
        assert_eq!(known_context_window("deepseek-coder"), Some(64_000));
        assert_eq!(known_context_window("unknown-model"), None);
    }
}
