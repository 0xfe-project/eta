//! Builtin todo tool + `<current_tasks>` rendering.

use std::sync::Arc;

use async_trait::async_trait;

use crate::error::ToolError;
use crate::store::SessionStorage;
use crate::tool::{CancelToken, Tool};
use crate::types::{TodoItem, TodoStatus};

/// Storage key for the persisted todo list.
const TODOS_KEY: &str = "eta.todos";

/// Builtin todo tool: a specialized `UpdateStateTool` that merge/replaces the
/// current-tasks plan in session state (survives restart).
struct UpdateTodosTool {
    store: Arc<dyn SessionStorage>,
}

#[async_trait]
impl Tool for UpdateTodosTool {
    fn name(&self) -> &str {
        "update_todos"
    }
    fn description(&self) -> &str {
        "Update the current task list (merge or replace)."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "merge": { "type": "boolean" },
                "todos": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string" },
                            "content": { "type": "string" },
                            "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"] }
                        },
                        "required": ["id", "status"]
                    }
                }
            },
            "required": ["todos"]
        })
    }
    async fn execute(
        &self,
        input: serde_json::Value,
        _cancel: CancelToken,
    ) -> Result<serde_json::Value, ToolError> {
        let merge = input.get("merge").and_then(|m| m.as_bool()).unwrap_or(true);
        let todos: Vec<TodoItem> = serde_json::from_value(
            input
                .get("todos")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        )
        .map_err(|e| ToolError::Validation(e.to_string()))?;

        // Load the current list from session state, then merge/replace.
        let mut current = load_todos(self.store.as_ref()).await;
        if merge {
            for item in todos {
                if let Some(existing) = current.iter_mut().find(|e| e.id == item.id) {
                    if !item.content.is_empty() {
                        existing.content = item.content;
                    }
                    existing.status = item.status;
                } else {
                    current.push(item);
                }
            }
        } else {
            current = todos;
        }

        self.store
            .set_state(TODOS_KEY, serde_json::json!(current))
            .await;

        Ok(serde_json::json!({
            "todos": current,
            "message": eta_system_prompts::TODO_UPDATE_SUCCESS,
        }))
    }
}

/// Build the builtin todo tool backed by the session store.
pub(crate) fn builtin_todo_tool(store: Arc<dyn SessionStorage>) -> Arc<dyn Tool> {
    Arc::new(UpdateTodosTool { store })
}

/// Load the todo list from session state (empty when absent or malformed).
pub(crate) async fn load_todos(store: &dyn SessionStorage) -> Vec<TodoItem> {
    store
        .get_state(TODOS_KEY)
        .await
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn status_str(status: TodoStatus) -> &'static str {
    match status {
        TodoStatus::Pending => "pending",
        TodoStatus::InProgress => "in_progress",
        TodoStatus::Completed => "completed",
        TodoStatus::Cancelled => "cancelled",
    }
}

/// Render the `<current_tasks>` durable block from todo items.
pub fn render_todos(todos: &[TodoItem]) -> String {
    if todos.is_empty() {
        return String::new();
    }
    let body = todos
        .iter()
        .map(|t| format!("- [{}] {}", status_str(t.status), t.content))
        .collect::<Vec<_>>()
        .join("\n");
    format!("<current_tasks>\n{body}\n</current_tasks>")
}
