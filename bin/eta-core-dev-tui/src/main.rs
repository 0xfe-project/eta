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

fn main() -> io::Result<()> {
    let mut terminal = ratatui::init();
    let result = run(&mut terminal);
    ratatui::restore();
    result
}

/// Minimal event loop: draw the empty layout, exit on `q` / `Esc` / `Ctrl-C`.
fn run(terminal: &mut ratatui::DefaultTerminal) -> io::Result<()> {
    loop {
        terminal.draw(tui::draw)?;
        match event::read()? {
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                let quit = key.code == KeyCode::Char('q') || key.code == KeyCode::Esc;
                let ctrl_c =
                    key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL);
                if quit || ctrl_c {
                    return Ok(());
                }
            }
            _ => {}
        }
    }
}
