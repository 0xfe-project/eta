//! `eta-core-dev-tui` — the dev-mode, full-screen coding agent.
//!
//! This binary exposes every internal engine signal (conversation, current
//! context, dev events) across a three-panel layout plus an input box.

mod commands;
mod config;
mod session;
mod tools;
mod tui;

use std::io;

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use tui::Focus;
use tui_textarea::TextArea;

/// Interactive UI state. More panels and session state are added in later
/// Part E items; for now this only tracks focus and the input box.
struct App {
    focus: Focus,
    input: TextArea<'static>,
}

impl App {
    fn new() -> Self {
        let mut input = TextArea::default();
        input.set_placeholder_text("type a message…");
        Self {
            focus: Focus::Input,
            input,
        }
    }
}

fn main() -> io::Result<()> {
    let mut terminal = ratatui::init();
    let mut app = App::new();
    let result = run(&mut terminal, &mut app);
    ratatui::restore();
    result
}

/// Event loop: draw the layout, cycle focus on `Tab`, and quit on `Ctrl-C`.
fn run(terminal: &mut ratatui::DefaultTerminal, app: &mut App) -> io::Result<()> {
    loop {
        terminal.draw(|frame| tui::draw(frame, app.focus, &app.input))?;
        match event::read()? {
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                let ctrl_c =
                    key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL);
                if ctrl_c {
                    return Ok(());
                }
                if key.code == KeyCode::Tab {
                    app.focus = app.focus.next();
                    continue;
                }
                if app.focus == Focus::Input {
                    app.input.input(key);
                }
            }
            _ => {}
        }
    }
}
