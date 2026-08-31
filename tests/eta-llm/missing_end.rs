use eta_llm::{Context, Event, Provider};
use eta_llm_test_providers::MissingEndLLMProvider;
use tokio_stream::StreamExt;

#[tokio::test]
async fn content_and_tool_call_without_end() {
    let provider = MissingEndLLMProvider;
    let stream = provider.stream("m", &Context::default(), None).unwrap();
    let events: Vec<Event> = stream.collect().await;
    assert_eq!(events.len(), 2);
    assert!(matches!(&events[0], Event::Content(_)));
    assert!(matches!(&events[1], Event::ToolCall { .. }));
}
