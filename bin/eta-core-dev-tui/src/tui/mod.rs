//! Terminal rendering. Kept as plain functions so panels are testable without a
//! live TTY where possible.

use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::widgets::{Block, Borders};

/// Draw the four-region screen: left answer area, right context/dev columns,
/// and a bottom input box. Data is wired into the panels in later Part E items.
pub fn draw(frame: &mut Frame) {
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

    frame.render_widget(
        Block::default().title("answers").borders(Borders::ALL),
        columns[0],
    );
    frame.render_widget(
        Block::default()
            .title("current context")
            .borders(Borders::ALL),
        right[0],
    );
    frame.render_widget(
        Block::default().title("dev events").borders(Borders::ALL),
        right[1],
    );
    frame.render_widget(
        Block::default().title("input").borders(Borders::ALL),
        input_area,
    );
}

#[cfg(test)]
mod tests {
    use super::draw;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    #[test]
    fn renders_the_four_labeled_regions() {
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).expect("test backend");
        terminal.draw(draw).expect("draw");

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
}
