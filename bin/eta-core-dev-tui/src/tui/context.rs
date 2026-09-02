//! Current-context panel rendering (E3).

/// A read-only snapshot of the data shown in the "current context" panel.
#[derive(Clone, Debug, Default)]
pub struct ContextSnapshot {
    pub stable_prompt: String,
    pub adaptive_prompt: String,
    pub compaction_epoch: u64,
    pub prefix_invalidated: bool,
    pub tools: Vec<String>,
    pub goal: String,
    pub todos: Vec<String>,
    pub memory: Vec<String>,
    pub skills: Vec<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cache_rate: f64,
    pub session_id: String,
    pub branch: String,
}

/// Render a context snapshot into display lines. Long lists are folded to a
/// header plus "…N more" so a single panel never drowns the screen.
#[allow(dead_code)]
pub fn render_snapshot(snapshot: &ContextSnapshot, max_items: usize) -> Vec<String> {
    let mut out = Vec::new();
    out.push(format!(
        "session {} [{}]",
        snapshot.session_id, snapshot.branch
    ));
    out.push(format!(
        "compaction_epoch={} prefix_invalidated={}",
        snapshot.compaction_epoch, snapshot.prefix_invalidated
    ));

    out.push("── system prompt (stable) ──".to_string());
    out.extend(fold_text(&snapshot.stable_prompt, max_items));
    out.push("── system prompt (adaptive) ──".to_string());
    out.extend(fold_text(&snapshot.adaptive_prompt, max_items));

    out.push("── tools ──".to_string());
    out.extend(fold_items(&snapshot.tools, max_items));
    out.push("── goal ──".to_string());
    out.extend(fold_text(&snapshot.goal, max_items));
    out.push("── todos ──".to_string());
    out.extend(fold_items(&snapshot.todos, max_items));
    out.push("── memory ──".to_string());
    out.extend(fold_items(&snapshot.memory, max_items));
    out.push("── skills ──".to_string());
    out.extend(fold_items(&snapshot.skills, max_items));

    out.push("── usage / cache ──".to_string());
    out.push(format!(
        "in={} out={} cache_read={} cache_write={} rate={:.2}",
        snapshot.input_tokens,
        snapshot.output_tokens,
        snapshot.cache_read,
        snapshot.cache_write,
        snapshot.cache_rate
    ));
    out
}

fn fold_items(items: &[String], max: usize) -> Vec<String> {
    if items.is_empty() {
        return vec!["—".to_string()];
    }
    let mut lines: Vec<String> = items
        .iter()
        .take(max)
        .map(|item| format!("- {item}"))
        .collect();
    if items.len() > max {
        lines.push(format!("…{} more", items.len() - max));
    }
    lines
}

fn fold_text(text: &str, max: usize) -> Vec<String> {
    if text.is_empty() {
        return vec!["—".to_string()];
    }
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= max {
        return lines.into_iter().map(String::from).collect();
    }
    let mut out: Vec<String> = lines[..max]
        .iter()
        .map(|line| (*line).to_string())
        .collect();
    out.push(format!("…{} more", lines.len() - max));
    out
}

#[cfg(test)]
mod tests {
    use super::{ContextSnapshot, render_snapshot};

    fn snapshot() -> ContextSnapshot {
        ContextSnapshot {
            stable_prompt: "you are eta".into(),
            adaptive_prompt: "skills: a, b".into(),
            compaction_epoch: 3,
            prefix_invalidated: true,
            tools: vec!["bash".into(), "read".into(), "write".into()],
            goal: "ship it".into(),
            todos: vec!["plan".into()],
            memory: vec!["decision: never nextjs".into()],
            skills: vec!["code-review".into()],
            input_tokens: 100,
            output_tokens: 20,
            cache_read: 50,
            cache_write: 5,
            cache_rate: 0.5,
            session_id: "s1".into(),
            branch: "main".into(),
        }
    }

    #[test]
    fn renders_all_sections() {
        let lines = render_snapshot(&snapshot(), 10);
        let joined = lines.join("\n");
        for needle in [
            "session s1 [main]",
            "compaction_epoch=3",
            "system prompt (stable)",
            "system prompt (adaptive)",
            "tools",
            "goal",
            "todos",
            "memory",
            "skills",
            "usage / cache",
            "rate=0.50",
        ] {
            assert!(joined.contains(needle), "missing: {needle}\n{joined}");
        }
    }

    #[test]
    fn folds_long_lists_with_more_marker() {
        let mut snap = snapshot();
        snap.tools = (0..20).map(|i| format!("tool{i}")).collect();
        let lines = render_snapshot(&snap, 3);
        let joined = lines.join("\n");
        assert!(joined.contains("- tool0"));
        assert!(joined.contains("…17 more"));
        assert!(!joined.contains("- tool19"));
    }
}
