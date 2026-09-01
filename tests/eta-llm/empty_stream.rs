use eta_llm::{Context, Event, Model, Provider};
use eta_llm_test_providers::EmptyStreamLLMProvider;
use tokio_stream::StreamExt;

#[tokio::test]
async fn yields_no_events() {
    let provider = EmptyStreamLLMProvider;
    let stream = provider.stream(&Model::new("m"), &Context::default(), None);
    let events: Vec<Result<Event, _>> = stream.collect().await;
    assert!(events.is_empty());
}
