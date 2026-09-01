use eta_llm::{Context, Event, Model, Provider};
use eta_llm_test_providers::MalformedToolCallLLMProvider;
use tokio_stream::StreamExt;

#[tokio::test]
async fn tool_call_arguments_not_an_object() {
    let provider = MalformedToolCallLLMProvider;
    let stream = provider.stream(&Model::new("m"), &Context::default(), None);
    let events: Vec<Result<Event, _>> = stream.collect().await;
    assert_eq!(events.len(), 2);
    match &events[0] {
        Ok(Event::ToolCall {
            name, arguments, ..
        }) => {
            assert_eq!(name, "read");
            assert!(!arguments.is_object());
        }
        _ => panic!("expected a tool call"),
    }
    assert!(matches!(&events[1], Ok(Event::End { .. })));
}
