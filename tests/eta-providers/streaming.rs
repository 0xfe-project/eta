use eta_llm::{Context, Event, Model, Provider, StopReason};
use eta_provider_anthropic::AnthropicProvider;
use eta_provider_openai::{OpenAiProvider, ResponsesProvider};
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

/// Start a local SSE endpoint that captures the raw HTTP request body so a test
/// can assert exactly what the provider put on the wire.
fn capturing_server(status: u16) -> (String, std::sync::mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let mut buf = Vec::new();
        let mut chunk = [0_u8; 4096];
        let header_end = loop {
            let n = stream.read(&mut chunk).unwrap_or(0);
            if n == 0 {
                break 0;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break pos + 4;
            }
        };
        let headers = String::from_utf8_lossy(&buf[..header_end]).into_owned();
        let content_len = headers
            .lines()
            .find_map(|line| {
                line.trim()
                    .to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .and_then(|v| v.trim().parse::<usize>().ok())
            })
            .unwrap_or(0);
        while buf.len() < header_end + content_len {
            let n = stream.read(&mut chunk).unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let body = String::from_utf8_lossy(&buf[header_end..header_end + content_len]).into_owned();
        let _ = tx.send(body);
        let response = format!(
            "HTTP/1.1 {status} OK\r\nContent-Type: text/event-stream\r\nContent-Length: 16\r\nConnection: close\r\n\r\ndata: [DONE]\\n\\n"
        );
        let _ = stream.write_all(response.as_bytes());
    });
    (format!("http://{addr}"), rx)
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

#[tokio::test]
async fn openai_puts_adapter_system_prompt_on_the_wire() {
    let (url, rx) = capturing_server(200);
    let provider = OpenAiProvider::new(None, url);
    let context = Context {
        system_prompt: Some("engine prompt".into()),
        adapter_system_prompt: Some("adapter tools + env".into()),
        ..Default::default()
    };
    let mut stream = provider.stream(&Model::new("demo"), &context, None);
    while tokio_stream::StreamExt::next(&mut stream).await.is_some() {}

    let body = rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("request body");
    assert!(
        body.contains("engine prompt"),
        "missing engine prompt: {body}"
    );
    assert!(
        body.contains("adapter tools + env"),
        "missing adapter prompt: {body}"
    );
}

#[tokio::test]
async fn openai_responses_sse_translates_text_tool_and_stop() {
    let body = "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"bash\"}}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello \"}\n\ndata: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\\\"command\\\":\"}\n\ndata: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"\\\"pwd\\\"}\"}\n\ndata: {\"type\":\"response.function_call_arguments.done\",\"arguments\":\"{\\\"command\\\":\\\"pwd\\\"}\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"function_call\"}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}\n\n";
    let provider = ResponsesProvider::new(None, server(body, 200));
    let mut stream = provider.stream(&Model::new("demo"), &Context::default(), None);
    let mut saw_text = false;
    let mut saw_tool = false;
    let mut saw_end = false;
    while let Some(item) = tokio_stream::StreamExt::next(&mut stream).await {
        match item.unwrap() {
            Event::Content(value) => saw_text |= value["text"] == "hello ",
            Event::ToolCall { name, .. } => saw_tool |= name == "bash",
            Event::End { stop, .. } => {
                saw_end = true;
                assert_eq!(stop, StopReason::ToolUse);
            }
        }
    }
    assert!(saw_text && saw_tool && saw_end);
}

#[tokio::test]
async fn openai_responses_sends_responses_input_shape() {
    let (url, rx) = capturing_server(200);
    let provider = ResponsesProvider::new(None, url);
    let context = Context {
        system_prompt: Some("sys".into()),
        messages: vec![serde_json::json!({"role":"user","content":"hi"})],
        ..Default::default()
    };
    let mut stream = provider.stream(&Model::new("demo"), &context, None);
    while tokio_stream::StreamExt::next(&mut stream).await.is_some() {}

    let body = rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("request body");
    assert!(body.contains("\"input\""), "missing input: {body}");
    assert!(
        body.contains("\"role\":\"system\""),
        "missing system: {body}"
    );
    assert!(
        body.contains("\"input_text\""),
        "missing input_text: {body}"
    );
    assert!(
        body.contains("\"store\":false"),
        "missing store=false: {body}"
    );
}
