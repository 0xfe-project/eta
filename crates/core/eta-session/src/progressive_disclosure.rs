//! Progressive disclosure: budget-based degradation of the skills catalog.

use eta_core::Skill;

/// Maximum description length before truncation (level 2).
pub const MAX_TRUNCATED_DESCRIPTION_LENGTH: usize = 480;

/// Rough token estimate (~4 chars per token).
fn estimate_tokens(text: &str) -> usize {
    text.len() / 4 + 1
}

/// Render the skills catalog, degrading monotonically to fit `budget` tokens:
/// 1. full (name + full description)
/// 2. truncated description (`MAX_TRUNCATED_DESCRIPTION_LENGTH` chars)
/// 3. names only (paths)
/// 4. omitted entirely (a notice)
pub fn render_skills_catalog(skills: &[Skill], budget: usize) -> String {
    if skills.is_empty() {
        return String::new();
    }

    // Level 1: full.
    let full = skills
        .iter()
        .map(|s| format!("- {}: {}", s.name, s.description))
        .collect::<Vec<_>>();
    if full.iter().map(|l| estimate_tokens(l)).sum::<usize>() <= budget {
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
    if truncated.iter().map(|l| estimate_tokens(l)).sum::<usize>() <= budget {
        return truncated.join("\n");
    }

    // Level 3: names only.
    let names = skills.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
    if names.iter().map(|n| estimate_tokens(n)).sum::<usize>() <= budget {
        return names.join("\n");
    }

    // Level 4: omitted.
    format!("({} skills omitted)", skills.len())
}
