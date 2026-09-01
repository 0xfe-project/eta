//! `LoopDetector`: near-duplicate assistant content.

use eta_core::LoopDetector;

#[test]
fn detects_near_duplicate_content() {
    let mut d = LoopDetector::new();
    assert!(!d.observe("the quick brown fox jumps"));
    assert!(!d.observe("the quick brown fox jumps!"));
    assert!(d.observe("the quick brown fox jumps!!"));
}

#[test]
fn ignores_dissimilar_content() {
    let mut d = LoopDetector::new();
    assert!(!d.observe("the quick brown fox"));
    assert!(!d.observe("completely different topic"));
    assert!(!d.observe("yet another unrelated thing"));
}
