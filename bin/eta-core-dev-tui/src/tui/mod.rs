//! Terminal rendering. Kept as plain functions so panels are testable without a
//! live TTY where possible.

use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use tui_textarea::TextArea;

use self::goal::GoalInfo;

pub mod answer;
pub mod context;
pub mod dev;
pub mod goal;
pub mod screen;
pub mod syntax;

pub use context::ContextSnapshot;
pub use screen::Screen;

/// The four focusable regions. `Tab` cycles through them in this order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Focus {
    Answers,
    Context,
    DevEvents,
    #[default]
    Input,
}

impl Focus {
    pub fn next(self) -> Self {
        match self {
            Focus::Answers => Focus::Context,
            Focus::Context => Focus::DevEvents,
            Focus::DevEvents => Focus::Input,
            Focus::Input => Focus::Answers,
        }
    }
}

/// Draw the four-region screen: left answer area, right context/dev columns,
/// and a bottom input box. Panel contents come from the current session's
/// buffered events and snapshot.
pub fn draw(
    frame: &mut Frame,
    screen: &Screen,
    focus: Focus,
    input: &TextArea,
    answers: &[String],
    dev: &[String],
    context: Option<&ContextSnapshot>,
    goal: Option<&GoalInfo>,
    completions: &[String],
    answers_scroll: usize,
    context_scroll: usize,
    dev_scroll: usize,
    status: &str,
    dev_filter: &str,
) {
    match screen {
        Screen::Startup {
            recent, selected, ..
        } => {
            let comp = if completions.is_empty() {
                0
            } else {
                (completions.len().min(8) + 2) as u16
            };
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Min(1),
                    Constraint::Length(comp),
                    Constraint::Length(3),
                ])
                .split(frame.area());
            draw_startup(frame, chunks[0], recent, *selected);
            draw_completion_popup(frame, chunks[1], completions);
            draw_input(frame, chunks[2], input);
            return;
        }
        Screen::AgentMode { selected, .. } => {
            let options = vec!["existing agent".to_string(), "create new agent".to_string()];
            draw_list(frame, "new conversation", &options, *selected);
            return;
        }
        Screen::AgentPicker {
            agents, selected, ..
        } => {
            draw_list(frame, "choose agent", agents, *selected);
            return;
        }
        Screen::CreateAgentName { .. } => {
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Min(1), Constraint::Length(3)])
                .split(frame.area());
            draw_startup(frame, chunks[0], &["new agent name:".to_string()], 0);
            draw_input(frame, chunks[1], input);
            return;
        }
        Screen::PersonaPicker {
            personas, selected, ..
        } => {
            draw_list(frame, "choose persona", personas, *selected);
            return;
        }
        Screen::ModelPicker {
            models, selected, ..
        } => {
            draw_list(frame, "choose model", models, *selected);
            return;
        }
        Screen::AgentSwitch {
            agents, selected, ..
        } => {
            draw_list(frame, "switch agent", agents, *selected);
            return;
        }
        Screen::SessionPicker {
            current,
            sessions,
            selected,
            ..
        } => {
            draw_session_picker(frame, current.as_deref(), sessions, *selected);
            return;
        }
        Screen::Session => {}
    }

    let completions_height = if completions.is_empty() {
        0
    } else {
        (completions.len().min(8) + 2) as u16
    };
    let outer_2 = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(completions_height as u16),
            Constraint::Length(3),
        ])
        .split(frame.area());
    let (main, goal_area, status_area, completions_area, input_area) =
        (outer_2[0], outer_2[1], outer_2[2], outer_2[3], outer_2[4]);

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
        .split(main);
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(columns[1]);

    let mut highlighter = syntax::CodeHighlighter::default();
    render_panel_with(
        frame,
        columns[0],
        "answers",
        focus == Focus::Answers,
        answers,
        answers_scroll,
        |line| {
            let code_spans = highlighter.style(line);
            if code_spans.is_empty() {
                style_answer(line)
            } else {
                code_spans
            }
        },
    );

    let context_lines = context
        .map(|snapshot| context::render_snapshot(snapshot, 8))
        .unwrap_or_default();
    render_panel(
        frame,
        right[0],
        "current context",
        focus == Focus::Context,
        &context_lines,
        context_scroll,
        style_context,
    );

    let dev_filtered: Vec<String> = if dev_filter.is_empty() {
        dev.to_vec()
    } else {
        dev.iter()
            .filter(|line| line.contains(dev_filter))
            .cloned()
            .collect()
    };
    render_panel(
        frame,
        right[1],
        "dev events",
        focus == Focus::DevEvents,
        &dev_filtered,
        dev_scroll,
        style_dev,
    );

    let goal_line = goal
        .map(|goal| goal.status_line())
        .unwrap_or_else(|| "goal: —".into());
    frame.render_widget(Paragraph::new(goal_line), goal_area);
    frame.render_widget(
        Paragraph::new(status.to_string()).style(Style::default().fg(Color::DarkGray)),
        status_area,
    );

    if !completions.is_empty() {
        frame.render_widget(
            Paragraph::new(completions.join("\n"))
                .block(Block::default().title("commands").borders(Borders::ALL)),
            completions_area,
        );
    }

    let input_block = Block::default().title("input").borders(Borders::ALL);
    frame.render_widget(input_block.clone(), input_area);
    frame.render_widget(input, input_block.inner(input_area));
}

