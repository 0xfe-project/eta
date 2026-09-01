//! Turn-external loop scheduler (cron / hook triggers).

use serde::{Deserialize, Serialize};

/// A loop trigger: a cron schedule or a hook event filter.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Trigger {
    Cron { schedule: String },
    Hook { event_filter: String },
}

/// A registered loop, persisted in the store.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LoopSpec {
    pub loop_id: String,
    pub trigger: Trigger,
    pub enabled: bool,
    pub last_fired_at: Option<String>,
    pub run_count: u64,
    pub state: serde_json::Value,
}

/// Owns its own scheduling evaluation, independent of the goal state machine.
#[derive(Clone, Debug, Default)]
pub struct LoopManager {
    loops: Vec<LoopSpec>,
}

impl LoopManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, spec: LoopSpec) {
        self.loops.push(spec);
    }

    pub fn specs(&self) -> &[LoopSpec] {
        &self.loops
    }

    /// Select loops that should fire for a given hook event filter.
    pub fn match_hook(&self, event_filter: &str) -> Vec<&LoopSpec> {
        self.loops
            .iter()
            .filter(|l| {
                l.enabled
                    && matches!(&l.trigger, Trigger::Hook { event_filter: f } if f == event_filter)
            })
            .collect()
    }
}
