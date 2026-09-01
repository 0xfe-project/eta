//! The three retry paths: mid-stream error, truncation, and empty response.

use super::*;

#[tokio::test]
async fn retries_on_midstream_error() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![Err(ProviderError::RateLimit)],
        vec![content("recovered"), end(StopReason::EndTurn)],
    ]));
    let agent = make_agent(provider, vec![]);
    let events = collect(&agent, user_message("hi")).await;

    assert!(has_text(&events, "recovered"));
}

#[tokio::test]
async fn retries_on_truncation() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![end(StopReason::MaxTokens)],
        vec![content("continued"), end(StopReason::EndTurn)],
    ]));
    let agent = make_agent(provider, vec![]);
    let events = collect(&agent, user_message("hi")).await;

    assert!(has_text(&events, "continued"));
}

#[tokio::test]
async fn retries_on_empty_response() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![end(StopReason::EndTurn)],
        vec![content("finally"), end(StopReason::EndTurn)],
    ]));
    let agent = make_agent(provider, vec![]);
    let events = collect(&agent, user_message("hi")).await;

    assert!(has_text(&events, "finally"));
}
