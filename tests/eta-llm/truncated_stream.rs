use eta_llm::{Context, Event, Provider};
use eta_llm_test_providers::TruncatedStreamLLMProvider;
use tokio_stream::StreamExt;

#[tokio::test]
async fn terminates_without_end() {
    let provider = TruncatedStreamLLMProvider;
    let stream = provider.stream("m", &Context::default(), None).unwrap();
    let events: Vec<Event> = stream.collect().await;
    assert_eq!(events.len(), 1);
    assert!(matches!(&events[0], Event::Content(_)));
}
