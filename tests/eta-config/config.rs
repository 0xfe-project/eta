use eta_anycodingagent_config_reader::{ConfigWatcher, parse_config};
use eta_config::load_personas;
use std::fs;

#[test]
fn normalizes_config_and_custom_persona_overrides_builtin() {
    let config =
        parse_config(r#"{"model":"anthropic/claude","persona":["思考者","custom"]}"#).unwrap();
    assert_eq!(config.model, "anthropic/claude");
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("custom.persona.md"), "custom body").unwrap();
    fs::write(dir.path().join("思考者.persona.md"), "override body").unwrap();
    let personas = load_personas(&config, dir.path());
    assert_eq!(personas["思考者"], "override body");
    assert_eq!(personas["custom"], "custom body");
}

#[test]
fn config_watcher_reloads_persona_and_bumps_version() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("config.json");
    let persona_dir = dir.path().join("persona");
    fs::create_dir_all(&persona_dir).unwrap();
    fs::write(
        &config_path,
        r#"{"model":"openai/demo","persona":["live"]}"#,
    )
    .unwrap();
    fs::write(persona_dir.join("live.persona.md"), "v1").unwrap();
    let mut watcher = ConfigWatcher::watch(&config_path, &persona_dir).unwrap();
    fs::write(persona_dir.join("live.persona.md"), "v2").unwrap();
    let snapshot = watcher
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    assert_eq!(snapshot.personas["live"], "v2");
    assert_eq!(snapshot.assembly_version, 1);
}
