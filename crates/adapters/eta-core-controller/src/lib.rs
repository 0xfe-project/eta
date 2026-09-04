//! Session/agent lifecycle helpers shared by the TUI and other clients.
//!
//! This crate owns the glue between an `eta-core` `Agent` and the concrete
//! adapters (provider selection, config loading, adapter prompt building) so
//! embedders stay thin renderers over the engine.

mod config;
mod session;
mod view;

pub use config::{
    config_path, empty_config, load_config_persisted, read_config, set_active_model,
    upsert_provider, write_config,
};
pub use session::{
    SessionHandle, SessionManager, SessionMeta, SessionStatus, SpawnError, SpawnPlan, SpawnRequest,
    assemble_new, assemble_respawn, assemble_resume, default_tools, load_model, load_owner,
    save_model, save_owner, spawn,
};
pub use view::{GoalState, SessionProjection, SessionViewState, ViewUpdate, event_line};

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

/// Run the any-coding-agent import (codex/claude/opencode/pi) and return the
/// flattened `provider/model` entries found, for the `/load-config` display.
/// This is a read-only listing; persisting happens through `load_config`'s
/// one-shot migration path.
pub fn import_model_entries() -> Result<Vec<String>, String> {
    let imported = eta_anycodingagent_config_reader::import_from_default_home()?;
    Ok(imported.model_entries())
}

/// A live watch on `mcp.json`. Each time the file changes, the reloaded
/// registry (server-name list included) is broadcast to every subscriber.
/// Backed by a blocking thread over the fs watcher; drop the receiver to
/// stop caring (the thread exits once all receivers are gone).
pub struct McpWatcher {
    rx: tokio::sync::broadcast::Receiver<Vec<String>>,
    _task: std::thread::JoinHandle<()>,
}

