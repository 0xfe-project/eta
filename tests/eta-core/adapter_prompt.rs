//! The client adapter system prompt is exposed as its own context slot.

use super::*;
use std::sync::Mutex;

struct CapturingHook {
    captured: Arc<Mutex<Option<Context>>>,
}

impl AgentHooks for CapturingHook {
    fn transform_context(&self, context: &mut Context) {
        *self.captured.lock().unwrap() = Some(context.clone());
    }
}

#[tokio::test]
async fn adapter_prompt_flows_into_context() {
    let provider = Arc::new(ScriptedProvider::new(vec![vec![
        content("ok"),
        end(StopReason::EndTurn),
    ]]));

    let captured = Arc::new(Mutex::new(None));
    let mut hooks = hooks();
    hooks.push(Arc::new(CapturingHook {
        captured: captured.clone(),
    }));

    let agent = Agent::spawn(AgentConfig {
        agent_id: AgentId("test".into()),
        provider,
        model: Model::new("test-model"),
        tools: vec![],
        hooks,
        store: Arc::new(MemStore::default()),
        system_prompt: "engine".into(),
        adapter_system_prompt: "adapter context".into(),
        max_retries: 2,
        skill_store: None,
        memory_store: Arc::new(MemMemoryStore::default()),
        max_goal_rounds: None,
    });
    let _events = collect(&agent, user_message("hi")).await;

    let context = captured
        .lock()
        .unwrap()
        .clone()
        .expect("context was transformed");
    assert!(
        context
            .system_prompt
            .as_deref()
            .unwrap_or_default()
            .contains("engine")
    );
    assert_eq!(
        context.adapter_system_prompt.as_deref(),
        Some("adapter context")
    );
}
