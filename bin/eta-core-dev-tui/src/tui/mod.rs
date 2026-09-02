//! Terminal rendering. Kept as plain functions so panels are testable without a
//! live TTY where possible.

use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Style};
use ratatui::widgets::{Block, Borders};
use tui_textarea::TextArea;

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
/// and a bottom input box. Data is wired into the panels in later Part E items.
pub fn draw(frame: &mut Frame, focus: Focus, input: &TextArea) {
    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(3)])
        .split(frame.area());
    let (main, input_area) = (outer[0], outer[1]);

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
        .split(main);
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(columns[1]);

    let focused_style = Style::default().fg(Color::Yellow);
    frame.render_widget(
        panel("answers", focus == Focus::Answers, focused_style),
        columns[0],
    );
    frame.render_widget(
        panel("current context", focus == Focus::Context, focused_style),
        right[0],
    );
    frame.render_widget(
        panel("dev events", focus == Focus::DevEvents, focused_style),
        right[1],
    );
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
    use super::{Focus, draw};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use tui_textarea::TextArea;

    #[test]
    fn renders_the_four_labeled_regions() {
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).expect("test backend");
        terminal
            .draw(|frame| draw(frame, Focus::Input, &TextArea::default()))
            .expect("draw");

        let rendered: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect();

        for label in ["answers", "current context", "dev events", "input"] {
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
