//! A single user turn producing assistant content.

use super::*;

#[tokio::test]
async fn runs_a_basic_turn() {
    let provider = Arc::new(ScriptedProvider::new(vec![vec![
        content("hello"),
        end(StopReason::EndTurn),
    ]]));
    let agent = make_agent(provider, vec![]);
    let events = collect(&agent, user_message("hi")).await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::TurnStart { .. }))
    );
    assert!(has_text(&events, "hello"));
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::TurnEnd { .. }))
    );
}
