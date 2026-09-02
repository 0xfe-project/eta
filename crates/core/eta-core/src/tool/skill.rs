//! Skill rendering (`<skills>` block). There is no skill *tool* — the engine
//! dumps every installed skill into context wholesale.

use crate::store::Skill;

/// Render the `<skills>` block from the installed skills.
pub fn render_skills(skills: &[Skill]) -> String {
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
