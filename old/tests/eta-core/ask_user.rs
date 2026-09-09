//! `ask_user`: the dedicated answer-channel round-trip.

use std::time::Duration;

use eta_core::{AgentEvent, AskUserAnswer};

use super::*;

#[tokio::test]
async fn ask_user_round_trip() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![
            tool_call("q1", "ask_user", serde_json::json!({ "question": "what?" })),
            end(StopReason::ToolUse),
        ],
        vec![content("thanks"), end(StopReason::EndTurn)],
    ]));
    let agent = make_agent(provider, vec![]);
    let mut rx = agent.subscribe();
    agent.send(user_message("go")).await.unwrap();

    // The agent emits AskUserStarted and blocks on the answer channel.
    loop {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Ok(AgentEvent::AskUserStarted { req_id, .. })) => {
                assert_eq!(req_id, "q1");
                break;
            }
            Ok(Ok(_)) => continue,
            Ok(Err(_)) | Err(_) => panic!("expected AskUserStarted"),
        }
    }

    // Answer it on the dedicated channel; the turn resumes.
    agent
        .answer(AskUserAnswer {
            tool_call_id: "q1".into(),
            answer: serde_json::json!("yes"),
        })
        .await
        .unwrap();

    let mut events = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Ok(AgentEvent::AgentEnd)) => break,
            Ok(Ok(ev)) => events.push(ev),
            Ok(Err(_)) | Err(_) => break,
        }
    }

    assert!(has_text(&events, "thanks"));
}
