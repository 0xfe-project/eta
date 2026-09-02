use eta_anycodingagent_config_reader::parse_config;
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
