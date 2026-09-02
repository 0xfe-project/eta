//! Config / persona / agent catalog loading (E5/E8).

use std::collections::BTreeSet;
use std::path::Path;

/// Built-in + custom persona names, sorted and deduplicated. Built-in presets
/// and `*.persona.md` files share one namespace, so a custom card with the same
/// name shadows a preset.
#[allow(dead_code)]
pub fn persona_names(custom_dir: impl AsRef<Path>) -> Vec<String> {
    let mut names: BTreeSet<String> = eta_system_prompts::builtin_personas().into_keys().collect();
    if let Ok(entries) = std::fs::read_dir(custom_dir) {
        for entry in entries.flatten() {
            let file = entry.path();
            if let Some(name) = file
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_suffix(".persona.md"))
            {
                names.insert(name.to_string());
            }
        }
    }
    names.into_iter().collect()
}

/// Agent names from `~/.eta/agents/*.sqlite`, sorted by filename stem.
#[allow(dead_code)]
pub fn agent_names(dir: impl AsRef<Path>) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("sqlite") {
                if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                    names.push(stem.to_string());
                }
            }
        }
    }
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::{agent_names, persona_names};

    #[test]
    fn persona_names_include_builtins_and_custom_cards() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("custom.persona.md"), "# custom").unwrap();
        let names = persona_names(dir.path());
        assert!(names.iter().any(|name| name == "custom"));
        assert!(names.iter().any(|name| name == "Thinker"));
    }

    #[test]
    fn agent_names_lists_only_sqlite_stems() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("alice.sqlite"), b"").unwrap();
        std::fs::write(dir.path().join("bob.sqlite"), b"").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"x").unwrap();
        assert_eq!(
            agent_names(dir.path()),
            vec!["alice".to_string(), "bob".to_string()]
        );
    }
}
