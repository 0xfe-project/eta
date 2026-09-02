#![doc = include_str!("../README.md")]

use eta_config::{Config, ProviderConfig};
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

/// Read an existing agent config and normalize common Codex/Claude/OpenCode/
/// Pi shapes into eta's provider/model schema.
pub fn read_config(path: impl AsRef<Path>) -> Result<Config, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    parse_config(&text)
}

pub fn parse_config(text: &str) -> Result<Config, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let model = value
        .get("model")
        .and_then(|v| v.as_str())
        .or_else(|| value.pointer("/model/id").and_then(|v| v.as_str()))
        .or_else(|| value.pointer("/defaultModel").and_then(|v| v.as_str()))
        .unwrap_or("openai/gpt-4o")
        .to_owned();
    let mut provider = BTreeMap::new();
    if let Some(map) = value.get("provider").and_then(|v| v.as_object()) {
        for (name, cfg) in map {
            provider.insert(
                name.clone(),
                ProviderConfig {
                    options: cfg
                        .get("options")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({})),
                    models: cfg
                        .get("models")
                        .and_then(|v| v.as_object())
                        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                        .unwrap_or_default(),
                },
            );
        }
    }
    Ok(Config {
        model,
        small_model: value
            .get("small_model")
            .and_then(|v| v.as_str())
            .map(String::from),
        provider,
        persona: value
            .get("persona")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Hot-reload snapshot. `assembly_version` is bumped for every accepted
/// config/persona change so callers can invalidate their stable prompt block.
pub struct ConfigWatcher {
    _watcher: eta_fs::FsWatcher,
    receiver: std::sync::mpsc::Receiver<eta_fs::WatchEvent>,
    config_path: PathBuf,
    persona_dir: PathBuf,
    assembly_version: u64,
}

pub struct ConfigSnapshot {
    pub config: Config,
    pub personas: BTreeMap<String, String>,
    pub assembly_version: u64,
}

impl ConfigWatcher {
    pub fn watch(
        config_path: impl Into<PathBuf>,
        persona_dir: impl Into<PathBuf>,
    ) -> notify::Result<Self> {
        let config_path = config_path.into();
        let persona_dir = persona_dir.into();
        let config_parent = config_path.parent().unwrap_or(Path::new(".")).to_path_buf();
        let mut paths = vec![config_parent];
        if persona_dir.exists() {
            paths.push(persona_dir.clone());
        }
        let (watcher, receiver) = eta_fs::FsWatcher::watch(&paths)?;
        Ok(Self {
            _watcher: watcher,
            receiver,
            config_path,
            persona_dir,
            assembly_version: 0,
        })
    }

    pub fn recv_timeout(&mut self, timeout: std::time::Duration) -> Result<ConfigSnapshot, String> {
        self.receiver
            .recv_timeout(timeout)
            .map_err(|e| e.to_string())?;
        let config = read_config(&self.config_path)?;
        let personas = eta_config::load_personas(&config, &self.persona_dir);
        self.assembly_version = self.assembly_version.saturating_add(1);
        Ok(ConfigSnapshot {
            config,
            personas,
            assembly_version: self.assembly_version,
        })
    }
}
