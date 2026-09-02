#![doc = include_str!("../README.md")]

use eta_config::{Config, ProviderConfig};
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
        let mut models = BTreeMap::new();
        if selected_provider == Some(id.as_str()) {
            if let Some(model) = selected_model {
                models.insert(model.to_owned(), json!({"name": model}));
            }
        }
        providers.insert(id.clone(), ProviderConfig { options, models });
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
        .map(|id| (id.clone(), json!({"name": id})))
        .collect();
    let mut options = Map::new();
    options.insert("baseURL".into(), json!(base_url));
    if let Some(token) = env.get("ANTHROPIC_AUTH_TOKEN").and_then(Value::as_str) {
        options.insert("apiKey".into(), json!(token));
    }
    options.insert("api".into(), json!("anthropic-messages"));
    Ok(CustomModelImport {
        providers: BTreeMap::from([(
            "claude-custom".into(),
            ProviderConfig {
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
        if let Some(npm) = value.get("npm") {
            options.insert("npm".into(), npm.clone());
        }
        providers.insert(
            id.clone(),
            ProviderConfig {
                options: Value::Object(options),
                models: object_to_btree(value.get("models")),
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
        let mut models = BTreeMap::new();
        for model in models_value.as_array().into_iter().flatten() {
            if let Some(model_id) = model.get("id").and_then(Value::as_str) {
                models.insert(model_id.to_owned(), model.clone());
            }
        }
        providers.insert(
            id.clone(),
            ProviderConfig {
                options: Value::Object(options),
                models,
            },
        );
    }
    Ok(CustomModelImport { providers })
}

fn object_to_btree(value: Option<&Value>) -> BTreeMap<String, Value> {
    value
        .and_then(Value::as_object)
        .map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
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
