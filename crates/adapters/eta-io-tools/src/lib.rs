#![doc = include_str!("../README.md")]

use async_trait::async_trait;
use eta_core::{CancelToken, Tool, ToolError};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_OUTPUT_LINES: usize = 500;

/// Execute shell commands with a bounded textual result.  The bound keeps a
/// runaway command from flooding the model context and tells the model how to
/// continue searching when output was clipped.
pub struct BashTool {
    pub default_cwd: Option<PathBuf>,
}

impl BashTool {
    pub fn new(default_cwd: Option<PathBuf>) -> Self {
        Self { default_cwd }
    }
}

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str {
        "bash"
    }
    fn description(&self) -> &str {
        "Run a shell command; output is limited to 500 lines."
    }
    fn schema(&self) -> Value {
        json!({"type":"object","required":["command"],"properties":{
            "command":{"type":"string"}, "cwd":{"type":"string"}
        }})
    }

    async fn execute(&self, input: Value, cancel: CancelToken) -> Result<Value, ToolError> {
        if cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let command = input
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Validation("command must be a string".into()))?
            .to_owned();
        let cwd = input
            .get("cwd")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .or_else(|| self.default_cwd.clone());
        let output = tokio::task::spawn_blocking(move || {
            let mut cmd = Command::new("sh");
            cmd.arg("-c").arg(command);
            if let Some(dir) = cwd {
                cmd.current_dir(dir);
            }
            cmd.output().map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| ToolError::Execution(e.to_string()))?
        .map_err(ToolError::Execution)?;
        if cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        if !output.stderr.is_empty() {
            text.push_str(&String::from_utf8_lossy(&output.stderr));
        }
        let (text, truncated) = truncate_lines(&text, MAX_OUTPUT_LINES);
        Ok(json!({"output": text, "exit_code": output.status.code(), "truncated": truncated}))
    }
}

/// File operations used by coding agents: read, write, edit and grep.
pub struct FileTool;

#[async_trait]
impl Tool for FileTool {
    fn name(&self) -> &str {
        "file"
    }
    fn description(&self) -> &str {
        "Read, write, edit, or grep files."
    }
    fn schema(&self) -> Value {
        json!({"type":"object","required":["operation","path"],"properties":{
            "operation":{"enum":["read","write","edit","grep"]},
            "path":{"type":"string"}, "content":{"type":"string"},
            "find":{"type":"string"}, "replace":{"type":"string"},
            "pattern":{"type":"string"}
        }})
    }

    async fn execute(&self, input: Value, cancel: CancelToken) -> Result<Value, ToolError> {
        if cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let op = input
            .get("operation")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Validation("operation is required".into()))?;
        let path = input
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Validation("path is required".into()))?
            .to_owned();
        let result = match op {
            "read" => {
                let content = std::fs::read_to_string(&path)
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let (content, truncated) = truncate_lines(&content, MAX_OUTPUT_LINES);
                json!({"content": content, "truncated": truncated})
            }
            "write" => {
                let content = input
                    .get("content")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ToolError::Validation("content is required for write".into()))?;
                std::fs::write(&path, content).map_err(|e| ToolError::Execution(e.to_string()))?;
                json!({"written": true, "bytes": content.len()})
            }
            "edit" => {
                let find = input
                    .get("find")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ToolError::Validation("find is required for edit".into()))?;
                let replace = input.get("replace").and_then(Value::as_str).unwrap_or("");
                let old = std::fs::read_to_string(&path)
                    .map_err(|e| ToolError::Execution(e.to_string()))?;
                let count = old.matches(find).count();
                if count == 0 {
                    return Err(ToolError::Execution("text to replace was not found".into()));
                }
                let new = old.replacen(find, replace, 1);
                std::fs::write(&path, new).map_err(|e| ToolError::Execution(e.to_string()))?;
                json!({"edited": true, "replacements": 1})
            }
            "grep" => {
                let pattern = input
                    .get("pattern")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ToolError::Validation("pattern is required for grep".into()))?;
                let mut lines = Vec::new();
                grep_path(Path::new(&path), pattern, &mut lines)?;
                let text = lines.join("\n");
                let (text, truncated) = truncate_lines(&text, MAX_OUTPUT_LINES);
                json!({"matches": text, "truncated": truncated})
            }
            other => {
                return Err(ToolError::Validation(format!(
                    "unsupported operation: {other}"
                )));
            }
        };
        Ok(result)
    }
}

pub fn builtin_io_tools() -> Vec<std::sync::Arc<dyn Tool>> {
    vec![
        std::sync::Arc::new(BashTool::new(None)),
        std::sync::Arc::new(FileTool),
    ]
}

fn truncate_lines(text: &str, limit: usize) -> (String, bool) {
    let mut lines = text.lines().take(limit).collect::<Vec<_>>().join("\n");
    let truncated = text.lines().count() > limit;
    if truncated {
        if !lines.is_empty() {
            lines.push('\n');
        }
        lines.push_str("[output truncated; search in smaller segments]");
    }
    (lines, truncated)
}

fn grep_path(path: &Path, pattern: &str, out: &mut Vec<String>) -> Result<(), ToolError> {
    if path.is_file() {
        let content =
            std::fs::read_to_string(path).map_err(|e| ToolError::Execution(e.to_string()))?;
        for (line_no, line) in content.lines().enumerate() {
            if line.contains(pattern) {
                out.push(format!("{}:{}:{}", path.display(), line_no + 1, line));
            }
        }
    } else if path.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|e| ToolError::Execution(e.to_string()))? {
            let entry = entry.map_err(|e| ToolError::Execution(e.to_string()))?;
            grep_path(&entry.path(), pattern, out)?;
        }
    } else {
        return Err(ToolError::Execution(format!(
            "path does not exist: {}",
            path.display()
        )));
    }
    Ok(())
}
