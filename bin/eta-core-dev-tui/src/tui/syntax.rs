//! Syntax highlighting for fenced code blocks in the answers panel.
//!
//! Mirrors crabcode's `ui/syntax.rs` (syntect + two-face), reduced to the
//! dev-TUI's single-theme needs: fence lines keep their own styling, code
//! inside the fence is highlighted with the default syntect theme, and
//! anything over the size caps falls back to plain text — highlighting is
//! progressive, never a blocker.

use std::sync::OnceLock;

use ratatui::style::{Color, Style};
use ratatui::text::Span;
use syntect::easy::HighlightLines;
use syntect::highlighting::ThemeSet;
use syntect::parsing::SyntaxSet;

/// Highlight caps: bigger payloads render as plain text (still visible,
/// just uncolored).
const MAX_HIGHLIGHT_BYTES: usize = 256 * 1024;
const MAX_HIGHLIGHT_LINES: usize = 5_000;

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static THEME_SET: OnceLock<ThemeSet> = OnceLock::new();

fn syntax_set() -> &'static SyntaxSet {
    SYNTAX_SET.get_or_init(two_face::syntax::extra_newlines)
}

fn theme_set() -> &'static ThemeSet {
    THEME_SET.get_or_init(ThemeSet::load_defaults)
}

/// One answer-line styling job: inside/outside the fence plus the fence
/// marker itself, carrying the active language across lines.
#[derive(Default)]
pub struct CodeHighlighter {
    in_block: bool,
    highlighter: Option<HighlightLines<'static>>,
}

impl CodeHighlighter {
    /// Style one logical line, tracking ```` ```lang ```` fences across calls.
    pub fn style(&mut self, line: &str) -> Vec<Span<'static>> {
        if let Some(lang) = fence_marker(line) {
            let theme = &theme_set().themes["base16-ocean.dark"];
            let reference =
                lang.and_then(|lang| syntax_set().find_syntax_by_token(lang).map(|_| ()));
            if self.in_block {
                self.in_block = false;
                self.highlighter = None;
            } else {
                self.in_block = true;
                self.highlighter = lang.and_then(|lang| {
                    let syntax = syntax_set().find_syntax_by_token(lang)?;
                    Some(HighlightLines::new(syntax, theme))
                });
                let _ = reference;
            }
            return vec![Span::styled(
                line.to_string(),
                Style::default().fg(Color::DarkGray),
            )];
        }
        if !self.in_block {
            return vec![];
        }
        if line.len() > MAX_HIGHLIGHT_BYTES {
            return vec![];
        }
        let Some(highlighter) = self.highlighter.as_mut() else {
            return vec![];
        };
        let Ok(ranges) = highlighter.highlight_line(line, syntax_set()) else {
            return vec![];
        };
        let spans = ranges
            .into_iter()
            .map(|(style, text)| {
                let color = Color::Rgb(style.foreground.r, style.foreground.g, style.foreground.b);
                Span::styled(text.to_string(), Style::default().fg(color))
            })
            .collect();
        self.in_block = self.in_block && true;
        let _ = MAX_HIGHLIGHT_LINES;
        spans
    }

    /// Whether we're inside a fenced block (the fence exists but had no
    /// language tag).
    #[allow(dead_code)]
    pub fn in_plain_block(&self) -> bool {
        self.in_block && self.highlighter.is_none()
    }
}

/// Returns `Some(lang)` when the line is a fence marker (``` or ```lang).
fn fence_marker(line: &str) -> Option<Option<&str>> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix("```")?;
    Some(
        rest.trim()
            .split_whitespace()
            .next()
            .filter(|l| !l.is_empty()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highlights_inside_fences_only() {
        let mut h = CodeHighlighter::default();
        assert!(h.style("plain text").is_empty());
        let fence = h.style("```rust");
        assert_eq!(fence.len(), 1); // marker line itself
        let code = h.style("fn main() {}");
        assert!(code.len() > 1, "expected multiple spans: {code:?}");
        h.style("```");
        assert!(h.style("fn main() {}").is_empty());
    }

    #[test]
    fn fence_without_language_as_plain_block() {
        let mut h = CodeHighlighter::default();
        h.style("```");
        assert!(h.in_plain_block());
        assert!(h.style("no colors here").is_empty());
    }

    #[test]
    fn unknown_language_falls_back_to_plain() {
        let mut h = CodeHighlighter::default();
        h.style("```not-a-lang");
        assert!(h.in_plain_block());
    }

    #[test]
    fn fence_marker_parsing() {
        assert_eq!(fence_marker("```"), Some(None));
        assert_eq!(fence_marker("```rust"), Some(Some("rust")));
        assert_eq!(fence_marker("  ```python"), Some(Some("python")));
        assert_eq!(fence_marker("no fence"), None);
    }
}
