#![doc = include_str!("../README.md")]

use eta_config::{Config, ModelConfig, ModelLimit, ProviderConfig, ProviderFormat};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Supported one-shot import sources.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportSource {
    Codex,
    Claude,
    OpenCode,
    Pi,
}

/// Custom providers/models discovered in installed coding-agent configs.
#[derive(Clone, Debug, Default)]
pub struct CustomModelImport {
    pub providers: BTreeMap<String, ProviderConfig>,
}

impl CustomModelImport {
    /// Merge once into eta config. Existing eta providers win on collisions.
    pub fn apply_to(self, config: &mut Config) {
        for (id, provider) in self.providers {
            config.provider.entry(id).or_insert(provider);
        }
    }

    fn extend(&mut self, other: CustomModelImport) {
        self.providers.extend(other.providers);
    }

    /// Flatten imported providers into sorted `provider/model` entries.
    pub fn model_entries(&self) -> Vec<String> {
        let mut entries = Vec::new();
        for (provider_id, provider) in &self.providers {
            for model_id in provider.models.keys() {
                entries.push(format!("{provider_id}/{model_id}"));
            }
        }
        entries.sort();
        entries
    }
}

/// Read one source config without retaining a watcher or source reference.
pub fn import_file(
    source: ImportSource,
    path: impl AsRef<Path>,
) -> Result<CustomModelImport, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    match source {
        ImportSource::Codex => import_codex(&text),
        ImportSource::Claude => import_claude(&text),
        ImportSource::OpenCode => import_opencode(&text),
        ImportSource::Pi => import_pi(&text),
    }
}

/// Import from conventional locations. Missing clients are ignored.
pub fn import_from_home(home: impl AsRef<Path>) -> Result<CustomModelImport, String> {
    let mut imported = CustomModelImport::default();
    for (source, path) in source_paths(home) {
        if path.is_file() {
            imported.extend(import_file(source, path)?);
        }
    }
    Ok(imported)
}

/// Import from an arbitrary path, auto-detecting the source by extension.
/// `.toml` is Codex; JSON tries OpenCode, then Claude, then Pi.
pub fn import_path(path: impl AsRef<Path>) -> Result<CustomModelImport, String> {
    let path = path.as_ref();
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if path.extension().and_then(|e| e.to_str()) == Some("toml") {
        return import_codex(&text);
    }
    for parse in [import_opencode, import_claude, import_pi] {
        let imported = parse(&text)?;
        if !imported.providers.is_empty() {
            return Ok(imported);
        }
    }
    Ok(CustomModelImport::default())
}

/// Codex custom endpoints live in `[model_providers.<id>]`. Its active model is
/// attached only to the selected custom provider.
pub fn import_codex(text: &str) -> Result<CustomModelImport, String> {
    let root: toml::Value = toml::from_str(text).map_err(|e| e.to_string())?;
    let selected_provider = root.get("model_provider").and_then(toml::Value::as_str);
    let selected_model = root.get("model").and_then(toml::Value::as_str);
    let mut providers = BTreeMap::new();
    let Some(custom) = root.get("model_providers").and_then(toml::Value::as_table) else {
        return Ok(CustomModelImport { providers });
    };
    for (id, value) in custom {
        let options = serde_json::to_value(value).map_err(|e| e.to_string())?;
        let format = format_from_codex(value.get("wire_api").and_then(toml::Value::as_str));
        let mut models = BTreeMap::new();
        if selected_provider == Some(id.as_str()) {
            if let Some(model) = selected_model {
                models.insert(
                    model.to_string(),
                    ModelConfig {
                        name: model.to_string(),
                        limit: ModelLimit::default(),
                    },
                );
            }
        }
        providers.insert(
            id.clone(),
            ProviderConfig {
                format,
                options,
                models,
            },
        );
    }
    Ok(CustomModelImport { providers })
}

