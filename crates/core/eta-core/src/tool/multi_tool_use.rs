//! Builtin `multi_tool_use` tool: run multiple tools in parallel.

use std::sync::Arc;

use async_trait::async_trait;

use crate::error::ToolError;
use crate::tool::{CancelToken, Tool};

/// Builtin `multi_tool_use` tool: executes a batch of independent tools in
/// parallel (models mostly emit one tool call per turn, so this is how we get
/// parallelism).
struct MultiToolUseTool {
    registry: Arc<Vec<Arc<dyn Tool>>>,
}

#[async_trait]
impl Tool for MultiToolUseTool {
    fn name(&self) -> &str {
        "multi_tool_use"
    }
    fn description(&self) -> &str {
        "Run multiple independent tools in parallel."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "parallel": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": { "type": "string" },
                            "input": {}
                        },
                        "required": ["name", "input"]
                    }
                }
            },
            "required": ["parallel"]
        })
    }
    async fn execute(
        &self,
        input: serde_json::Value,
        cancel: CancelToken,
    ) -> Result<serde_json::Value, ToolError> {
        let calls = input
            .get("parallel")
            .and_then(|v| v.as_array())
            .ok_or_else(|| ToolError::Validation("missing parallel".into()))?;

        let mut handles = Vec::with_capacity(calls.len());
        for call in calls {
            let name = call
                .get("name")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let tool_input = call
                .get("input")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let cancel = cancel.clone();
            let tool = self.registry.iter().find(|t| t.name() == name).cloned();
            handles.push(tokio::spawn(async move {
                match tool {
                    Some(t) => t.execute(tool_input, cancel).await,
                    None => Err(ToolError::NotFound(name)),
                }
            }));
        }

        let mut out = Vec::with_capacity(handles.len());
        for h in handles {
            out.push(match h.await {
                Ok(Ok(v)) => v,
                Ok(Err(e)) => serde_json::json!({ "error": e.to_string() }),
                Err(e) => serde_json::json!({ "error": e.to_string() }),
            });
        }
        Ok(serde_json::Value::Array(out))
    }
}

/// Build the builtin `multi_tool_use` tool over the given registry.
pub(crate) fn builtin_multi_tool_use_tool(registry: Arc<Vec<Arc<dyn Tool>>>) -> Arc<dyn Tool> {
    Arc::new(MultiToolUseTool { registry })
}