fn draw_startup(
    frame: &mut Frame,
    area: ratatui::layout::Rect,
    recent: &[String],
    selected: usize,
) {
    let mut lines = vec![
        Line::from(vec![
            Span::styled(
                "✦ eta",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(ratatui::style::Modifier::BOLD),
            ),
            Span::styled(
                "  — dev-mode coding agent",
                Style::default().fg(Color::DarkGray),
            ),
        ]),
        Line::from(""),
    ];
    if recent.is_empty() {
        lines.push(Line::from(Span::styled(
            "no recent sessions yet",
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        lines.push(Line::from(Span::styled(
            "recent sessions:",
            Style::default().fg(Color::Magenta),
        )));
        lines.extend(recent.iter().enumerate().map(|(index, id)| {
            if index == selected {
                Line::from(vec![
                    Span::styled("> ", Style::default().fg(Color::Yellow)),
                    Span::styled(
                        id.clone(),
                        Style::default()
                            .fg(Color::Yellow)
                            .add_modifier(ratatui::style::Modifier::BOLD),
                    ),
                ])
            } else {
                Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled(id.clone(), Style::default().fg(Color::Gray)),
                ])
            }
        }));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "type a message, or / for commands, ↑/↓ to pick a session",
        Style::default().fg(Color::DarkGray),
    )));
    frame.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL)),
        area,
    );
}

fn draw_list(frame: &mut Frame, title: &str, items: &[String], selected: usize) {
    let lines: Vec<String> = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            if index == selected {
                format!("> {item}")
            } else {
                format!("  {item}")
            }
        })
        .collect();
    frame.render_widget(
        Paragraph::new(lines.join("\n")).block(Block::default().title(title).borders(Borders::ALL)),
        frame.area(),
    );
}

fn draw_session_picker(
    frame: &mut Frame,
    current: Option<&str>,
    sessions: &[String],
    selected: usize,
) {
    let mut lines = vec![format!("current session: {}", current.unwrap_or("-"))];
    lines.extend(sessions.iter().enumerate().map(|(index, entry)| {
        if index == selected {
            format!("> {entry}")
        } else {
            format!("  {entry}")
        }
    }));
    frame.render_widget(
        Paragraph::new(lines.join("\n"))
            .block(Block::default().title("sessions").borders(Borders::ALL)),
        frame.area(),
    );
}

fn draw_input(frame: &mut Frame, area: ratatui::layout::Rect, input: &TextArea) {
    let input_block = Block::default().title("input").borders(Borders::ALL);
    frame.render_widget(input_block.clone(), area);
    frame.render_widget(input, input_block.inner(area));
}

fn draw_completion_popup(frame: &mut Frame, area: ratatui::layout::Rect, completions: &[String]) {
    if completions.is_empty() {
        return;
    }
    let block = Block::default().title("commands").borders(Borders::ALL);
    frame.render_widget(block.clone(), area);
    frame.render_widget(Paragraph::new(completions.join("\n")), block.inner(area));
}

/// Render a bordered, scrollable, wrap-enabled panel with per-line colors.
fn render_panel(
    frame: &mut Frame,
    rect: ratatui::layout::Rect,
    title: &str,
    focused: bool,
    lines: &[String],
    scroll: usize,
    style_fn: fn(&str) -> Vec<Span<'static>>,
) {
    render_panel_with(frame, rect, title, focused, lines, scroll, |line| {
        style_fn(line)
    });
}

