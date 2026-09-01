//! Goal self-continuation: the evaluator marks the goal achieved.

use std::time::Duration;

use eta_core::{AgentInput, GoalStatus};

use super::*;

#[tokio::test]
async fn evaluator_marks_goal_achieved() {
    // Attempt 0 = main turn, attempt 1 = evaluator answering YES.
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![content("working"), end(StopReason::EndTurn)],
        vec![content("YES"), end(StopReason::EndTurn)],
    ]));
    let agent = make_agent(provider, vec![]);
    let mut rx = agent.subscribe();

    agent
        .send(AgentInput::SetGoal {
            objective: "do the thing".into(),
        })
        .await
        .unwrap();
    agent.send(user_message("start")).await.unwrap();

    let mut events = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Ok(AgentEvent::AgentEnd)) => break,
            Ok(Ok(ev)) => events.push(ev),
            Ok(Err(_)) | Err(_) => break,
        }
    }

    assert!(events.iter().any(|e| matches!(
        e,
        AgentEvent::GoalStateChange {
            status: GoalStatus::Achieved
        }
    )));
}
