//! Slash-command parsing (E7).

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
    Model(String),
    Provider(String),
    Session,
    NewSession,
    SessionNew,
    SessionRemove(String),
    SessionRename { prefix: String, name: String },
    Clear,
    Help,
    Quit,
}

/// Parse a line beginning with `/` into a command, or `None` for plain text.
pub fn parse_command(input: &str) -> Option<Command> {
    let body = input.trim().strip_prefix('/')?;
    let tokens = tokenize(body);
    let (head, rest) = tokens.split_first()?;
    match head.to_ascii_lowercase().as_str() {
        "goal" => Some(Command::Goal(rest.join(" "))),
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
        "model" => rest.first().map(|id| Command::Model(id.clone())),
        "provider" => rest.first().map(|name| Command::Provider(name.clone())),
        "session" => parse_session(rest),
        "new-session" => Some(Command::NewSession),
        "clear" => Some(Command::Clear),
        "help" => Some(Command::Help),
        "quit" => Some(Command::Quit),
        _ => None,
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
        Some(action) if action == "rm" => rest.get(1).cloned().map(Command::LoopRemove),
        Some(action) if action == "enable" => rest.get(1).cloned().map(Command::LoopEnable),
        Some(action) if action == "disable" => rest.get(1).cloned().map(Command::LoopDisable),
        _ => None,
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
    use super::{Command, parse_command};

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
            Some(Command::Model("deepseek/chat".into()))
        );
        assert_eq!(parse_command("/quit"), Some(Command::Quit));
    }
}
