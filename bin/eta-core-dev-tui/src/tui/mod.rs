//! Terminal rendering. Kept as plain functions so panels are testable without a
//! live TTY where possible.

use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Style};
use ratatui::widgets::{Block, Borders, Paragraph};
use tui_textarea::TextArea;

use self::goal::GoalInfo;

pub mod answer;
pub mod context;
pub mod dev;
pub mod goal;
pub mod screen;

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
) {
    match screen {
        Screen::Startup {
            recent, selected, ..
        } => {
            draw_startup(frame, recent, *selected);
            draw_input(frame, input);
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
            draw_startup(frame, &["new agent name:".to_string()], 0);
            draw_input(frame, input);
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
        Screen::Session => {}
    }

    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(1),
            Constraint::Length(1),
            Constraint::Length(3),
        ])
        .split(frame.area());
    let (main, goal_area, input_area) = (outer[0], outer[1], outer[2]);

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
        .split(main);
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(columns[1]);

    let focused_style = Style::default().fg(Color::Yellow);
    let answers_block = panel("answers", focus == Focus::Answers, focused_style);
    frame.render_widget(answers_block.clone(), columns[0]);
    frame.render_widget(
        Paragraph::new(answers.join("\n")),
        answers_block.inner(columns[0]),
    );

    let context_block = panel("current context", focus == Focus::Context, focused_style);
    frame.render_widget(context_block.clone(), right[0]);
    let context_lines = context
        .map(|snapshot| context::render_snapshot(snapshot, 8))
        .unwrap_or_default();
    frame.render_widget(
        Paragraph::new(context_lines.join("\n")),
        context_block.inner(right[0]),
    );

    let dev_block = panel("dev events", focus == Focus::DevEvents, focused_style);
    frame.render_widget(dev_block.clone(), right[1]);
    frame.render_widget(Paragraph::new(dev.join("\n")), dev_block.inner(right[1]));

    let goal_line = goal
        .map(|goal| goal.status_line())
        .unwrap_or_else(|| "goal: —".into());
    frame.render_widget(Paragraph::new(goal_line), goal_area);

    let input_block = Block::default().title("input").borders(Borders::ALL);
    frame.render_widget(input_block.clone(), input_area);
    frame.render_widget(input, input_block.inner(input_area));
}

fn draw_startup(frame: &mut Frame, recent: &[String], selected: usize) {
    let body = if recent.is_empty() {
        "no recent sessions — type a message to start".to_string()
    } else {
        let mut lines = vec!["recent sessions:".to_string()];
        lines.extend(recent.iter().enumerate().map(|(index, id)| {
            if index == selected {
                format!("> {id}")
            } else {
                format!("  {id}")
            }
        }));
        lines.join("\n")
    };
    frame.render_widget(
        Paragraph::new(body).block(Block::default().title("eta").borders(Borders::ALL)),
        frame.area(),
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

fn draw_input(frame: &mut Frame, input: &TextArea) {
    let area = frame.area();
    let input_area = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(3)])
        .split(area)[1];
    let input_block = Block::default().title("input").borders(Borders::ALL);
    frame.render_widget(input_block.clone(), input_area);
    frame.render_widget(input, input_block.inner(input_area));
}

fn panel(title: &str, selected: bool, focused: Style) -> Block<'static> {
    let style = if selected { focused } else { Style::default() };
    Block::default()
        .title(title.to_owned())
        .borders(Borders::ALL)
        .border_style(style)
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
}
