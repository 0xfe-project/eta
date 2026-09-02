//! Startup / new-conversation screen state machine (E5/E9).
//!
//! Pure and unit-tested now; wired into `App`.
#![allow(dead_code)]

/// The top-level screen the app is currently showing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Screen {
    /// Cold-start: recent sessions + a draft box for the first message.
    Startup { recent: Vec<String>, draft: String },
    /// New conversation: choose an existing agent or create a new one.
    AgentMode { draft: String, selected: usize },
    /// Pick an existing agent by name.
    AgentPicker {
        draft: String,
        agents: Vec<String>,
        selected: usize,
    },
    /// Name a new agent before choosing its persona.
    CreateAgentName { draft: String, name: String },
    /// Choose a persona for the new agent.
    PersonaPicker {
        draft: String,
        name: Option<String>,
        personas: Vec<String>,
        selected: usize,
    },
    /// Choose a `provider/model` override for the current session.
    ModelPicker {
        models: Vec<String>,
        selected: usize,
    },
    /// A live session is attached.
    Session,
}

/// What the user selected in the existing-vs-create step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentChoice {
    Existing,
    New,
}

/// The resolved result of a new-conversation flow.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NewConversation {
    ExistingAgent {
        agent: String,
        draft: String,
    },
    NewAgent {
        name: String,
        persona: String,
        draft: String,
    },
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

    /// Mutable text access: the startup draft, or the new-agent name.
    pub fn text_mut(&mut self) -> Option<&mut String> {
        match self {
            Screen::Startup { draft, .. } => Some(draft),
            Screen::CreateAgentName { name, .. } => Some(name),
            _ => None,
        }
    }

    /// Startup → choose existing vs create. Requires a non-empty draft.
    pub fn begin_agent_mode(&mut self) -> bool {
        if let Screen::Startup { draft, .. } = self {
            if draft.trim().is_empty() {
                return false;
            }
            let draft = std::mem::take(draft);
            *self = Screen::AgentMode { draft, selected: 0 };
            return true;
        }
        false
    }

    /// Move the cursor for whichever picker is currently active.
    pub fn move_selection(&mut self, delta: isize) {
        let (len, selected) = match self {
            Screen::AgentMode { selected, .. } => (2, selected),
            Screen::AgentPicker {
                agents, selected, ..
            } => (agents.len(), selected),
            Screen::PersonaPicker {
                personas, selected, ..
            }
            | Screen::ModelPicker {
                models: personas,
                selected,
                ..
            } => (personas.len(), selected),
            _ => return,
        };
        if len == 0 {
            return;
        }
        *selected = (*selected as isize + delta).clamp(0, len as isize - 1) as usize;
    }

    pub fn agent_mode_choice(&self) -> Option<AgentChoice> {
        match self {
            Screen::AgentMode { selected, .. } => Some(if *selected == 0 {
                AgentChoice::Existing
            } else {
                AgentChoice::New
            }),
            _ => None,
        }
    }

    /// Confirm the existing-vs-create choice and move to the next step.
    pub fn confirm_agent_mode(&mut self, agents: Vec<String>) -> bool {
        let draft = match self {
            Screen::AgentMode {
                draft, selected: 0, ..
            } => std::mem::take(draft),
            Screen::AgentMode {
                draft, selected: 1, ..
            } => std::mem::take(draft),
            _ => return false,
        };
        match self.agent_mode_choice() {
            Some(AgentChoice::Existing) => {
                *self = Screen::AgentPicker {
                    draft,
                    agents,
                    selected: 0,
                };
                true
            }
            Some(AgentChoice::New) => {
                *self = Screen::CreateAgentName {
                    draft,
                    name: String::new(),
                };
                true
            }
            None => false,
        }
    }

    pub fn agent_selection(&self) -> Option<&str> {
        match self {
            Screen::AgentPicker {
                agents, selected, ..
            } => agents.get(*selected).map(String::as_str),
            _ => None,
        }
    }

    pub fn confirm_agent(&mut self) -> Option<NewConversation> {
        match self {
            Screen::AgentPicker {
                draft,
                agents,
                selected,
            } => {
                let agent = agents.get(*selected)?.clone();
                let draft = std::mem::take(draft);
                Some(NewConversation::ExistingAgent { agent, draft })
            }
            _ => None,
        }
    }

    /// Move from naming the new agent into the persona picker.
    pub fn begin_persona_picker(&mut self, personas: Vec<String>) -> bool {
        if let Screen::CreateAgentName { draft, name } = self {
            let draft = std::mem::take(draft);
            let name = std::mem::take(name);
            *self = Screen::PersonaPicker {
                draft,
                name: Some(name),
                personas,
                selected: 0,
            };
            return true;
        }
        false
    }

    pub fn persona_selection(&self) -> Option<&str> {
        match self {
            Screen::PersonaPicker {
                personas, selected, ..
            } => personas.get(*selected).map(String::as_str),
            _ => None,
        }
    }

    pub fn model_selection(&self) -> Option<&str> {
        match self {
            Screen::ModelPicker {
                models, selected, ..
            } => models.get(*selected).map(String::as_str),
            _ => None,
        }
    }

    /// Open the model picker from a live session.
    pub fn open_model_picker(&mut self, models: Vec<String>) -> bool {
        if matches!(self, Screen::Session) {
            *self = Screen::ModelPicker {
                models,
                selected: 0,
            };
            true
        } else {
            false
        }
    }

    pub fn confirm_model(&mut self) -> Option<String> {
        match self {
            Screen::ModelPicker {
                models, selected, ..
            } => models.get(*selected).cloned(),
            _ => None,
        }
    }

    pub fn confirm(&mut self) -> Option<NewConversation> {
        match self {
            Screen::PersonaPicker {
                draft,
                name,
                personas,
                selected,
            } => {
                let persona = personas.get(*selected)?.clone();
                let name = name.clone().unwrap_or_default();
                let draft = std::mem::take(draft);
                Some(NewConversation::NewAgent {
                    name,
                    persona,
                    draft,
                })
            }
            _ => None,
        }
    }

    /// Cancel any pre-session step back to startup, preserving the draft.
    pub fn cancel(self) -> Screen {
        let draft = match self {
            Screen::AgentMode { draft, .. }
            | Screen::AgentPicker { draft, .. }
            | Screen::CreateAgentName { draft, .. }
            | Screen::PersonaPicker { draft, .. } => draft,
            Screen::ModelPicker { .. } => return Screen::Session,
            other => return other,
        };
        Screen::Startup {
            recent: Vec::new(),
            draft,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AgentChoice, NewConversation, Screen};

    #[test]
    fn new_agent_flow_requires_name_and_persona() {
        let mut screen = Screen::startup(vec![]);
        screen.text_mut().unwrap().push_str("ship it");
        assert!(screen.begin_agent_mode());
        screen.move_selection(1);
        assert_eq!(screen.agent_mode_choice(), Some(AgentChoice::New));

        assert!(screen.confirm_agent_mode(vec![]));
        assert!(matches!(screen, Screen::CreateAgentName { .. }));

        // Name the agent, then pick a persona.
        let Screen::CreateAgentName { name, .. } = &mut screen else {
            panic!("expected create-name screen");
        };
        name.push_str("dev");
        assert!(screen.begin_persona_picker(vec!["Thinker".into(), "Executor".into()]));
        screen.move_selection(1);
        assert_eq!(screen.persona_selection(), Some("Executor"));
        assert_eq!(
            screen.confirm(),
            Some(NewConversation::NewAgent {
                name: "dev".into(),
                persona: "Executor".into(),
                draft: "ship it".into(),
            })
        );
    }

    #[test]
    fn existing_agent_flow_skips_name_and_persona() {
        let mut screen = Screen::startup(vec![]);
        screen.text_mut().unwrap().push_str("continue");
        screen.begin_agent_mode();
        assert!(screen.confirm_agent_mode(vec!["alice".into(), "bob".into()]));
        assert_eq!(screen.agent_selection(), Some("alice"));
        screen.move_selection(1);
        assert_eq!(
            screen.confirm_agent(),
            Some(NewConversation::ExistingAgent {
                agent: "bob".into(),
                draft: "continue".into(),
            })
        );
    }

    #[test]
    fn cancel_returns_to_startup_with_draft() {
        let mut screen = Screen::startup(vec![]);
        screen.text_mut().unwrap().push_str("hi");
        screen.begin_agent_mode();
        let cancelled = screen.cancel();
        assert!(matches!(cancelled, Screen::Startup { draft, .. } if draft == "hi"));
    }

    #[test]
    fn model_picker_selects_and_cancels_back_to_session() {
        let mut screen = Screen::session();
        assert!(screen.open_model_picker(vec!["a/gpt".into(), "b/claude".into()]));
        screen.move_selection(1);
        assert_eq!(screen.model_selection(), Some("b/claude"));
        assert_eq!(screen.confirm_model(), Some("b/claude".into()));
        assert!(matches!(screen.cancel(), Screen::Session));
    }
}
