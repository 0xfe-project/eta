//! Progressive disclosure: budget-based degradation of the adaptive block
//! (skills catalog + mcp/tool directory).

use eta_core::Skill;

/// Maximum description length before truncation (level 2).
pub const MAX_TRUNCATED_DESCRIPTION_LENGTH: usize = 480;

/// Rough token estimate (~4 chars per token).
fn estimate_tokens(text: &str) -> usize {
    text.len() / 4 + 1
}

fn cost(lines: &[String]) -> usize {
    lines.iter().map(|l| estimate_tokens(l)).sum()
}

/// A directory entry for a dynamic (MCP / long-tail) tool server. No schema —
/// the schema is pulled on demand via `GetTools`.
#[derive(Clone, Debug)]
pub struct McpServerDir {
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
}

/// Render the skills catalog, degrading monotonically to fit `budget` tokens:
/// 1. full (name + full description)
/// 2. truncated description (`MAX_TRUNCATED_DESCRIPTION_LENGTH` chars)
/// 3. names only (paths)
/// 4. omitted — except `protected` names, which are never omitted
pub fn render_skills_catalog(skills: &[Skill], protected: &[String], budget: usize) -> String {
    if skills.is_empty() {
        return String::new();
    }

    // Level 1: full.
    let full = skills
        .iter()
        .map(|s| format!("- {}: {}", s.name, s.description))
        .collect::<Vec<_>>();
    if cost(&full) <= budget {
        return full.join("\n");
    }

    // Level 2: truncated description.
    let truncated = skills
        .iter()
        .map(|s| {
            let mut desc = s
                .description
                .chars()
                .take(MAX_TRUNCATED_DESCRIPTION_LENGTH)
                .collect::<String>();
            if s.description.chars().count() > MAX_TRUNCATED_DESCRIPTION_LENGTH {
                desc.push('…');
            }
            format!("- {}: {}", s.name, desc)
        })
        .collect::<Vec<_>>();
    if cost(&truncated) <= budget {
        return truncated.join("\n");
    }

    // Level 3: names only.
    let names = skills.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
    if cost(&names) <= budget {
        return names.join("\n");
    }

    // Level 4: omitted, but protected names stay.
    let protected_names = skills
        .iter()
        .filter(|s| protected.contains(&s.name))
        .map(|s| s.name.clone())
        .collect::<Vec<_>>();
    if protected_names.is_empty() {
        format!("({} skills omitted)", skills.len())
    } else {
        protected_names.join("\n")
    }
}

/// Render the mcp / tool directory (name + tool list + truncated description).
pub fn render_mcp_directory(servers: &[McpServerDir]) -> String {
    if servers.is_empty() {
        return String::new();
    }
    let body = servers
        .iter()
        .map(|s| {
            format!(
                "- {}: {} (tools: {})",
                s.name,
                s.description,
                s.tools.join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("<mcp_servers>\n{body}\n</mcp_servers>")
}

/// Assemble the system prompt: stable block (persona + role + memory) + adaptive
/// block (skills catalog with 4-level degradation + mcp/tool directory).
pub fn assemble_system_prompt(
    stable: &str,
    skills: &[Skill],
    protected: &[String],
    mcp: &[McpServerDir],
    adaptive_budget: usize,
) -> String {
    let mut prompt = stable.to_string();

    let skills_block = render_skills_catalog(skills, protected, adaptive_budget);
    let mcp_block = render_mcp_directory(mcp);
    let mut adaptive = skills_block;
    if !mcp_block.is_empty() {
        if !adaptive.is_empty() {
            adaptive.push_str("\n\n");
        }
        adaptive.push_str(&mcp_block);
    }

    if !adaptive.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(&adaptive);
    }
    prompt
}