/// Claude custom models are expressed through `ANTHROPIC_BASE_URL` and the
/// `ANTHROPIC_*_MODEL` environment settings.
pub fn import_claude(text: &str) -> Result<CustomModelImport, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let Some(env) = root.get("env").and_then(Value::as_object) else {
        return Ok(CustomModelImport::default());
    };
    let Some(base_url) = env.get("ANTHROPIC_BASE_URL").and_then(Value::as_str) else {
        return Ok(CustomModelImport::default());
    };
    let mut model_ids = BTreeSet::new();
    for (key, value) in env {
        if (key == "ANTHROPIC_MODEL"
            || (key.starts_with("ANTHROPIC_DEFAULT_") && key.ends_with("_MODEL")))
            && let Some(id) = value.as_str()
        {
            model_ids.insert(id.to_owned());
        }
    }
    let models = model_ids
        .into_iter()
        .map(|id| {
            (
                id.clone(),
                ModelConfig {
                    name: id,
                    limit: ModelLimit::default(),
                },
            )
        })
        .collect();
    let mut options = Map::new();
    options.insert("baseURL".into(), json!(base_url));
    if let Some(token) = env.get("ANTHROPIC_AUTH_TOKEN").and_then(Value::as_str) {
        options.insert("apiKey".into(), json!(token));
    }
    Ok(CustomModelImport {
        providers: BTreeMap::from([(
            "claude-custom".into(),
            ProviderConfig {
                format: ProviderFormat::AnthropicMessages,
                options: Value::Object(options),
                models,
            },
        )]),
    })
}

/// OpenCode already uses eta's target provider shape. Only that table is read.
pub fn import_opencode(text: &str) -> Result<CustomModelImport, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut providers = BTreeMap::new();
    for (id, value) in root
        .get("provider")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let mut options = value
            .get("options")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(npm) = value.get("npm").and_then(Value::as_str) {
            options.insert("npm".into(), json!(npm));
        }
        let format = format_from_opencode(value.get("npm").and_then(Value::as_str));
        let models = parse_models(value.get("models"));
        providers.insert(
            id.clone(),
            ProviderConfig {
                format,
                options: Value::Object(options),
                models,
            },
        );
    }
    Ok(CustomModelImport { providers })
}

/// Pi stores providers under `providers` and their models as arrays.
pub fn import_pi(text: &str) -> Result<CustomModelImport, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut providers = BTreeMap::new();
    for (id, value) in root
        .get("providers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let mut options = value.as_object().cloned().unwrap_or_default();
        let models_value = options.remove("models").unwrap_or_else(|| json!([]));
        let format = format_from_pi(value.get("api").and_then(Value::as_str));
        let models = parse_pi_models(&models_value);
        providers.insert(
            id.clone(),
            ProviderConfig {
                format,
                options: Value::Object(options),
                models,
            },
        );
    }
    Ok(CustomModelImport { providers })
}

fn format_from_codex(wire_api: Option<&str>) -> ProviderFormat {
    match wire_api {
        Some("responses") => ProviderFormat::OpenAiResponses,
        Some("messages") => ProviderFormat::AnthropicMessages,
        _ => ProviderFormat::OpenAiChatCompletion,
    }
}

fn format_from_opencode(npm: Option<&str>) -> ProviderFormat {
    match npm {
        Some(value) if value.contains("anthropic") => ProviderFormat::AnthropicMessages,
        _ => ProviderFormat::OpenAiChatCompletion,
    }
}

fn format_from_pi(api: Option<&str>) -> ProviderFormat {
    match api {
        Some(value) if value.contains("anthropic") => ProviderFormat::AnthropicMessages,
        Some(value) if value.contains("responses") => ProviderFormat::OpenAiResponses,
        _ => ProviderFormat::OpenAiChatCompletion,
    }
}

fn parse_models(value: Option<&Value>) -> BTreeMap<String, ModelConfig> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(id, model)| (id.clone(), model_config_from(model, id)))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_pi_models(value: &Value) -> BTreeMap<String, ModelConfig> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model.get("id").and_then(Value::as_str)?;
            Some((id.to_string(), model_config_from(model, id)))
        })
        .collect()
}

fn model_config_from(value: &Value, id: &str) -> ModelConfig {
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(id)
        .to_string();
    let limit = value
        .get("limit")
        .map(|limit| ModelLimit {
            context: limit.get("context").and_then(Value::as_u64).unwrap_or(0),
            output: limit.get("output").and_then(Value::as_u64).unwrap_or(0),
        })
        .unwrap_or_default();
    ModelConfig { name, limit }
}

pub fn source_paths(home: impl AsRef<Path>) -> Vec<(ImportSource, PathBuf)> {
    let home = home.as_ref();
    vec![
        (ImportSource::Codex, home.join(".codex/config.toml")),
        (ImportSource::Claude, home.join(".claude/settings.json")),
        (
            ImportSource::OpenCode,
            home.join(".config/opencode/opencode.json"),
        ),
        (ImportSource::Pi, home.join(".pi/agent/models.json")),
    ]
}
