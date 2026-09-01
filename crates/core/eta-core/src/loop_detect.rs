//! Single-message loop detection.

/// Detects a single-message loop: identical assistant content repeated.
#[derive(Clone, Debug, Default)]
pub struct LoopDetector {
    last_content: Option<String>,
    repeat_count: u32,
}

impl LoopDetector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one step's assistant text; returns true if it looks like a loop.
    pub fn observe(&mut self, content: &str) -> bool {
        if let Some(prev) = &self.last_content {
            if prev == content {
                self.repeat_count += 1;
                return self.repeat_count >= 2;
            }
        }
        self.last_content = Some(content.to_string());
        self.repeat_count = 0;
        false
    }

    pub fn reset(&mut self) {
        self.last_content = None;
        self.repeat_count = 0;
    }
}
