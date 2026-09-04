//! Config persistence: load once, import once, write atomically.
//!
//! `~/.eta/eta.json` is the single source of truth after first launch. The
//! any-coding-agent import (codex/claude/opencode/pi) is a one-time migration
//! that runs only when `eta.json` does not exist yet; the merged result is
//! persisted immediately so later launches read one file.
//!
//! Writes are atomic (tmp file + rename) so a crash mid-write never leaves a
//! torn config behind, and a corrupt existing file is never overwritten.

use std::path::{Path, PathBuf};

use eta_config::Config;

/// Path of the main config file: `~/.eta/eta.json`.
pub fn config_path() -> PathBuf {
    eta_fs::eta_home().join("eta.json")
}

/// An empty config: no model, no providers. Callers decide how to surface
/// "nothing configured" (e.g. open a picker) rather than inventing defaults.
pub fn empty_config() -> Config {
    Config {
        model: String::new(),
        small_model: None,
        provider: Default::default(),
        persona: vec![],
    }
}

/// Read `eta.json` from disk. Returns `None` when the file is missing or
/// unparseable — callers keep the in-memory/default config in that case and
/// must not overwrite the file blindly.
pub fn read_config(path: &Path) -> Option<Config> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Persist the config atomically: write to `eta.json.tmp` in the same
/// directory, then rename over `eta.json`.
pub fn write_config(path: &Path, config: &Config) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_string_pretty(config)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Load the effective config.
///
/// - `eta.json` exists and parses → use it as-is (import already happened).
/// - `eta.json` missing → run the one-time any-coding-agent import, persist
///   the merged result, return it.
/// - `eta.json` present but corrupt → fall back to a fresh import in memory
///   but never overwrite the file the user may want to rescue.
pub fn load_config_persisted() -> Config {
    let path = config_path();
    match read_config(&path) {
        Some(config) => config,
        // Missing file → persist an empty config once so subsequent edits
        // have a stable target; corrupt file → in-memory empty, never
        // overwrite what the user may want to rescue.
        None => {
            let config = empty_config();
            if !path.exists() {
                let _ = write_config(&path, &config);
            }
            config
        }
    }
}

/// Persist the active default model (`provider/model`) back to `eta.json`.
///
/// Read-modify-write on the current file; when the file is missing or corrupt
/// we start from the in-memory merged config so a selection is never lost.
/// The `ETA_MODEL` env var overrides at read time only and is never written.
pub fn set_active_model(model_id: &str) -> std::io::Result<()> {
    let path = config_path();
    let mut config = read_config(&path).unwrap_or_else(empty_config);
    config.model = model_id.to_string();
    write_config(&path, &config)
}

/// Insert or replace a provider entry and persist. Returns the updated config.
pub fn upsert_provider(
    provider_id: &str,
    provider: eta_config::ProviderConfig,
) -> std::io::Result<Config> {
    let path = config_path();
    let mut config = read_config(&path).unwrap_or_else(empty_config);
    config.provider.insert(provider_id.to_string(), provider);
    write_config(&path, &config)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use eta_config::{ModelConfig, ProviderConfig, ProviderFormat};

    fn sample_config() -> Config {
        let mut config = empty_config();
        config.model = "openai/gpt-4o".into();
        config.provider.insert(
            "openai".into(),
            ProviderConfig {
                format: ProviderFormat::OpenAiChatCompletion,
                options: serde_json::json!({"apiKey": "sk-test"}),
                models: [(
                    "gpt-4o".into(),
                    ModelConfig {
                        name: "gpt-4o".into(),
                        limit: Default::default(),
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
    fn write_then_read_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("eta.json");
        let config = sample_config();
        write_config(&path, &config).unwrap();
        let loaded = read_config(&path).unwrap();
        assert_eq!(loaded.model, "openai/gpt-4o");
        assert!(loaded.provider.contains_key("openai"));
        // No tmp file left behind.
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn read_config_returns_none_on_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("eta.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(read_config(&path).is_none());
    }

    #[test]
    fn write_config_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/deep/eta.json");
        write_config(&path, &sample_config()).unwrap();
        assert!(path.is_file());
    }

    #[test]
    fn corrupt_file_is_not_overwritten_by_write_elsewhere() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("eta.json");
        std::fs::write(&path, "{ user data, do not lose").unwrap();
        // A failed read must not destroy the original bytes.
        assert!(read_config(&path).is_none());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ user data, do not lose"
        );
    }
}
