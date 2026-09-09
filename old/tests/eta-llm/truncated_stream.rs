use eta_llm::{Context, Event, Model, Provider};
use eta_llm_test_providers::TruncatedStreamLLMProvider;
use tokio_stream::StreamExt;

#[tokio::test]
async fn terminates_without_end() {
    let provider = TruncatedStreamLLMProvider;
    let stream = provider.stream(&Model::new("m"), &Context::default(), None);
    let events: Vec<Result<Event, _>> = stream.collect().await;
    assert_eq!(events.len(), 1);
    assert!(matches!(&events[0], Ok(Event::Content(_))));
}
