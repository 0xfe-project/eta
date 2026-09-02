#![doc = include_str!("../README.md")]

use async_trait::async_trait;
use eta_core::{CancelToken, Tool, ToolError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct McpToolDescriptor {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[async_trait]
pub trait McpTransport: Send + Sync {
    async fn list_tools(&self, server: &str) -> Result<Vec<McpToolDescriptor>, String>;
    async fn call_tool(&self, server: &str, name: &str, arguments: Value) -> Result<Value, String>;
}

/// MCP client that enforces the protocol's discovery-before-invocation rule.
pub struct McpClient<T> {
    transport: T,
    discovered: Mutex<std::collections::HashSet<String>>,
}

impl<T: McpTransport> McpClient<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            discovered: Mutex::new(Default::default()),
        }
    }
    pub async fn discover(&self, server: &str) -> Result<Vec<McpToolDescriptor>, ToolError> {
        let tools = self
            .transport
            .list_tools(server)
            .await
            .map_err(ToolError::Execution)?;
        self.discovered.lock().unwrap().insert(server.to_owned());
        Ok(tools)
    }
    pub async fn call(
        &self,
        server: &str,
        name: &str,
        arguments: Value,
    ) -> Result<Value, ToolError> {
        if !self.discovered.lock().unwrap().contains(server) {
            return Err(ToolError::Execution("discover tools before call".into()));
        }
        self.transport
            .call_tool(server, name, arguments)
            .await
            .map_err(ToolError::Execution)
    }
}

/// SDK-facing discovery tool.  `server` alone returns a full schema list;
/// `query` filters the catalog by substring.
pub struct GetTools<T> {
    client: std::sync::Arc<McpClient<T>>,
    pub server: String,
}
impl<T: McpTransport + 'static> GetTools<T> {
    pub fn new(client: std::sync::Arc<McpClient<T>>, server: impl Into<String>) -> Self {
        Self {
            client,
            server: server.into(),
        }
    }
}
#[async_trait]
impl<T: McpTransport + 'static> Tool for GetTools<T> {
    fn name(&self) -> &str {
        "GetTools"
    }
    fn description(&self) -> &str {
        "Discover MCP tools before invoking them."
    }
    fn schema(&self) -> Value {
        json!({"type":"object","properties":{"query":{"type":"string"}}})
    }
    async fn execute(&self, input: Value, _cancel: CancelToken) -> Result<Value, ToolError> {
        let tools = self.client.discover(&self.server).await?;
        let query = input.get("query").and_then(Value::as_str).unwrap_or("");
        Ok(Value::Array(tools.into_iter().filter(|t| query.is_empty() || t.name.contains(query) || t.description.contains(query)).map(|t| json!({"name":t.name,"description":t.description,"input_schema":t.input_schema})).collect()))
    }
}

pub struct CallTool<T> {
    client: std::sync::Arc<McpClient<T>>,
    pub server: String,
}
impl<T: McpTransport + 'static> CallTool<T> {
    pub fn new(client: std::sync::Arc<McpClient<T>>, server: impl Into<String>) -> Self {
        Self {
            client,
            server: server.into(),
        }
    }
}
#[async_trait]
impl<T: McpTransport + 'static> Tool for CallTool<T> {
    fn name(&self) -> &str {
        "CallTool"
    }
    fn description(&self) -> &str {
        "Invoke an MCP tool after GetTools discovery."
    }
    fn schema(&self) -> Value {
        json!({"type":"object","required":["name","arguments"],"properties":{"name":{"type":"string"},"arguments":{"type":"object"}}})
    }
    async fn execute(&self, input: Value, _cancel: CancelToken) -> Result<Value, ToolError> {
        let name = input
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Validation("name is required".into()))?;
        self.client
            .call(
                &self.server,
                name,
                input.get("arguments").cloned().unwrap_or_else(|| json!({})),
            )
            .await
    }
}
