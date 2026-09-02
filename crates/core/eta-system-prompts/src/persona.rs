//! Built-in persona presets.
//!
//! These cards are the always-available defaults. A custom `*.persona.md` card
//! with the same name overrides a preset, so both sets share one namespace.

use std::collections::BTreeMap;

/// The four built-in persona presets, keyed by name.
///
/// The bodies are intentionally small placeholders: the final copy is written
/// together with a psychologist before shipping.
pub fn builtin_personas() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("思考者".into(), "以严谨推理和证据为先。".into()),
        ("提倡者".into(), "积极提出方案并说明取舍。".into()),
        ("落地者".into(), "优先给出可执行、可验证的步骤。".into()),
        ("艺术家".into(), "重视表达、创意与用户体验。".into()),
    ])
}

#[cfg(test)]
mod tests {
    use super::builtin_personas;

    #[test]
    fn exposes_the_four_builtin_personas() {
        let personas = builtin_personas();
        assert_eq!(personas.len(), 4);
        for name in ["思考者", "提倡者", "落地者", "艺术家"] {
            assert!(personas.contains_key(name), "missing preset: {name}");
        }
    }
}
