//! Skeleton proving `eta-core-controller` drives non-TUI clients.
//!
//! Sends one message through a spawned session and serializes the
//! `SessionViewState` as JSON — exactly what a WebSocket handler would
//! emit per poll. Not a real server yet; the point is the controller
//! layer's frontend-agnostic API surface.

use eta_core::AgentInput;
use eta_core_controller::{SessionManager, SessionProjection, SpawnRequest, assemble_new, spawn};
use serde_json::json;

#[tokio::main]
async fn main() {
    let request = SpawnRequest {
        agent_name: "web-demo".into(),
        persona: None,
        model_id: None,
    };
    let mut manager = SessionManager::new();
    match assemble_new(&request).await {
        Ok(plan) => {
            let id = plan.session_id.clone();
            manager.insert(spawn(plan));
            manager.attach(&id);
        }
        Err(error) => {
            eprintln!("cannot spawn session: {error:?} — set a model in ~/.eta/eta.json first");
            std::process::exit(1);
        }
    }

    let session_id = manager.current_id().expect("attached").to_string();
    let handle = manager.current_mut().expect("current handle");
    if let Some(agent) = handle.agent.as_ref() {
        agent
            .send(AgentInput::UserMessage {
                content: json!({"type":"text","text":"ping"}),
            })
            .await
            .expect("send");
    }
    let mut projection = SessionProjection::new();
    let update = projection.poll(handle).await;
    let snapshot = json!({
        "kind": "view",
        "snapshot": update.context,
        "answer_lines": update.answer_lines,
        "dev_events": update.dev_events.len(),
        "pending_ask": projection.pending_ask(),
        "working": projection.working(),
    });
    let rendered = serde_json::to_string_pretty(&snapshot).expect("snapshot serializes");
    println!("{rendered}");
    assert_eq!(
        snapshot["snapshot"]["session_id"].as_str(),
        Some(session_id.as_str())
    );
}
