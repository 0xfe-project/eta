//! Slash-command parsing (E7).

use eta_core::AgentInput;
use serde_json::json;

/// Commands recognized by the input box. Each later maps to an `AgentInput`,
/// session-manager call, or time-travel operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Goal(String),
    PauseGoal,
    ResumeGoal,
    ClearGoal,
    LoopAdd { schedule: String, prompt: String },
    LoopList,
    LoopRemove(String),
    LoopEnable(String),
    LoopDisable(String),
    Compact,
    Ask(String),
    Fork(String),
    Commit(String),
    Checkout(String),
    Rollback(String),
    History,
    Merge(String),
    Search(String),
    Tools,
    Skills,
    Memory,
    Todos,
    Usage,
    Model(Option<String>),
    Provider(String),
    Agent,
    Session,
    NewSession,
    SessionNew,
    SessionRemove(String),
    SessionRename { prefix: String, name: String },
    LoadOtherAgentConfig,
    Clear,
    Help,
    Quit,
}

impl Command {
    /// Map engine-driving commands into an `AgentInput`. Display-only commands
    /// (`/tools`, `/usage`, …) and session/time-travel commands return `None`.
    pub fn to_agent_input(&self) -> Option<AgentInput> {
        match self {
            Command::Goal(objective) => Some(AgentInput::SetGoal {
                objective: objective.clone(),
            }),
            Command::PauseGoal => Some(AgentInput::PauseGoal),
            Command::ResumeGoal => Some(AgentInput::ResumeGoal),
            Command::ClearGoal => Some(AgentInput::ClearGoal),
            Command::Compact => Some(AgentInput::Compact),
            Command::Ask(question) => Some(AgentInput::Custom(json!({
                "kind": "ask_user",
                "question": question,
            }))),
            _ => None,
        }
    }
}

/// Parse a line beginning with `/` into a command, or `None` for plain text.
pub fn parse_command(input: &str) -> Option<Command> {
    let body = input.trim().strip_prefix('/')?;
    let tokens = tokenize(body);
    let (head, rest) = tokens.split_first()?;
    match head.to_ascii_lowercase().as_str() {
        "goal" => parse_goal(rest),
        "pause-goal" => Some(Command::PauseGoal),
        "resume-goal" => Some(Command::ResumeGoal),
        "clear-goal" => Some(Command::ClearGoal),
        "loop" => parse_loop(rest),
        "ask" => Some(Command::Ask(rest.join(" "))),
        "fork" => rest.first().map(|name| Command::Fork(name.clone())),
        "commit" => Some(Command::Commit(rest.join(" "))),
        "checkout" => rest
            .first()
            .map(|reference| Command::Checkout(reference.clone())),
        "rollback" => rest.first().map(|id| Command::Rollback(id.clone())),
        "history" => Some(Command::History),
        "merge" => rest.first().map(|branch| Command::Merge(branch.clone())),
        "search" => Some(Command::Search(rest.join(" "))),
        "tools" => Some(Command::Tools),
        "skills" => Some(Command::Skills),
        "memory" => Some(Command::Memory),
        "todos" => Some(Command::Todos),
        "usage" => Some(Command::Usage),
        "model" => Some(Command::Model(rest.first().cloned())),
        "provider" => rest.first().map(|name| Command::Provider(name.clone())),
        "agent" => Some(Command::Agent),
        "compact" => Some(Command::Compact),
        "load_other_agent_config" => Some(Command::LoadOtherAgentConfig),
        "session" => parse_session(rest),
        "new-session" => Some(Command::NewSession),
        "clear" => Some(Command::Clear),
        "help" => Some(Command::Help),
        "quit" | "exit" => Some(Command::Quit),
        _ => None,
    }
}

/// A `/`-command completion item: usage signature + one-line description.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandCompletion {
    pub usage: String,
    pub desc: String,
}

