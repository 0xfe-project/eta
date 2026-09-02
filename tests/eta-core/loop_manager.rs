//! LoopManager: cron scheduling + persistence / resume.

use std::time::Duration;

use eta_core::{AgentInput, LoopManager, LoopSpec, Trigger, bootstrap_loops};

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

fn hook_spec(id: &str, event_filter: &str) -> LoopSpec {
    LoopSpec {
        loop_id: id.into(),
        trigger: Trigger::Hook {
            event_filter: event_filter.into(),
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

#[tokio::test]
async fn fire_hook_fires_matching_loops() {
    let store = Arc::new(MemStore::default());
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let lm = LoopManager::new(store, tx);
    lm.register(hook_spec("h1", "event_x")).await;

    assert_eq!(lm.fire_hook("event_x", "key_1", "trace_1").await, 1);

    match tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
        Ok(Some(AgentInput::Loop { loop_id, .. })) => assert_eq!(loop_id, "h1"),
        other => panic!("expected hook fire, got {other:?}"),
    }
}

#[tokio::test]
async fn fire_hook_dedupes_by_idempotency_key() {
    let store = Arc::new(MemStore::default());
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    let lm = LoopManager::new(store, tx);
    lm.register(hook_spec("h1", "event_x")).await;

    assert_eq!(lm.fire_hook("event_x", "key_1", "trace_1").await, 1);
    assert_eq!(lm.fire_hook("event_x", "key_1", "trace_2").await, 0);
}

#[tokio::test]
async fn fire_hook_suppresses_deep_cascade() {
    let store = Arc::new(MemStore::default());
    let (tx, _rx) = tokio::sync::mpsc::channel(64);
    let lm = LoopManager::new(store, tx);
    lm.register(hook_spec("h1", "event_x")).await;

    // Same trace_id, unique keys: first 8 fire, the 9th is suppressed.
    for i in 0..8 {
        assert_eq!(
            lm.fire_hook("event_x", &format!("key_{i}"), "trace_1")
                .await,
            1
        );
    }
    assert_eq!(lm.fire_hook("event_x", "key_8", "trace_1").await, 0);
}

#[tokio::test]
async fn loop_manager_emits_dev_events() {
    use eta_core::{AgentDevEvent, AgentId, dev_category};

    let store = Arc::new(MemStore::default());
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    let (dev_tx, mut dev_rx) = tokio::sync::broadcast::channel(32);
    let mut lm = LoopManager::new(store, tx);
    lm.with_dev(AgentId("a1".into()), dev_tx);
    lm.register(hook_spec("h1", "event_x")).await;
    lm.fire_hook("event_x", "key_1", "trace_1").await;
    lm.fire_hook("event_x", "key_1", "trace_2").await;

    let mut events: Vec<AgentDevEvent> = Vec::new();
    while let Ok(ev) = dev_rx.try_recv() {
        events.push(ev);
    }

    assert!(
        events
            .iter()
            .any(|e| e.category == dev_category::LOOP && e.action == "register")
    );
    assert!(
        events
            .iter()
            .any(|e| e.category == dev_category::LOOP && e.action == "suppress")
    );
}

/// A multi-session backend that only enumerates session ids.
struct FakeBackend {
    sessions: Vec<String>,
}

#[async_trait]
impl SessionStorage for FakeBackend {
    async fn load(&self) -> Vec<SessionEntry> {
        vec![]
    }
    async fn append(&self, _entry: SessionEntry) {}
    async fn checkpoint(&self, _state: serde_json::Value) {}
    async fn search(&self, _query: &str) -> Vec<u64> {
        vec![]
    }
    async fn get_state(&self, _key: &str) -> Option<serde_json::Value> {
        None
    }
    async fn set_state(&self, _key: &str, _value: serde_json::Value) {}
    async fn delete_state(&self, _key: &str) {}
    async fn list_state_keys(&self) -> Vec<String> {
        vec![]
    }
    async fn list_sessions(&self) -> Vec<String> {
        self.sessions.clone()
    }
}

#[tokio::test]
async fn bootstrap_resumes_loops_across_sessions() {
    let backend = Arc::new(FakeBackend {
        sessions: vec!["s1".into()],
    });

    // The per-session store for "s1" already has a loop registered.
    let session_store = Arc::new(MemStore::default());
    let (tx0, _rx0) = tokio::sync::mpsc::channel(8);
    let lm0 = LoopManager::new(session_store.clone(), tx0);
    lm0.register(cron_spec("l1", "10ms")).await;

    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    let open_session = |id: &str| -> Arc<dyn SessionStorage> {
        assert_eq!(id, "s1");
        session_store.clone()
    };
    let resumed = bootstrap_loops(backend.as_ref(), &open_session, tx).await;

    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].0, "s1");
    assert_eq!(resumed[0].1.len(), 1);
    assert_eq!(resumed[0].1[0].loop_id, "l1");
}
