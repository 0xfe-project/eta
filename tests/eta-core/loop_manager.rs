//! LoopManager: cron scheduling + persistence / resume.

use std::time::Duration;

use eta_core::{AgentInput, LoopManager, LoopSpec, Trigger};

use super::*;

fn cron_spec(id: &str, schedule: &str) -> LoopSpec {
    LoopSpec {
        loop_id: id.into(),
        trigger: Trigger::Cron {
            schedule: schedule.into(),
        },
        enabled: true,
        last_fired_at: None,
        run_count: 0,
        state: serde_json::json!({}),
    }
}

#[tokio::test]
async fn cron_loop_fires_periodically() {
    let store = Arc::new(MemStore::default());
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let lm = LoopManager::new(store, tx);

    lm.register(cron_spec("l1", "10ms")).await;

    match tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
        Ok(Some(AgentInput::Loop { loop_id, .. })) => assert_eq!(loop_id, "l1"),
        other => panic!("expected loop fire, got {other:?}"),
    }
}

#[tokio::test]
async fn persisted_loops_resume_on_start() {
    let store = Arc::new(MemStore::default());
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    let lm = LoopManager::new(store.clone(), tx);
    lm.register(cron_spec("l1", "10ms")).await;

    // A new manager over the same store resumes the saved loop.
    let (tx2, mut rx2) = tokio::sync::mpsc::channel(8);
    let lm2 = LoopManager::new(store.clone(), tx2);
    let resumed = lm2.start().await;
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].loop_id, "l1");

    match tokio::time::timeout(Duration::from_secs(1), rx2.recv()).await {
        Ok(Some(AgentInput::Loop { loop_id, .. })) => assert_eq!(loop_id, "l1"),
        other => panic!("expected resumed loop fire, got {other:?}"),
    }
}
