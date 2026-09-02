use async_trait::async_trait;
use eta_core::{CancelToken, Tool};
use eta_mcp::{CallTool, GetTools, McpClient, McpToolDescriptor, McpTransport};
use serde_json::{Value, json};
use std::sync::Arc;

struct Fake;
#[async_trait]
impl McpTransport for Fake {
    async fn list_tools(&self, _: &str) -> Result<Vec<McpToolDescriptor>, String> {
        Ok(vec![McpToolDescriptor {
            name: "echo".into(),
            description: "echo text".into(),
            input_schema: json!({"type":"object"}),
        }])
    }
    async fn call_tool(&self, _: &str, name: &str, arguments: Value) -> Result<Value, String> {
        Ok(json!({"name":name,"arguments":arguments}))
    }
}

#[tokio::test]
async fn call_requires_discovery_and_then_invokes() {
    let client = Arc::new(McpClient::new(Fake));
    let call = CallTool::new(client.clone(), "demo");
    let err = call
        .execute(
            json!({"name":"echo","arguments":{"text":"x"}}),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("discover"));
    let get = GetTools::new(client, "demo");
    let found = get
        .execute(json!({"query":"echo"}), CancelToken::new())
        .await
        .unwrap();
    assert_eq!(found[0]["name"], "echo");
    let result = call
        .execute(
            json!({"name":"echo","arguments":{"text":"x"}}),
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["arguments"]["text"], "x");
}
