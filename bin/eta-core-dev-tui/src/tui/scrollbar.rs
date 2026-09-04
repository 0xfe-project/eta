//! Panel scrollbars: a 1-column track on the right edge, with a thumb whose
//! size and position reflect (content, viewport, offset).
//!
//! Geometry mirrors crabcode's `ui/scrollbar.rs` thumb math, reduced to
//! rendering only (we don't wire mouse drag yet).

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};

/// One scrollbar's inputs: how much content, how much fits, where we are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollMetrics {
    pub content_len: usize,
    pub viewport_len: usize,
    pub offset: usize,
}

impl ScrollMetrics {
    pub fn new(content_len: usize, viewport_len: usize, offset: usize) -> Self {
        Self {
            content_len,
            viewport_len,
            offset,
        }
    }

    pub fn max_offset(self) -> usize {
        self.content_len.saturating_sub(self.viewport_len)
    }

    /// Only show when content overflows the viewport.
    pub fn should_show(self) -> bool {
        self.viewport_len > 0 && self.max_offset() > 0
    }
}

/// Thumb position inside the track, or `None` when no scrollbar is needed.
pub fn thumb(metrics: ScrollMetrics, track_height: u16) -> Option<(u16, u16)> {
    if !metrics.should_show() || track_height == 0 {
        return None;
    }
    let track_height = track_height as usize;
    let content_len = metrics.content_len.max(metrics.viewport_len);
    let thumb_len = ((metrics.viewport_len * track_height) as f32 / content_len as f32)
        .round()
        .max(1.0)
        .min(track_height as f32) as usize;
    let max_top = track_height.saturating_sub(thumb_len);
    let max_offset = metrics.max_offset();
    let top = if max_top == 0 || max_offset == 0 {
        0
    } else {
        ((metrics.offset.min(max_offset) * max_top) as f32 / max_offset as f32)
            .round()
            .clamp(0.0, max_top as f32) as usize
    };
    Some((top as u16, thumb_len as u16))
}

/// Paint the scrollbar into `buf` at `track` (should be a 1-wide rect).
pub fn render(buf: &mut Buffer, metrics: ScrollMetrics, track: Rect) {
    if track.width == 0 || track.height == 0 {
        return;
    }
    for row in track.y..track.y + track.height {
        if let Some(cell) = buf.cell_mut((track.x, row)) {
            cell.set_char('│');
            cell.set_style(Style::default().fg(Color::DarkGray));
        }
    }
    let Some((top, len)) = thumb(metrics, track.height) else {
        return;
    };
    for row in track.y + top..(track.y + top + len).min(track.y + track.height) {
        if let Some(cell) = buf.cell_mut((track.x, row)) {
            cell.set_char('█');
            cell.set_style(Style::default().fg(Color::Gray));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_scrollbar_when_content_fits() {
        let m = ScrollMetrics::new(10, 20, 0);
        assert!(!m.should_show());
        assert!(thumb(m, 20).is_none());
    }

    #[test]
    fn thumb_at_top_when_unscrolled() {
        let m = ScrollMetrics::new(100, 20, 0);
        assert_eq!(thumb(m, 20), Some((0, 4)));
    }

    #[test]
    fn thumb_at_bottom_when_fully_scrolled() {
        let m = ScrollMetrics::new(100, 20, 80);
        assert_eq!(thumb(m, 20), Some((16, 4)));
    }

    #[test]
    fn thumb_tracks_offset_proportionally() {
        let m = ScrollMetrics::new(100, 20, 40);
        let (top, len) = thumb(m, 20).unwrap();
        assert_eq!(len, 4);
        assert_eq!(top, 8);
    }

    #[test]
    fn offset_beyond_max_clamps() {
        let m = ScrollMetrics::new(100, 20, 10_000);
        assert_eq!(thumb(m, 20), Some((16, 4)));
    }

    #[test]
    fn tiny_content_gets_full_thumb() {
        let m = ScrollMetrics::new(21, 20, 0);
        let (_, len) = thumb(m, 20).unwrap();
        assert_eq!(len, 19); // 20*20/21 ≈ 19
    }
}
