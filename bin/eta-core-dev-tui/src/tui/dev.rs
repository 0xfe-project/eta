//! Pure rendering and filtering for the dev-event stream (E4).

use std::time::Instant;

use eta_core::{AgentDevEvent, dev_category};
use ratatui::style::Color;

/// Format one dev event as a single line with a relative timestamp.
#[allow(dead_code)]
pub fn dev_event_line(event: &AgentDevEvent, base: Instant) -> String {
    let relative = event.ts.saturating_duration_since(base).as_secs_f32();
    let agent_id = event.agent_id.0.chars().take(8).collect::<String>();
    format!(
        "[{relative:>7.2}s] {agent_id} {}::{} {}",
        event.category, event.action, event.data
    )
}

/// Whether an event category matches the filter. Empty filters match all.
#[allow(dead_code)]
pub fn matches_category(category: &str, filter: &str) -> bool {
    filter.is_empty() || category.contains(filter)
}

/// Stable category → color mapping used by the dev panel.
#[allow(dead_code)]
pub fn category_color(category: &str) -> Color {
    match category {
        dev_category::LIFECYCLE => Color::White,
        dev_category::TURN => Color::Cyan,
        dev_category::USAGE => Color::Blue,
        dev_category::PROMPT => Color::Magenta,
        dev_category::COMPACTION => Color::Yellow,
        dev_category::LOOP => Color::Green,
        dev_category::GOAL => Color::LightGreen,
        dev_category::MEMORY => Color::LightCyan,
        dev_category::SKILL => Color::LightMagenta,
        dev_category::TODO => Color::LightBlue,
        dev_category::STATE => Color::LightYellow,
        dev_category::TOOL => Color::Gray,
        dev_category::RETRY => Color::Red,
        dev_category::ASK_USER => Color::LightRed,
        _ => Color::Reset,
    }
}

#[cfg(test)]
mod tests {
    use super::{category_color, dev_event_line, matches_category};
    use eta_core::{AgentDevEvent, AgentId, dev_category};
    use ratatui::style::Color;
    use std::time::{Duration, Instant};

    #[test]
    fn formats_event_with_relative_time() {
        let base = Instant::now();
        let event = AgentDevEvent {
            ts: base + Duration::from_millis(1250),
            agent_id: AgentId("eta".into()),
            category: dev_category::TOOL.into(),
            action: "start".into(),
            data: serde_json::json!({"name": "bash"}),
        };
        let line = dev_event_line(&event, base);
        assert!(line.contains("1.25s"), "unexpected line: {line}");
        assert!(line.contains("tool::start"));
        assert!(line.contains("\"name\":\"bash\""));
    }

    #[test]
    fn filters_by_category_substring() {
        assert!(matches_category(dev_category::TOOL, ""));
        assert!(matches_category(dev_category::TOOL, "tool"));
        assert!(matches_category(dev_category::LIFECYCLE, "life"));
        assert!(!matches_category(dev_category::TOOL, "retry"));
    }

    #[test]
    fn maps_known_categories_to_colors() {
        assert_eq!(category_color(dev_category::RETRY), Color::Red);
        assert_eq!(category_color("unknown"), Color::Reset);
    }
}
