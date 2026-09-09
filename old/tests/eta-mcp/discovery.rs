use async_trait::async_trait;
use eta_core::{CancelToken, Tool};
use eta_mcp::{
    CallTool, GetTools, McpClient, McpRegistry, McpToolDescriptor, McpTransport, StdioMcpTransport,
};
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

#[test]
fn registry_loads_explicit_mcp_json_and_reloads() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mcp.json");
    std::fs::write(&path, r#"{"mcpServers":{"local":{"command":"demo"}}}"#).unwrap();
    let registry = McpRegistry::load(&path).unwrap();
    assert_eq!(registry.server("local").unwrap()["command"], "demo");
    let watcher = registry.watch().unwrap();
    std::fs::write(&path, r#"{"mcpServers":{"local":{"command":"updated"}}}"#).unwrap();
    let updated = watcher
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    assert_eq!(updated.server("local").unwrap()["command"], "updated");
}

#[tokio::test]
async fn stdio_transport_runs_registered_server_process() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mcp.json");
    let script = "read a; echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}'; read b; read c; echo '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"echo\",\"description\":\"echo\",\"input_schema\":{\"type\":\"object\"}}]}}'";
    std::fs::write(
        &path,
        serde_json::json!({"mcpServers":{"local":{"command":"sh","args":["-c",script]}}})
            .to_string(),
    )
    .unwrap();
    let transport = StdioMcpTransport::new(McpRegistry::load(&path).unwrap());
    let tools = transport.list_tools("local").await.unwrap();
    assert_eq!(tools[0].name, "echo");
}
