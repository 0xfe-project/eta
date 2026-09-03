//! Config persistence: `eta.json` is the source of truth after first launch.
//!
//! Env-mutating tests serialize on `LOCK` (edition 2024 `set_var` is unsafe).

use std::sync::Mutex;

use eta_config::{ModelConfig, ProviderConfig, ProviderFormat};
use eta_core_controller::{load_config, read_config, set_active_model, upsert_provider};

static LOCK: Mutex<()> = Mutex::new(());

fn with_eta_home(dir: &tempfile::TempDir) {
    unsafe { std::env::set_var("ETA_HOME", dir.path()) };
}

#[test]
fn first_launch_persists_imported_config() {
    let _g = LOCK.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    with_eta_home(&dir);

    // No eta.json yet: load_config must run the one-shot import and persist.
    let loaded = load_config();
    let path = dir.path().join("eta.json");
    assert!(path.is_file(), "first launch must persist eta.json");
    let on_disk = read_config(&path).unwrap();
    assert_eq!(on_disk.model, loaded.model);
    assert_eq!(on_disk.provider.len(), loaded.provider.len());
}

#[test]
fn set_active_model_roundtrips_through_disk() {
    let _g = LOCK.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    with_eta_home(&dir);

    set_active_model("openai/gpt-4o").unwrap();
    let path = dir.path().join("eta.json");
    let config = read_config(&path).unwrap();
    assert_eq!(config.model, "openai/gpt-4o");

    // A "restart" (fresh load) sees the persisted choice.
    let reloaded = load_config();
    assert_eq!(reloaded.model, "openai/gpt-4o");

    // Switching model updates the same file without dropping providers.
    upsert_provider(
        "openai",
        ProviderConfig {
            format: ProviderFormat::OpenAiChatCompletion,
            options: serde_json::json!({"apiKey": "sk-test"}),
            models: [(
                "gpt-4o".into(),
                ModelConfig {
                    name: "gpt-4o".into(),
                    limit: Default::default(),
                },
            )]
            .into_iter()
            .collect(),
        },
    )
    .unwrap();
    set_active_model("openai/gpt-4o-mini").unwrap();
    let config = read_config(&path).unwrap();
    assert_eq!(config.model, "openai/gpt-4o-mini");
    assert!(config.provider.contains_key("openai"));
}

#[test]
fn corrupt_config_is_never_overwritten() {
    let _g = LOCK.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    with_eta_home(&dir);
    let path = dir.path().join("eta.json");
    std::fs::write(&path, "{ precious but broken").unwrap();

    // Load falls back to an in-memory import but leaves the file alone.
    let _ = load_config();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "{ precious but broken"
    );
}

#[test]
fn second_launch_does_not_reimport() {
    let _g = LOCK.lock().unwrap();
    let dir = tempfile::tempdir().unwrap();
    with_eta_home(&dir);

    // Simulate a user-edited config with a marker provider, then reload:
    // the file must win verbatim (no import merge on top of it).
    upsert_provider(
        "marker",
        ProviderConfig {
            format: ProviderFormat::OpenAiChatCompletion,
            options: serde_json::json!({"baseURL": "https://example.invalid"}),
            models: Default::default(),
        },
    )
    .unwrap();
    let before = std::fs::read_to_string(dir.path().join("eta.json")).unwrap();
    let loaded = load_config();
    let after = std::fs::read_to_string(dir.path().join("eta.json")).unwrap();
    assert_eq!(before, after, "load must not rewrite an existing config");
    assert!(loaded.provider.contains_key("marker"));
}