fn render_panel_with(
    frame: &mut Frame,
    rect: ratatui::layout::Rect,
    title: &str,
    focused: bool,
    lines: &[String],
    scroll: usize,
    mut style_fn: impl FnMut(&str) -> Vec<Span<'static>>,
) {
    let border_style = if focused {
        Style::default().fg(Color::Yellow)
    } else {
        Style::default()
    };
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(border_style);
    frame.render_widget(block.clone(), rect);
    let inner = block.inner(rect);
    // Render the full line set and let ratatui handle wrapping and scrolling by
    // physical rows. Previously we sliced `[start..end]` by logical line count
    // *before* wrapping, which meant a single logical line that wrapped across
    // multiple rows could consume the whole viewport and make content appear to
    // vanish after one scroll step.
    let rendered: Vec<Line> = lines
        .iter()
        .map(|line| Line::from(style_fn(line)))
        .collect();
    frame.render_widget(
        Paragraph::new(rendered)
            .wrap(Wrap { trim: false })
            .scroll((scroll as u16, 0)),
        inner,
    );
}

fn style_answer(line: &str) -> Vec<Span<'static>> {
    let color = if line.starts_with("──") {
        Color::DarkGray
    } else if line.starts_with('⚙') || line.starts_with('✓') {
        Color::Cyan
    } else if line.starts_with('✗') {
        Color::Red
    } else if line.starts_with("goal:") {
        Color::Magenta
    } else if line.starts_with("model:") || line.starts_with("session:") {
        Color::Yellow
    } else {
        Color::White
    };
    vec![Span::styled(line.to_string(), Style::default().fg(color))]
}

fn style_dev(line: &str) -> Vec<Span<'static>> {
    if let Some((prefix, rest)) = line.split_once("] ") {
        let category = rest
            .split("::")
            .next()
            .and_then(|head| head.split_whitespace().last())
            .unwrap_or("");
        let cat_color = dev::category_color(category);
        vec![
            Span::styled(format!("{prefix}]"), Style::default().fg(Color::DarkGray)),
            Span::styled(rest.to_string(), Style::default().fg(cat_color)),
        ]
    } else {
        vec![Span::styled(
            line.to_string(),
            Style::default().fg(Color::Gray),
        )]
    }
}

fn style_context(line: &str) -> Vec<Span<'static>> {
    let color = if line.contains("──") {
        Color::Magenta
    } else {
        Color::White
    };
    vec![Span::styled(line.to_string(), Style::default().fg(color))]
}

#[cfg(test)]
mod tests {
    use super::{Focus, Screen, draw};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use tui_textarea::TextArea;

    #[test]
    fn renders_the_four_labeled_regions() {
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).expect("test backend");
        terminal
            .draw(|frame| {
                draw(
                    frame,
                    &Screen::session(),
                    Focus::Input,
                    &TextArea::default(),
                    &["hello".to_string()],
                    &["tool::start".to_string()],
                    None,
                    None,
                    &[],
                    0,
                    0,
                    0,
                    "",
                    "",
                )
            })
            .expect("draw");

        let rendered: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect();

        for label in ["answers", "current context", "dev events", "input", "hello"] {
            assert!(rendered.contains(label), "missing panel label: {label}");
        }
    }

    #[test]
    fn focus_tab_order_cycles_through_all_four() {
        let mut focus = Focus::Input;
        let mut visited = vec![focus];
        for _ in 0..3 {
            focus = focus.next();
            visited.push(focus);
        }
        assert_eq!(
            visited,
            vec![
                Focus::Input,
                Focus::Answers,
                Focus::Context,
                Focus::DevEvents
            ]
        );
        assert_eq!(focus.next(), Focus::Input);
    }

    #[test]
    fn renders_completion_popup_content() {
        use ratatui::Terminal;
        use ratatui::backend::TestBackend;
        let backend = TestBackend::new(120, 40);
        let mut terminal = Terminal::new(backend).expect("test backend");
        terminal
            .draw(|frame| {
                draw(
                    frame,
                    &Screen::session(),
                    Focus::Input,
                    &TextArea::default(),
                    &[],
                    &[],
                    None,
                    None,
                    &["/goal (set <objective>) - manage goal".to_string()],
                    0,
                    0,
                    0,
                    "",
                    "",
                )
            })
            .expect("draw");
        let rendered: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(
            rendered.contains("manage goal"),
            "completion popup content not rendered"
        );
    }
}
