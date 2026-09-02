use eta_llm::{Context, Event, Model, Provider};
use eta_provider_openai::OpenAiProvider;
use std::collections::BTreeMap;

fn local_env() -> BTreeMap<String, String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env.local");
    let text = std::fs::read_to_string(path).expect(".env.local is required");
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            Some((
                key.trim().to_owned(),
                value.trim().trim_matches(['\'', '"']).to_owned(),
            ))
        })
        .collect()
}

/// Opt-in because it consumes a real provider request. CI keeps using the local
/// wire-format server; developers can run this against DeepSeek-compatible APIs.
#[tokio::test]
#[ignore = "requires .env.local and makes a real API request"]
async fn openai_stream_returns_content() {
    let env = local_env();
    let base = env.get("OPENAI_API_BASE").expect("OPENAI_API_BASE");
    let key = env.get("OPENAI_API_KEY").expect("OPENAI_API_KEY");
    let model_id = env.get("OPENAI_MODEL").expect("OPENAI_MODEL");
    let provider = OpenAiProvider::new(Some(key.clone()), base.clone());
    let model = Model::new(model_id.clone());
    let context = Context {
        messages: vec![serde_json::json!({"role":"user","content":"Reply with OK only."})],
        ..Default::default()
    };
    let opts = serde_json::json!({"max_tokens": 16});
    let mut stream = provider.stream(&model, &context, Some(&opts));
    let mut content = String::new();
    while let Some(item) = tokio_stream::StreamExt::next(&mut stream).await {
        if let Event::Content(value) = item.expect("provider stream") {
            content.push_str(
                value
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default(),
            );
        }
    }
    assert!(!content.trim().is_empty(), "provider returned no content");
}
