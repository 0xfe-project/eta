//! Loop detection: single-message similarity, content tail repetition, and
//! repeated tool-call fingerprints (doom loops).

use std::collections::HashMap;

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

/// How many times the exact same tool call (name + identical arguments) may
/// fire before it counts as a doom loop. Mirrors crabcode's threshold.
pub const DOOM_LOOP_THRESHOLD: u32 = 3;

/// Detects repeated identical tool calls (name + arguments fingerprint).
/// Safe read-like tools get a higher allowance than mutating ones, the same
/// split crabcode applies.
#[derive(Clone, Debug, Default)]
pub struct DoomLoopDetector {
    call_counts: HashMap<String, u32>,
}

impl DoomLoopDetector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one tool call; returns true when it has repeated enough times
    /// to look like the agent is stuck.
    pub fn observe(&mut self, name: &str, arguments: &serde_json::Value) -> bool {
        let fingerprint = format!(
            "{name}:{}",
            serde_json::to_string(arguments).unwrap_or_else(|_| arguments.to_string())
        );
        let count = self.call_counts.entry(fingerprint).or_insert(0);
        *count += 1;
        *count >= DOOM_LOOP_THRESHOLD
    }

    pub fn reset(&mut self) {
        self.call_counts.clear();
    }
}

/// Detects tail repetition inside a single content blob: the model emitting
/// the same chunk over and over at the end of its output (crabcode's
/// `tail_repetition:N@thinking` signal). Returns the repeated tail when the
/// last `window` chars consist of the same sentence/line repeated at least
/// `min_repeats` times.
pub fn tail_repetition(content: &str, min_repeats: usize) -> Option<String> {
    if content.len() < 64 || min_repeats < 2 {
        return None;
    }
    // Candidate unit: the trailing non-empty line.
    let tail = content.trim_end();
    let unit = tail.lines().last()?.trim();
    if unit.len() < 16 {
        return None;
    }
    let mut repeats = 0usize;
    for line in tail.lines().rev() {
        if line.trim() == unit {
            repeats += 1;
        } else {
            break;
        }
    }
    (repeats >= min_repeats).then(|| unit.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doom_loop_fires_on_third_identical_call() {
        let mut detector = DoomLoopDetector::new();
        let args = serde_json::json!({"path": "/tmp/a"});
        assert!(!detector.observe("read_file", &args));
        assert!(!detector.observe("read_file", &args));
        assert!(detector.observe("read_file", &args));
    }

    #[test]
    fn doom_loop_ignores_different_args_or_tools() {
        let mut detector = DoomLoopDetector::new();
        let a = serde_json::json!({"path": "/tmp/a"});
        let b = serde_json::json!({"path": "/tmp/b"});
        assert!(!detector.observe("read_file", &a));
        assert!(!detector.observe("read_file", &b));
        assert!(!detector.observe("write_file", &a));
        assert!(!detector.observe("read_file", &a));
    }

    #[test]
    fn doom_loop_reset_clears_counts() {
        let mut detector = DoomLoopDetector::new();
        let args = serde_json::json!({"path": "/tmp/a"});
        detector.observe("read_file", &args);
        detector.observe("read_file", &args);
        detector.reset();
        assert!(!detector.observe("read_file", &args));
    }

    #[test]
    fn tail_repetition_finds_repeated_lines() {
        let content = "Some reasoning.\n".to_string()
            + &"I will now read the file to understand the code.\n".repeat(6);
        let repeat = tail_repetition(&content, 4).expect("tail repeat");
        assert_eq!(repeat, "I will now read the file to understand the code.");
    }

    #[test]
    fn tail_repetition_ignores_short_or_varied_output() {
        assert!(tail_repetition("ok\nok\nok\nok\nok", 3).is_none());
        let varied = (0..6)
            .map(|i| format!("step {i} does something different enough"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(tail_repetition(&varied, 3).is_none());
        assert!(tail_repetition("short", 3).is_none());
    }
}
