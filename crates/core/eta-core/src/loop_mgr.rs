//! Turn-external loop scheduler (cron / hook triggers).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::store::SessionStorage;
use crate::time::parse_duration;
use crate::types::AgentInput;

/// A loop trigger: a cron schedule or a hook event filter.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Trigger {
    /// Fire every `schedule` (a humantime interval like `5m` / `1h30m`).
    Cron { schedule: String },
    /// Fire when a hook event matches `event_filter`.
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

/// Storage key for the persisted loop registry.
const LOOPS_KEY: &str = "eta.loops";

/// Maximum cascade depth (trace hops) before a loop firing is suppressed.
const MAX_TRACE_HOPS: u32 = 8;

/// Dedup + cascade suppression for loop firing.
#[derive(Default)]
pub struct TriggerRuntime {
    fired_keys: HashSet<String>,
    trace_depths: HashMap<String, u32>,
}

impl TriggerRuntime {
    /// Whether this firing should proceed (not a duplicate key, not too deep).
    pub fn should_fire(&mut self, idempotency_key: &str, trace_id: &str) -> bool {
        if !self.fired_keys.insert(idempotency_key.to_string()) {
            return false; // duplicate key
        }
        let depth = self.trace_depths.entry(trace_id.to_string()).or_insert(0);
        if *depth >= MAX_TRACE_HOPS {
            return false; // cascade too deep
        }
        *depth += 1;
        true
    }
}

/// Schedules loops: parses cron intervals, fires `AgentInput::Loop` on a
/// `sleep_until` loop, and persists the registry so it resumes on restart.
pub struct LoopManager {
    store: Arc<dyn SessionStorage>,
    input_tx: mpsc::Sender<AgentInput>,
    runtime: Mutex<TriggerRuntime>,
}

impl LoopManager {
    pub fn new(store: Arc<dyn SessionStorage>, input_tx: mpsc::Sender<AgentInput>) -> Self {
        Self {
            store,
            input_tx,
            runtime: Mutex::new(TriggerRuntime::default()),
        }
    }

    /// Load persisted loops and start a cron task for each enabled one.
    pub async fn start(&self) -> Vec<LoopSpec> {
        let specs = self.load().await;
        for spec in &specs {
            self.schedule(spec.clone());
        }
        specs
    }

    /// Upsert a loop into the registry and schedule it if it is enabled.
    pub async fn register(&self, spec: LoopSpec) {
        let mut specs = self.load().await;
        specs.retain(|s| s.loop_id != spec.loop_id);
        specs.push(spec.clone());
        self.save(&specs).await;
        if spec.enabled {
            self.schedule(spec);
        }
    }

    /// Loops whose hook trigger matches `event_filter`.
    pub async fn match_hook(&self, event_filter: &str) -> Vec<LoopSpec> {
        self.load()
            .await
            .into_iter()
            .filter(|l| {
                l.enabled
                    && matches!(&l.trigger, Trigger::Hook { event_filter: f } if f == event_filter)
            })
            .collect()
    }

    /// Fire hook-triggered loops matching `event_filter`, deduping by
    /// `idempotency_key` and suppressing over-deep `trace_id` cascades.
    /// Returns how many loops actually fired.
    pub async fn fire_hook(
        &self,
        event_filter: &str,
        idempotency_key: &str,
        trace_id: &str,
    ) -> usize {
        let specs = self.match_hook(event_filter).await;
        let mut fired = 0;
        for spec in specs {
            if !self
                .runtime
                .lock()
                .unwrap()
                .should_fire(idempotency_key, trace_id)
            {
                continue;
            }
            let _ = self
                .input_tx
                .send(AgentInput::Loop {
                    loop_id: spec.loop_id.clone(),
                    prompt: serde_json::json!({ "loop_id": spec.loop_id }),
                })
                .await;
            fired += 1;
        }
        fired
    }

    async fn load(&self) -> Vec<LoopSpec> {
        match self.store.get_state(LOOPS_KEY).await {
            Some(serde_json::Value::Array(items)) => items
                .iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect(),
            _ => Vec::new(),
        }
    }

    async fn save(&self, specs: &[LoopSpec]) {
        self.store
            .set_state(LOOPS_KEY, serde_json::json!(specs))
            .await;
    }

    /// Spawn a `sleep_until` loop that fires `AgentInput::Loop` every interval.
    fn schedule(&self, spec: LoopSpec) {
        let Trigger::Cron { schedule } = &spec.trigger else {
            return;
        };
        let Ok(interval) = parse_duration(schedule) else {
            return;
        };
        let tx = self.input_tx.clone();
        let loop_id = spec.loop_id.clone();
        tokio::spawn(async move {
            let prompt = serde_json::json!({ "loop_id": loop_id.clone() });
            let mut next = tokio::time::Instant::now() + interval;
            loop {
                tokio::time::sleep_until(next).await;
                next += interval;
                let _ = tx
                    .send(AgentInput::Loop {
                        loop_id: loop_id.clone(),
                        prompt: prompt.clone(),
                    })
                    .await;
            }
        });
    }
}

/// Resume loops across all sessions in a multi-session backend.
///
/// `backend` enumerates session ids; `open_session` returns a per-session store
/// bound to an id. For each session, its `eta.loops` registry is loaded and its
/// cron loops are scheduled via a fresh `LoopManager`.
pub async fn bootstrap_loops(
    backend: &dyn SessionStorage,
    open_session: &dyn Fn(&str) -> Arc<dyn SessionStorage>,
    input_tx: mpsc::Sender<AgentInput>,
) -> Vec<(String, Vec<LoopSpec>)> {
    let mut resumed = Vec::new();
    for id in backend.list_sessions().await {
        let session_store = open_session(&id);
        let manager = LoopManager::new(session_store, input_tx.clone());
        resumed.push((id.clone(), manager.start().await));
    }
    resumed
}
