#![doc = include_str!("../README.md")]

use async_trait::async_trait;
use eta_core::{CancelToken, Tool, ToolError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
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

/// User-managed `mcp.json` registry. The file is the explicit allow-list;
/// servers are never discovered implicitly.
#[derive(Clone, Debug, Default)]
pub struct McpRegistry {
    pub servers: std::collections::BTreeMap<String, Value>,
    pub path: PathBuf,
}

impl McpRegistry {
    pub fn load(path: impl Into<PathBuf>) -> Result<Self, String> {
        let path = path.into();
        let value: Value = if path.is_file() {
            serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
        } else {
            json!({"mcpServers": {}})
        };
        let servers = value
            .get("mcpServers")
            .and_then(Value::as_object)
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        Ok(Self { servers, path })
    }

    pub fn server(&self, name: &str) -> Option<&Value> {
        self.servers.get(name)
    }

    pub fn watch(self) -> notify::Result<McpRegistryWatcher> {
        let parent = self.path.parent().unwrap_or(Path::new(".")).to_path_buf();
        let (watcher, receiver) = eta_fs::FsWatcher::watch(&[parent])?;
        Ok(McpRegistryWatcher {
            _watcher: watcher,
            receiver,
            path: self.path,
        })
    }
}

pub struct McpRegistryWatcher {
    _watcher: eta_fs::FsWatcher,
    receiver: std::sync::mpsc::Receiver<eta_fs::WatchEvent>,
    path: PathBuf,
}

impl McpRegistryWatcher {
    pub fn recv_timeout(
        &self,
        timeout: std::time::Duration,
    ) -> Result<McpRegistry, std::sync::mpsc::RecvTimeoutError> {
        loop {
            self.receiver.recv_timeout(timeout)?;
            if let Ok(registry) = McpRegistry::load(self.path.clone()) {
                return Ok(registry);
            }
        }
    }
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
