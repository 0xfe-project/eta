use eta_llm::{Context, Event, Model, Provider, StopReason};
use eta_provider_anthropic::AnthropicProvider;
use eta_provider_openai::OpenAiProvider;
use std::io::{Read, Write};
use std::net::TcpListener;

fn server(body: &'static str, status: u16) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            let response = format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    format!("http://{}", addr)
}

#[tokio::test]
async fn openai_sse_translates_text_and_stop_reason() {
    let body = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n";
    let provider = OpenAiProvider::new(None, server(body, 200));
    let mut stream = provider.stream(&Model::new("demo"), &Context::default(), None);
    let mut saw_text = false;
    let mut saw_end = false;
    while let Some(item) = tokio_stream::StreamExt::next(&mut stream).await {
        match item.unwrap() {
            Event::Content(v) => saw_text |= v["text"] == "hi",
            Event::End { stop, .. } => {
                saw_end = true;
                assert_eq!(stop, StopReason::MaxTokens);
            }
            _ => {}
        }
    }
    assert!(saw_text && saw_end);
}

#[tokio::test]
async fn anthropic_http_errors_are_classified() {
    let provider = AnthropicProvider::new(None, server("{}", 429));
    let mut stream = provider.stream(&Model::new("demo"), &Context::default(), None);
    assert!(matches!(
        tokio_stream::StreamExt::next(&mut stream).await.unwrap(),
        Err(eta_llm::ProviderError::RateLimit)
    ));
}
