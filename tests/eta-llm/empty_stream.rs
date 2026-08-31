use eta_llm::{Context, Event, Provider};
use eta_llm_test_providers::EmptyStreamLLMProvider;
use tokio_stream::StreamExt;

#[tokio::test]
async fn yields_no_events() {
    let provider = EmptyStreamLLMProvider;
    let stream = provider.stream("m", &Context::default(), None).unwrap();
    let events: Vec<Event> = stream.collect().await;
    assert!(events.is_empty());
}
