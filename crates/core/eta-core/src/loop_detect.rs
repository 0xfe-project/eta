//! Single-message loop detection via string similarity.

/// Similarity thresholds: a pair of messages counts as "the same" (a loop) when
/// any metric clears its threshold.
const JARO_WINKLER_THRESHOLD: f64 = 0.7;
const SORENSEN_DICE_THRESHOLD: f64 = 0.7;

/// True when `a` and `b` are similar enough to be the same message.
///
/// Uses three metrics:
/// - Levenshtein: edit distance budget scales with length (~25%).
/// - Jaro-Winkler: prefix-friendly, good for short strings.
/// - Sørensen-Dice: bigram overlap, tolerant of reordering.
fn is_similar(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let edit_budget = (a.len().max(b.len()) / 4).max(1);
    strsim::levenshtein(a, b) <= edit_budget
        || strsim::jaro_winkler(a, b) > JARO_WINKLER_THRESHOLD
        || strsim::sorensen_dice(a, b) > SORENSEN_DICE_THRESHOLD
}

/// Detects a single-message loop: the assistant keeps producing (near-)identical
/// content.
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
            if is_similar(prev, content) {
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
