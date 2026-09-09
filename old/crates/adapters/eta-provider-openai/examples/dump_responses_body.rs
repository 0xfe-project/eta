//! Dump the request body we'd send to /v1/responses for debugging 422s.

use serde_json::json;

fn main() {
    let context = json!({
        "system_prompt": "You are Eta",
        "adapter_system_prompt": null,
        "messages": [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
            {"role": "user", "content": "What's 2+2?"},
        ],
        "tools": []
    });
    
    let input = responses_input(&context);
    let body = json!({
        "model": "deepseek-v4-flash-0731",
        "input": input,
        "stream": true,
    });
    
    println!("{}", serde_json::to_string_pretty(&body).unwrap());
}

fn join_system_prompts(a: &Option<String>, b: &Option<String>) -> Option<String> {
    match (a, b) {
        (Some(x), Some(y)) => Some(format!("{}\n\n{}", x, y)),
        (Some(x), None) | (None, Some(x)) => Some(x.clone()),
        _ => None,
    }
}

fn responses_input(context: &serde_json::Value) -> Vec<serde_json::Value> {
    use serde_json::Value;
    let mut input = Vec::new();
    let sys = context.get("system_prompt").and_then(Value::as_str).map(String::from);
    let ada = context.get("adapter_system_prompt").and_then(Value::as_str).map(String::from);
    if let Some(system) = join_system_prompts(&sys, &ada) {
        input.push(json!({
            "role": "system",
            "content": [{"type": "input_text", "text": system}],
        }));
    }
    if let Some(messages) = context.get("messages").and_then(Value::as_array) {
        for message in messages {
            input.extend(responses_message(message));
        }
    }
    input
}

fn responses_message(message: &serde_json::Value) -> Vec<serde_json::Value> {
    use serde_json::Value;
    match message.get("role").and_then(Value::as_str).unwrap_or("") {
        "user" => {
            let text = message.get("content").and_then(Value::as_str).unwrap_or("");
            vec![json!({"role":"user","content":[{"type":"input_text","text":text}]})]
        }
        "assistant" => {
            let mut content = Vec::new();
            if let Some(text) = message.get("content").and_then(Value::as_str) {
                if !text.is_empty() {
                    content.push(json!({"type": "output_text", "text": text}));
                }
            }
            if content.is_empty() {
                return vec![];
            }
            vec![json!({"role": "assistant", "content": content})]
        }
        _ => vec![],
    }
}
