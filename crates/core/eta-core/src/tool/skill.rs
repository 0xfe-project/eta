//! Builtin `skill` tool: manage the agent's preferred skills.

use std::sync::Arc;

use async_trait::async_trait;

use crate::error::ToolError;
use crate::store::SessionStorage;
use crate::tool::{CancelToken, Tool};
use crate::types::SkillEntry;

/// Storage key for the agent's preferred skills.
const SKILLS_KEY: &str = "eta.skills";

/// Builtin `skill` tool: add / remove the agent's preferred skills.
struct SkillTool {
    store: Arc<dyn SessionStorage>,
}

#[async_trait]
impl Tool for SkillTool {
    fn name(&self) -> &str {
        "skill"
    }
    fn description(&self) -> &str {
        "Manage preferred skills (add / remove)."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "add": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": { "type": "string" },
                            "content": { "type": "string" }
                        },
                        "required": ["name"]
                    }
                },
                "remove": { "type": "array", "items": { "type": "string" } }
            }
        })
    }
    async fn execute(
        &self,
        input: serde_json::Value,
        _cancel: CancelToken,
    ) -> Result<serde_json::Value, ToolError> {
        let mut skills = load_skills(self.store.as_ref()).await;

        if let Some(names) = input.get("remove").and_then(|v| v.as_array()) {
            for n in names {
                if let Some(s) = n.as_str() {
                    skills.retain(|x| x.name != s);
                }
            }
        }

        if let Some(items) = input.get("add").and_then(|v| v.as_array()) {
            for item in items {
                let Some(name) = item.get("name").and_then(|s| s.as_str()) else {
                    continue;
                };
                let content = item
                    .get("content")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(existing) = skills.iter_mut().find(|x| x.name == name) {
                    if !content.is_empty() {
                        existing.content = content;
                    }
                } else {
                    skills.push(SkillEntry {
                        name: name.to_string(),
                        content,
                    });
                }
            }
        }

        self.store
            .set_state(SKILLS_KEY, serde_json::json!(skills))
            .await;

        Ok(serde_json::json!({ "ok": true, "skills": skills.len() }))
    }
}

/// Build the builtin `skill` tool backed by the session store.
pub(crate) fn builtin_skill_tool(store: Arc<dyn SessionStorage>) -> Arc<dyn Tool> {
    Arc::new(SkillTool { store })
}

/// Load the agent's preferred skills from session state.
pub(crate) async fn load_skills(store: &dyn SessionStorage) -> Vec<SkillEntry> {
    store
        .get_state(SKILLS_KEY)
        .await
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// Render the `<skills>` block from the preferred skills.
pub fn render_skills(skills: &[SkillEntry]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let body = skills
        .iter()
        .map(|s| format!("- {}: {}", s.name, s.content))
        .collect::<Vec<_>>()
        .join("\n");
    format!("<skills>\n{body}\n</skills>")
}
