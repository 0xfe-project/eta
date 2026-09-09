use eta_anycodingagent_config_reader::{
    CustomModelImport, ImportSource, import_claude, import_codex, import_file, import_from_home,
    import_opencode, import_path, import_pi,
};
use eta_config::{Config, ModelConfig, ModelLimit, ProviderConfig, ProviderFormat, load_personas};
use std::collections::BTreeMap;
use std::fs;

#[test]
fn imports_real_codex_custom_provider_shape_only() {
    let imported = import_codex(
        r#"
model_provider = "custom"
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
[model_providers.custom]
name = "CCCoding"
base_url = "https://ccapi.example/v1"
wire_api = "responses"
requires_openai_auth = true
"#,
    )
    .unwrap();
    assert_eq!(imported.providers.len(), 1);
    assert_eq!(
        imported.providers["custom"].options["wire_api"],
        "responses"
    );
    assert_eq!(
        imported.providers["custom"].format,
        ProviderFormat::OpenAiResponses
    );
    assert!(
        imported.providers["custom"]
            .models
            .contains_key("gpt-5.6-sol")
    );
}

#[test]
fn imports_real_claude_env_custom_models() {
    let imported = import_claude(
        r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"secret","ANTHROPIC_BASE_URL":"https://ccapi.example","ANTHROPIC_DEFAULT_OPUS_MODEL":"claude-opus-custom","ANTHROPIC_DEFAULT_SONNET_MODEL":"claude-sonnet-custom"},"model":"ignored","permissions":{"allow":["ignored"]}}"#,
    )
    .unwrap();
    let provider = &imported.providers["claude-custom"];
    assert_eq!(provider.options["baseURL"], "https://ccapi.example");
    assert_eq!(provider.format, ProviderFormat::AnthropicMessages);
    assert_eq!(provider.models.len(), 2);
}

#[test]
fn imports_opencode_provider_table_without_top_level_settings() {
    let imported = import_opencode(
        r#"{"model":"ignore/me","provider":{"custom":{"npm":"@ai-sdk/openai-compatible","models":{"grok-custom":{"name":"Grok"}},"options":{"baseURL":"https://example/v1","apiKey":"secret"}}},"plugin":["ignored"]}"#,
    )
    .unwrap();
    assert_eq!(
        imported.providers["custom"].options["npm"],
        "@ai-sdk/openai-compatible"
    );
    assert_eq!(
        imported.providers["custom"].format,
        ProviderFormat::OpenAiChatCompletion
    );
    assert!(
        imported.providers["custom"]
            .models
            .contains_key("grok-custom")
    );
}

#[test]
fn imports_opencode_array_model_list() {
    let imported = import_opencode(
        r#"{"provider":{"custom":{"models":["gpt-4o","claude-sonnet"],"options":{"baseURL":"https://example/v1"}}}}"#,
    )
    .unwrap();
    assert_eq!(
        imported.providers["custom"]
            .models
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        vec!["claude-sonnet", "gpt-4o"]
    );
}

#[test]
fn imports_pi_provider_model_array() {
    let imported = import_pi(
        r#"{"providers":{"local":{"baseUrl":"http://localhost:1234/v1","api":"openai-completions","models":[{"id":"local-model","name":"Local"}]}}}"#,
    )
    .unwrap();
    assert_eq!(
        imported.providers["local"].options["baseUrl"],
        "http://localhost:1234/v1"
    );
    assert_eq!(
        imported.providers["local"].format,
        ProviderFormat::OpenAiChatCompletion
    );
    assert!(
        imported.providers["local"]
            .models
            .contains_key("local-model")
    );
}

#[test]
fn derives_format_and_parses_model_limit() {
    let imported = import_opencode(
        r#"{"provider":{"my-provider-name":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://api.xxx.com/v1","apiKey":"xxxxx"},"models":{"xxx":{"name":"xxx","limit":{"context":500000,"output":450000}}}}}}"#,
    )
    .unwrap();
    let provider = &imported.providers["my-provider-name"];
    assert_eq!(provider.format, ProviderFormat::OpenAiChatCompletion);
    let model = &provider.models["xxx"];
    assert_eq!(model.name, "xxx");
    assert_eq!(model.limit.context, 500000);
    assert_eq!(model.limit.output, 450000);
}

