//! Cache discipline: content-addressed blobs + prefix reuse.

use eta_session::{ContextCache, blob_id};

#[test]
fn blob_id_is_content_addressed() {
    assert_eq!(blob_id(b"hello"), blob_id(b"hello"));
    assert_ne!(blob_id(b"hello"), blob_id(b"world"));
}

#[test]
fn reuses_prefix_for_unchanged_messages() {
    let msgs = vec![
        serde_json::json!({ "role": "user", "content": "hi" }),
        serde_json::json!({ "role": "assistant", "content": "hello" }),
    ];
    let mut cache = ContextCache::new();
    let (_, r1) = cache.build(&msgs, 0);
    assert_eq!(r1, 0);

    // Same messages → all prefix hits.
    let (_, r2) = cache.build(&msgs, 0);
    assert_eq!(r2, msgs.len());
}

#[test]
fn serializes_only_the_new_suffix() {
    let mut msgs = vec![serde_json::json!({ "role": "user", "content": "hi" })];
    let mut cache = ContextCache::new();
    cache.build(&msgs, 0);

    // Append one message → only the new one misses the cache.
    msgs.push(serde_json::json!({ "role": "assistant", "content": "hello" }));
    let (_, reused) = cache.build(&msgs, 0);
    assert_eq!(reused, 1);
}

#[test]
fn epoch_bump_invalidates_the_prefix() {
    let msgs = vec![serde_json::json!({ "role": "user", "content": "hi" })];
    let mut cache = ContextCache::new();
    cache.build(&msgs, 0);
    let (_, r1) = cache.build(&msgs, 0);
    assert_eq!(r1, 1);

    // Compaction bumps the epoch → prefix invalidated.
    let (_, r2) = cache.build(&msgs, 1);
    assert_eq!(r2, 0);
}
