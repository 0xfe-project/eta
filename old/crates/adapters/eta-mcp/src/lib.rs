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
    #[serde(rename = "inputSchema", alias = "input_schema")]
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

/// Real stdio MCP transport backed by the explicit registry. Each operation
/// starts a short-lived server session, performs the MCP initialize handshake,
/// sends one request, then closes stdin. This favors isolation and correctness;
/// a future connection pool can reuse long-lived processes behind the trait.
pub struct StdioMcpTransport {
    registry: McpRegistry,
}

impl StdioMcpTransport {
    pub fn new(registry: McpRegistry) -> Self {
        Self { registry }
    }

    async fn request(&self, server: &str, method: &str, params: Value) -> Result<Value, String> {
        let config = self
            .registry
            .server(server)
            .cloned()
            .ok_or_else(|| format!("unknown MCP server: {server}"))?;
        let method = method.to_owned();
        tokio::task::spawn_blocking(move || run_stdio_request(&config, &method, params))
            .await
            .map_err(|e| e.to_string())?
    }
}

#[async_trait]
impl McpTransport for StdioMcpTransport {
    async fn list_tools(&self, server: &str) -> Result<Vec<McpToolDescriptor>, String> {
        let result = self.request(server, "tools/list", json!({})).await?;
        serde_json::from_value(result.get("tools").cloned().unwrap_or_else(|| json!([])))
            .map_err(|e| e.to_string())
    }

    async fn call_tool(&self, server: &str, name: &str, arguments: Value) -> Result<Value, String> {
        self.request(
            server,
            "tools/call",
            json!({"name": name, "arguments": arguments}),
        )
        .await
    }
}

fn run_stdio_request(config: &Value, method: &str, params: Value) -> Result<Value, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let command = config
        .get("command")
        .and_then(Value::as_str)
        .ok_or("MCP command is required")?;
    let mut process = Command::new(command);
    if let Some(args) = config.get("args").and_then(Value::as_array) {
        process.args(args.iter().filter_map(Value::as_str));
    }
    if let Some(env) = config.get("env").and_then(Value::as_object) {
        process.envs(env.iter().filter_map(|(k, v)| v.as_str().map(|v| (k, v))));
    }
    let mut child = process
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("MCP stdin unavailable")?;
    let messages = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"eta","version":"0.1.0"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
        json!({"jsonrpc":"2.0","id":2,"method":method,"params":params}),
    ];
    for message in messages {
        writeln!(stdin, "{message}").map_err(|e| e.to_string())?;
    }
    drop(stdin);
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_u64) == Some(2) {
            if let Some(error) = value.get("error") {
                return Err(error.to_string());
            }
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
    }
    Err("MCP server returned no response for request 2".into())
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