/// Usage + description for `/`-command completion. Given the text so far
/// (starting with `/`), return the matching signatures so a picker can show them
/// with a short explanation.
pub fn command_completions(input: &str) -> Vec<CommandCompletion> {
    let all: Vec<(&str, &str)> = vec![
        (
            "/goal (set <objective> | pause | resume | cancel | reset)",
            "manage the agent goal",
        ),
        (
            "/loop (<duration> <prompt> | list | cancel <id>)",
            "schedule, list, or cancel a loop",
        ),
        ("/ask <question>", "ask an inline question"),
        ("/fork <name>", "fork a time-travel branch"),
        ("/commit <msg>", "commit a session snapshot"),
        ("/checkout <ref>", "checkout a branch or commit"),
        ("/rollback <id>", "rollback to a commit"),
        ("/history", "show commit history"),
        ("/merge <branch>", "merge a branch"),
        ("/search <q>", "search session history"),
        (
            "/session [new | rm <prefix> | rename <prefix> <name>]",
            "manage sessions",
        ),
        ("/new-session", "start a new session"),
        ("/agent", "switch the session agent"),
        ("/model [provider/model]", "pick a model per session"),
        ("/compact", "force a one-off context compression"),
        ("/tools", "list tools"),
        ("/skills", "list skills"),
        ("/memory", "show memory"),
        ("/todos", "show current tasks"),
        ("/usage", "show token usage"),
        ("/load_other_agent_config", "import custom models from home"),
        ("/help", "show help"),
        ("/quit", "quit"),
    ];
    let input = input.trim();
    all.into_iter()
        .filter(|(usage, _)| input.is_empty() || usage.starts_with(input))
        .map(|(usage, desc)| CommandCompletion {
            usage: usage.to_string(),
            desc: desc.to_string(),
        })
        .collect()
}

fn parse_goal(rest: &[String]) -> Option<Command> {
    match rest.first().map(|value| value.to_ascii_lowercase()) {
        Some(action) if action == "set" => Some(Command::Goal(
            rest.get(1..)
                .map(|parts| parts.join(" "))
                .unwrap_or_default(),
        )),
        Some(action) if action == "pause" => Some(Command::PauseGoal),
        Some(action) if action == "resume" => Some(Command::ResumeGoal),
        Some(action) if action == "cancel" || action == "reset" => Some(Command::ClearGoal),
        _ => Some(Command::Goal(rest.join(" "))),
    }
}

fn parse_loop(rest: &[String]) -> Option<Command> {
    match rest.first().map(|value| value.to_ascii_lowercase()) {
        Some(action) if action == "add" => {
            // `/loop add cron "<expr>" <prompt>` → rest = ["add", "cron", expr, prompt…]
            let schedule = rest.get(2)?.clone();
            let prompt = rest
                .get(3..)
                .map(|parts| parts.join(" "))
                .unwrap_or_default();
            Some(Command::LoopAdd { schedule, prompt })
        }
        Some(action) if action == "list" => Some(Command::LoopList),
        Some(action) if action == "cancel" => rest.get(1).cloned().map(Command::LoopRemove),
        Some(action) if action == "rm" => rest.get(1).cloned().map(Command::LoopRemove),
        Some(action) if action == "enable" => rest.get(1).cloned().map(Command::LoopEnable),
        Some(action) if action == "disable" => rest.get(1).cloned().map(Command::LoopDisable),
        _ => {
            // Shorthand: `/loop <duration> <prompt>`.
            let schedule = rest.first()?.clone();
            let prompt = rest
                .get(1..)
                .map(|parts| parts.join(" "))
                .unwrap_or_default();
            Some(Command::LoopAdd { schedule, prompt })
        }
    }
}

fn parse_session(rest: &[String]) -> Option<Command> {
    match rest.first().map(|value| value.to_ascii_lowercase()) {
        None => Some(Command::Session),
        Some(action) if action == "new" => Some(Command::SessionNew),
        Some(action) if action == "rm" => rest.get(1).cloned().map(Command::SessionRemove),
        Some(action) if action == "rename" => {
            let prefix = rest.get(1)?;
            let name = rest.get(2)?;
            Some(Command::SessionRename {
                prefix: prefix.clone(),
                name: name.clone(),
            })
        }
        _ => None,
    }
}

