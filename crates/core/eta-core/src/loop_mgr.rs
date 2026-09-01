//! Turn-external loop scheduler (cron / hook triggers).

use std::sync::Arc;

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

/// Schedules loops: parses cron intervals, fires `AgentInput::Loop` on a
/// `sleep_until` loop, and persists the registry so it resumes on restart.
pub struct LoopManager {
    store: Arc<dyn SessionStorage>,
    input_tx: mpsc::Sender<AgentInput>,
}

impl LoopManager {
    pub fn new(store: Arc<dyn SessionStorage>, input_tx: mpsc::Sender<AgentInput>) -> Self {
        Self { store, input_tx }
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