#[test]
fn one_shot_home_import_preserves_eta_settings() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join(".config/opencode")).unwrap();
    fs::write(
        home.path().join(".config/opencode/opencode.json"),
        r#"{"provider":{"imported":{"models":{"m":{"name":"m"}},"options":{"baseURL":"https://example"}}}}"#,
    )
    .unwrap();
    let imported = import_from_home(home.path()).unwrap();
    let mut config = Config {
        model: "eta/original".into(),
        small_model: None,
        provider: BTreeMap::new(),
        persona: vec!["艺术家".into()],
    };
    imported.apply_to(&mut config);
    assert_eq!(config.model, "eta/original");
    assert_eq!(config.persona, vec!["艺术家"]);
    assert!(config.provider.contains_key("imported"));
}

#[test]
fn custom_persona_loading_remains_independent() {
    let config = Config {
        model: "eta/model".into(),
        small_model: None,
        provider: BTreeMap::new(),
        persona: vec!["思考者".into()],
    };
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("思考者.persona.md"), "override body").unwrap();
    assert_eq!(
        load_personas(&config, dir.path())["思考者"],
        "override body"
    );
}

#[test]
fn import_path_detects_opencode_and_lists_models() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("opencode.json");
    fs::write(
        &path,
        r#"{"provider":{"custom":{"models":{"grok":{"name":"Grok"}},"options":{"baseURL":"https://example"}}}}"#,
    )
    .unwrap();
    let imported = import_path(&path).unwrap();
    assert_eq!(imported.model_entries(), vec!["custom/grok"]);
}

#[test]
fn merge_dedups_providers_and_models() {
    let mut a = CustomModelImport::default();
    a.providers.insert(
        "p".into(),
        ProviderConfig {
            format: ProviderFormat::OpenAiChatCompletion,
            options: serde_json::json!({"baseURL": "https://a"}),
            models: [(
                "m".into(),
                ModelConfig {
                    name: "m".into(),
                    limit: ModelLimit::default(),
                    options: serde_json::Value::Null,
                },
            )]
            .into_iter()
            .collect(),
        },
    );

    let mut b = CustomModelImport::default();
    b.providers.insert(
        "p".into(),
        ProviderConfig {
            format: ProviderFormat::OpenAiChatCompletion,
            options: serde_json::json!({"apiKey": "secret"}),
            models: [(
                "m2".into(),
                ModelConfig {
                    name: "m2".into(),
                    limit: ModelLimit::default(),
                    options: serde_json::Value::Null,
                },
            )]
            .into_iter()
            .collect(),
        },
    );

    a.merge(b);
    let provider = &a.providers["p"];
    assert!(provider.models.contains_key("m"));
    assert!(provider.models.contains_key("m2"));
    assert_eq!(provider.options["baseURL"], "https://a");
    assert_eq!(provider.options["apiKey"], "secret");
}

#[test]
fn codex_import_expands_model_catalog_relative_to_config_dir() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("config.toml"),
        r#"
model_provider = "custom"
model = "active-model"
model_catalog_json = "catalog.json"

[model_providers.custom]
name = "Custom"
base_url = "https://example/v1"
wire_api = "responses"
"#,
    )
    .unwrap();
    fs::write(
        dir.path().join("catalog.json"),
        r#"{"models":[{"slug":"active-model","display_name":"Active"},{"slug":"extra-model","display_name":"Extra"}]}"#,
    )
    .unwrap();

    let imported = import_file(ImportSource::Codex, dir.path().join("config.toml")).unwrap();
    let models = &imported.providers["custom"].models;
    assert!(models.contains_key("active-model"));
    assert!(models.contains_key("extra-model"));
}

#[test]
#[ignore = "requires locally installed coding-agent configs"]
fn imports_installed_custom_models_once() {
    let home = std::env::var_os("HOME").expect("HOME");
    let imported = import_from_home(std::path::PathBuf::from(home)).unwrap();
    assert!(
        !imported.providers.is_empty(),
        "no installed custom providers found"
    );
    assert!(
        imported
            .providers
            .values()
            .any(|provider| !provider.models.is_empty()),
        "installed providers contained no custom models"
    );
}