/// Split on whitespace while keeping double-quoted spans as single tokens.
fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in input.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ch if ch.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            ch => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::{Command, command_completions, parse_command};
    use eta_core::AgentInput;

    #[test]
    fn returns_none_for_plain_text() {
        assert_eq!(parse_command("hello world"), None);
    }

    #[test]
    fn parses_goal_and_pause_resume() {
        assert_eq!(
            parse_command("/goal ship the app"),
            Some(Command::Goal("ship the app".into()))
        );
        assert_eq!(parse_command("/pause-goal"), Some(Command::PauseGoal));
        assert_eq!(parse_command("/resume-goal"), Some(Command::ResumeGoal));
        assert_eq!(parse_command("/clear-goal"), Some(Command::ClearGoal));
    }

    #[test]
    fn parses_loop_add_with_quoted_schedule() {
        assert_eq!(
            parse_command(r#"/loop add cron "0 * * * *" ship it"#),
            Some(Command::LoopAdd {
                schedule: "0 * * * *".into(),
                prompt: "ship it".into(),
            })
        );
        assert_eq!(parse_command("/loop list"), Some(Command::LoopList));
        assert_eq!(
            parse_command("/loop rm 7"),
            Some(Command::LoopRemove("7".into()))
        );
    }

    #[test]
    fn parses_time_travel_and_session_commands() {
        assert_eq!(
            parse_command("/fork dev"),
            Some(Command::Fork("dev".into()))
        );
        assert_eq!(
            parse_command("/commit wip"),
            Some(Command::Commit("wip".into()))
        );
        assert_eq!(
            parse_command("/checkout dev"),
            Some(Command::Checkout("dev".into()))
        );
        assert_eq!(
            parse_command("/search plan"),
            Some(Command::Search("plan".into()))
        );
        assert_eq!(parse_command("/session"), Some(Command::Session));
        assert_eq!(
            parse_command("/session rename a b"),
            Some(Command::SessionRename {
                prefix: "a".into(),
                name: "b".into(),
            })
        );
    }

    #[test]
    fn parses_simple_switches() {
        assert_eq!(parse_command("/tools"), Some(Command::Tools));
        assert_eq!(parse_command("/usage"), Some(Command::Usage));
        assert_eq!(
            parse_command("/model deepseek/chat"),
            Some(Command::Model(Some("deepseek/chat".into())))
        );
        assert_eq!(parse_command("/quit"), Some(Command::Quit));
    }

    #[test]
    fn maps_engine_commands_to_agent_inputs() {
        assert!(matches!(
            Command::Goal("ship".into()).to_agent_input(),
            Some(AgentInput::SetGoal { objective }) if objective == "ship"
        ));
        assert!(matches!(
            Command::PauseGoal.to_agent_input(),
            Some(AgentInput::PauseGoal)
        ));
        assert!(matches!(
            Command::ResumeGoal.to_agent_input(),
            Some(AgentInput::ResumeGoal)
        ));
        assert!(matches!(
            Command::ClearGoal.to_agent_input(),
            Some(AgentInput::ClearGoal)
        ));
        assert!(matches!(
            Command::Compact.to_agent_input(),
            Some(AgentInput::Compact)
        ));
    }

    #[test]
    fn display_only_commands_have_no_agent_input() {
        assert!(Command::Tools.to_agent_input().is_none());
        assert!(Command::Usage.to_agent_input().is_none());
        assert!(Command::Session.to_agent_input().is_none());
        assert!(Command::Fork("dev".into()).to_agent_input().is_none());
    }

    #[test]
    fn parses_goal_subcommands() {
        assert_eq!(
            parse_command("/goal set ship it"),
            Some(Command::Goal("ship it".into()))
        );
        assert_eq!(parse_command("/goal pause"), Some(Command::PauseGoal));
        assert_eq!(parse_command("/goal resume"), Some(Command::ResumeGoal));
        assert_eq!(parse_command("/goal cancel"), Some(Command::ClearGoal));
        assert_eq!(parse_command("/goal reset"), Some(Command::ClearGoal));
    }

    #[test]
    fn goal_set_is_equivalent_to_bare_objective() {
        assert_eq!(parse_command("/goal set task"), parse_command("/goal task"));
        assert_eq!(
            parse_command("/goal set task"),
            Some(Command::Goal("task".into()))
        );
    }

    #[test]
    fn parses_loop_shorthand_and_cancel() {
        assert_eq!(
            parse_command("/loop 1h30m ship it"),
            Some(Command::LoopAdd {
                schedule: "1h30m".into(),
                prompt: "ship it".into(),
            })
        );
        assert_eq!(
            parse_command("/loop cancel 7"),
            Some(Command::LoopRemove("7".into()))
        );
    }

    #[test]
    fn parses_new_ux_commands() {
        assert_eq!(parse_command("/model"), Some(Command::Model(None)));
        assert_eq!(
            parse_command("/model deepseek/chat"),
            Some(Command::Model(Some("deepseek/chat".into())))
        );
        assert_eq!(parse_command("/agent"), Some(Command::Agent));
        assert_eq!(parse_command("/compact"), Some(Command::Compact));
        assert_eq!(
            parse_command("/load_other_agent_config"),
            Some(Command::LoadOtherAgentConfig)
        );
    }

    #[test]
    fn exit_is_an_alias_for_quit() {
        assert_eq!(parse_command("/exit"), Some(Command::Quit));
        assert_eq!(parse_command("/quit"), Some(Command::Quit));
    }

    #[test]
    fn completions_filter_by_prefix() {
        let all = command_completions("/");
        assert!(all.iter().any(|c| c.usage.starts_with("/goal")));
        assert!(all.iter().any(|c| c.usage.starts_with("/loop")));
        assert!(all.iter().all(|c| !c.desc.is_empty()));
        let goals = command_completions("/go");
        assert!(!goals.is_empty(), "expected matches for /go");
        assert!(goals.iter().all(|c| c.usage.starts_with("/go")));
    }
}