impl McpWatcher {
    /// Start watching `~/.eta/mcp.json`. Returns `None` when the fs watcher
    /// cannot be installed (e.g. sandboxed environments).
    pub fn start() -> Option<Self> {
        let registry = load_mcp_registry();
        let watcher = registry.watch().ok()?;
        let (tx, rx) = tokio::sync::broadcast::channel(8);
        let task = std::thread::spawn(move || {
            loop {
                match watcher.recv_timeout(std::time::Duration::from_secs(3600)) {
                    Ok(reloaded) => {
                        let names: Vec<String> = reloaded.servers.keys().cloned().collect();
                        // Stop once every receiver is gone.
                        if tx.send(names).is_err() {
                            return;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if tx.receiver_count() == 0 {
                            return;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
        });
        Some(Self { rx, _task: task })
    }

    /// Non-blocking receive: `Some(server_names)` when mcp.json changed.
    pub fn try_recv(&mut self) -> Option<Vec<String>> {
        self.rx.try_recv().ok()
    }
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
        if let Some(opts) = cfg.options.as_object().filter(|o| !o.is_empty()) {
            // Normalize reasoningEffort (config spelling) to the wire name.
            let mut wire = serde_json::Map::new();
            for (key, value) in opts {
                let wire_key = match key.as_str() {
                    "reasoningEffort" => "reasoning_effort",
                    other => other,
                };
                wire.insert(wire_key.to_string(), value.clone());
            }
            if let Some(effort) = wire.get("reasoning_effort").and_then(|v| v.as_str()) {
                model.reasoning = Some(true);
                let _ = effort;
            }
            model.request_options = Some(serde_json::Value::Object(wire));
        }
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

/// A tool's display card: name plus its one-line description.
#[derive(Clone, Debug)]
pub struct ToolCard {
    pub name: String,
    pub description: String,
}

/// Find the nearest `AGENTS.md` walking up from `dir` (workspace rules file,
/// same convention as crabcode/claude-code). Returns the file path and its
/// contents, capped at `max_bytes` to keep prompts bounded.
pub fn find_agents_md(
    dir: &std::path::Path,
    max_bytes: usize,
) -> Option<(std::path::PathBuf, String)> {
    let mut dir = if dir.is_dir() {
        dir.to_path_buf()
    } else {
        dir.parent()?.to_path_buf()
    };
    loop {
        let candidate = dir.join("AGENTS.md");
        if candidate.is_file() {
            if let Ok(text) = std::fs::read_to_string(&candidate) {
                let truncated: String = text.chars().take(max_bytes).collect();
                return Some((candidate, truncated));
            }
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Build the client/adapter system prompt describing the environment, host
/// layout, available tools (with descriptions), configured MCP servers, and
/// any workspace `AGENTS.md` rules found above the working directory.
pub fn build_adapter_system_prompt(
    session_id: &str,
    agent_name: &str,
    model_id: &str,
    tools: &[ToolCard],
    mcp_servers: &[String],
    agents_md: Option<(&std::path::Path, &str)>,
) -> String {
    let sessions_dir = eta_fs::sessions_dir();
    let agents_dir = eta_fs::agents_dir();
    let mcp_json = eta_fs::mcp_json();
    let cwd = std::env::current_dir().unwrap_or_default();
    let tool_lines = tools
        .iter()
        .map(|tool| {
            let description = tool.description.lines().next().unwrap_or_default();
            if description.is_empty() {
                format!("- {}", tool.name)
            } else {
                format!("- {} — {}", tool.name, description)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mcp_line = if mcp_servers.is_empty() {
        "none configured".to_string()
    } else {
        mcp_servers.join(", ")
    };
    let rules_section = match agents_md {
        Some((path, contents)) => format!(
            "\n\n## Workspace rules ({})\n\n{}",
            path.display(),
            contents
        ),
        None => String::new(),
    };
    format!(
        r#"You are running as agent "{agent_name}" in session {session_id}.

## Environment
- Sessions directory: {sessions}
- Agents directory: {agents}
- MCP config: {mcp}
- MCP servers: {mcp_line}
- Working directory: {cwd}
- Model: {model_id}

## Available tools
{tool_lines}

You can reference your own session at {sessions}/{session_id}.sqlite and read other agent memories from {agents}/<name>.sqlite.{rules_section}"#,
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
                        options: serde_json::Value::Null,
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

    #[test]
    fn find_agents_md_walks_up_from_nested_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("AGENTS.md"), "workspace rules here").unwrap();
        let nested = root.join("a/b/c");
        std::fs::create_dir_all(&nested).unwrap();
        let (path, contents) = find_agents_md(&nested, 4096).expect("found");
        assert_eq!(path, root.join("AGENTS.md"));
        assert_eq!(contents, "workspace rules here");
    }

    #[test]
    fn find_agents_md_caps_content_and_reports_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(find_agents_md(dir.path(), 4096).is_none());
        std::fs::write(dir.path().join("AGENTS.md"), "x".repeat(100)).unwrap();
        let (_, contents) = find_agents_md(dir.path(), 10).unwrap();
        assert_eq!(contents.len(), 10);
    }

    #[test]
    fn adapter_prompt_includes_tool_descriptions_mcp_and_rules() {
        let dir = tempfile::tempdir().unwrap();
        let rules_path = dir.path().join("AGENTS.md");
        let prompt = build_adapter_system_prompt(
            "s1",
            "dev",
            "openai/gpt-4o",
            &[
                ToolCard {
                    name: "read_file".into(),
                    description: "Read a file from disk".into(),
                },
                ToolCard {
                    name: "mystery".into(),
                    description: String::new(),
                },
            ],
            &["github".into(), "fs".into()],
            Some((rules_path.as_path(), "always run tests")),
        );
        assert!(prompt.contains("- read_file — Read a file from disk"));
        assert!(prompt.contains("- mystery\n") || prompt.contains("- mystery"));
        assert!(!prompt.contains("- mystery —"));
        assert!(prompt.contains("MCP servers: github, fs"));
        assert!(prompt.contains("## Workspace rules ("));
        assert!(prompt.contains("always run tests"));
    }

    #[test]
    fn adapter_prompt_without_rules_or_mcp() {
        let prompt = build_adapter_system_prompt("s1", "dev", "openai/gpt-4o", &[], &[], None);
        assert!(prompt.contains("MCP servers: none configured"));
        assert!(!prompt.contains("Workspace rules"));
    }

    #[test]
    fn reasoning_effort_maps_into_request_options() {
        let mut config = config_with("anthropic");
        config.provider.get_mut("anthropic").unwrap().format =
            eta_config::ProviderFormat::AnthropicMessages;
        config.provider.get_mut("anthropic").unwrap().models.insert(
            "claude-sonnet-4".into(),
            ModelConfig {
                name: "claude-sonnet-4".into(),
                limit: ModelLimit::default(),
                options: serde_json::json!({"reasoningEffort": "high"}),
            },
        );
        let (_provider, model) =
            resolve_provider_model("anthropic/claude-sonnet-4", &config).unwrap();
        assert_eq!(model.reasoning, Some(true));
        let opts = model.request_options.unwrap();
        assert_eq!(opts["reasoning_effort"], "high");
        assert!(opts.get("reasoningEffort").is_none());
    }
}
