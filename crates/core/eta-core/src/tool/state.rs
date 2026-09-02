//! Builtin state tools (session KV).

use std::sync::Arc;

use async_trait::async_trait;

use crate::error::ToolError;
use crate::store::SessionStorage;
use crate::tool::{CancelToken, Tool};

struct UpdateStateTool {
    store: Arc<dyn SessionStorage>,
}

#[async_trait]
impl Tool for UpdateStateTool {
    fn name(&self) -> &str {
        "update_state"
    }
    fn description(&self) -> &str {
        "Write or delete a session KV key (action: set/delete)."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["set", "delete"] },
                "key": { "type": "string" },
                "value": {}
            },
            "required": ["action", "key"]
        })
    }
    async fn execute(
        &self,
        input: serde_json::Value,
        _cancel: CancelToken,
    ) -> Result<serde_json::Value, ToolError> {
        let action = input
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| ToolError::Validation("missing action".into()))?;
        let key = input
            .get("key")
            .and_then(|k| k.as_str())
            .ok_or_else(|| ToolError::Validation("missing key".into()))?;
        match action {
            "set" => {
                let value = input
                    .get("value")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                self.store.set_state(key, value).await;
            }
            "delete" => {
                self.store.delete_state(key).await;
            }
            other => return Err(ToolError::Validation(format!("unknown action: {other}"))),
        }
        Ok(serde_json::json!({ "ok": true }))
    }
}

struct CheckStateTool {
    store: Arc<dyn SessionStorage>,
}

#[async_trait]
impl Tool for CheckStateTool {
    fn name(&self) -> &str {
        "check_state"
    }
    fn description(&self) -> &str {
        "Read a session KV key (read-only)."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": { "key": { "type": "string" } }
        })
    }
    async fn execute(
        &self,
        input: serde_json::Value,
        _cancel: CancelToken,
    ) -> Result<serde_json::Value, ToolError> {
        let key = input.get("key").and_then(|k| k.as_str());
        match key {
            Some(k) => Ok(self
                .store
                .get_state(k)
                .await
                .unwrap_or(serde_json::Value::Null)),
            None => Ok(serde_json::json!({ "keys": self.store.list_state_keys().await })),
        }
    }
}

struct ListStateTool {
    store: Arc<dyn SessionStorage>,
}

#[async_trait]
impl Tool for ListStateTool {
    fn name(&self) -> &str {
        "list_state"
    }
    fn description(&self) -> &str {
        "List all session KV keys."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({ "type": "object" })
    }
    async fn execute(
        &self,
        _input: serde_json::Value,
        _cancel: CancelToken,
    ) -> Result<serde_json::Value, ToolError> {
        Ok(serde_json::json!({ "keys": self.store.list_state_keys().await }))
    }
}

/// Build the three builtin state tools backed by the session store.
pub(crate) fn builtin_state_tools(store: Arc<dyn SessionStorage>) -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(UpdateStateTool {
            store: store.clone(),
        }),
        Arc::new(CheckStateTool {
            store: store.clone(),
        }),
        Arc::new(ListStateTool { store }),
    ]
}
