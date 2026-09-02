//! Startup / selection screen state machine (E5/E6).
//!
//! Pure and unit-tested now; wired into `App` in E5.
#![allow(dead_code)]

/// The top-level screen the app is currently showing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Screen {
    /// Cold-start: recent sessions + a draft box for the first message.
    Startup { recent: Vec<String>, draft: String },
    /// Persona/agent selection popup after a draft was typed.
    PersonaPicker {
        draft: String,
        personas: Vec<String>,
        selected: usize,
    },
    /// A live session is attached.
    Session,
}

impl Screen {
    pub fn startup(recent: Vec<String>) -> Self {
        Screen::Startup {
            recent,
            draft: String::new(),
        }
    }

    pub fn session() -> Self {
        Screen::Session
    }

    /// Mutable draft access when on the startup screen.
    pub fn draft_mut(&mut self) -> Option<&mut String> {
        match self {
            Screen::Startup { draft, .. } => Some(draft),
            _ => None,
        }
    }

    /// Enter the persona picker. Requires a non-empty startup draft.
    pub fn begin_picker(&mut self, personas: Vec<String>) -> bool {
        if let Screen::Startup { draft, .. } = self {
            if draft.trim().is_empty() {
                return false;
            }
            let draft = std::mem::take(draft);
            *self = Screen::PersonaPicker {
                draft,
                personas,
                selected: 0,
            };
            return true;
        }
        false
    }

    /// Move the picker cursor by `delta` (negative = up).
    pub fn move_selection(&mut self, delta: isize) {
        if let Screen::PersonaPicker {
            personas, selected, ..
        } = self
        {
            if personas.is_empty() {
                return;
            }
            let len = personas.len() as isize;
            *selected = (*selected as isize + delta).clamp(0, len - 1) as usize;
        }
    }

    pub fn selection(&self) -> Option<&str> {
        match self {
            Screen::PersonaPicker {
                personas, selected, ..
            } => personas.get(*selected).map(String::as_str),
            _ => None,
        }
    }

    /// Confirm the picker, returning `(persona, draft)` for the caller to spawn.
    pub fn confirm(self) -> Option<(String, String)> {
        match self {
            Screen::PersonaPicker {
                draft,
                personas,
                selected,
            } => personas
                .get(selected)
                .map(|persona| (persona.clone(), draft)),
            _ => None,
        }
    }

    /// Cancel the picker back to startup, preserving the draft.
    pub fn cancel(self) -> Screen {
        match self {
            Screen::PersonaPicker { draft, .. } => Screen::Startup {
                recent: Vec::new(),
                draft,
            },
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Screen;

    #[test]
    fn startup_draft_enters_picker_and_confirm_returns_selection() {
        let mut screen = Screen::startup(vec!["s1".into()]);
        screen.draft_mut().unwrap().push_str("ship it");
        assert!(screen.begin_picker(vec!["Thinker".into(), "Executor".into()]));

        screen.move_selection(1);
        assert_eq!(screen.selection(), Some("Executor"));
        assert_eq!(
            screen.clone().confirm(),
            Some(("Executor".into(), "ship it".into()))
        );
    }

    #[test]
    fn empty_draft_does_not_enter_picker() {
        let mut screen = Screen::startup(vec![]);
        assert!(!screen.begin_picker(vec!["Thinker".into()]));
        assert!(matches!(screen, Screen::Startup { .. }));
    }

    #[test]
    fn picker_cursor_clamps_and_cancel_restores_startup() {
        let mut screen = Screen::startup(vec![]);
        screen.draft_mut().unwrap().push_str("hi");
        screen.begin_picker(vec!["a".into(), "b".into()]);
        screen.move_selection(-5);
        assert_eq!(screen.selection(), Some("a"));
        screen.move_selection(99);
        assert_eq!(screen.selection(), Some("b"));

        let cancelled = screen.cancel();
        assert!(matches!(cancelled, Screen::Startup { draft, .. } if draft == "hi"));
    }
}
