//! Cache discipline: content-addressed blobs + prefix reuse.

use serde_json::Value;

/// Content-addressed blob id (FNV-1a 64-bit over the serialized bytes).
///
/// Identical content maps to the same id, so unchanged messages reuse their
/// blob and only the new suffix needs re-serialization.
pub fn blob_id(data: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for &b in data {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

/// Tracks the cached message prefix so `build_context` can reuse it
/// (passthrough) and only serialize the new suffix. A compaction (epoch bump)
/// invalidates the whole prefix.
#[derive(Default)]
pub struct ContextCache {
    cached: Vec<u64>,
    epoch: u64,
}

impl ContextCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build blob ids for `messages` at `epoch`. Returns `(ids, reused)` where
    /// `reused` is the number of prefix messages that hit the cache.
    pub fn build(&mut self, messages: &[Value], epoch: u64) -> (Vec<u64>, usize) {
        if epoch != self.epoch {
            // Compaction bumped the epoch → invalidate the prefix.
            self.cached.clear();
            self.epoch = epoch;
        }

        let mut ids = Vec::with_capacity(messages.len());
        let mut reused = 0;
        for (i, msg) in messages.iter().enumerate() {
            let id = blob_id(msg.to_string().as_bytes());
            if i < self.cached.len() && self.cached[i] == id {
                reused += 1;
            }
            ids.push(id);
        }
        self.cached = ids.clone();
        (ids, reused)
    }
}
