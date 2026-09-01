//! Integration tests for `eta-session`: time travel (commit DAG + branches).

use eta_session::BranchManager;

fn snap(key: &str, value: &str) -> serde_json::Value {
    serde_json::json!({ key: value })
}

#[test]
fn commit_checkout_rollback_roundtrip() {
    let mut bm = BranchManager::new();
    bm.set_current(snap("v", "1"));
    let c1 = bm.commit("first");
    bm.set_current(snap("v", "2"));
    bm.commit("second");

    assert!(bm.rollback(c1).is_some());
    assert_eq!(bm.current(), &snap("v", "1"));
}

#[test]
fn fork_and_merge_produce_two_parent_commit() {
    let mut bm = BranchManager::new();
    bm.set_current(snap("v", "base"));
    bm.commit("base");

    bm.fork("feature");
    bm.set_current(snap("v", "main"));
    bm.commit("main work");
    bm.merge("feature").unwrap();

    // HEAD is now the merge commit, whose first entry has two parents.
    let h = bm.history();
    assert_eq!(h[0].parents.len(), 2);
}

#[test]
fn history_walks_parent_chain() {
    let mut bm = BranchManager::new();
    bm.set_current(snap("v", "1"));
    bm.commit("one");
    bm.set_current(snap("v", "2"));
    bm.commit("two");
    bm.set_current(snap("v", "3"));
    bm.commit("three");

    let h = bm.history();
    assert_eq!(h.len(), 3);
    assert_eq!(h[0].message, "three");
    assert_eq!(h[2].message, "one");
}

#[test]
fn search_finds_matching_snapshot() {
    let mut bm = BranchManager::new();
    bm.set_current(snap("key", "hello world"));
    bm.commit("with hello");

    assert_eq!(bm.search("hello"), vec![0]);
    assert!(bm.search("missing").is_empty());
}
