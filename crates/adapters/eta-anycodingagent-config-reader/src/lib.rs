#![doc = include_str!("../README.md")]

use eta_config::{Config, ProviderConfig};
use std::collections::BTreeMap;
use std::path::Path;

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
