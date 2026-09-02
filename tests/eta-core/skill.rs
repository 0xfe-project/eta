//! Skills: dumped wholesale into context (no skill tool).

use eta_core::{Skill, render_skills};

use super::*;

#[test]
fn renders_skills_block() {
    let skills = vec![Skill {
        name: "react".into(),
        content: "~/skills/react.md".into(),
    }];
    let out = render_skills(&skills);
    assert!(out.contains("<skills>"));
    assert!(out.contains("react"));
    assert!(out.contains("~/skills/react.md"));
}

#[tokio::test]
async fn skill_store_dumped_into_context() {
    // A skill store that returns one skill. The agent should inject it into the
    // assembled system prompt (no tool call needed).
    struct OneSkillStore;
    #[async_trait::async_trait]
    impl eta_core::SkillStore for OneSkillStore {
        async fn list(&self) -> Vec<Skill> {
            vec![Skill {
                name: "react".into(),
                content: "~/skills/react.md".into(),
            }]
        }
    }

    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![content("done"), end(StopReason::EndTurn)],
        vec![content("{}")],
    ]));
    let store = Arc::new(MemStore::default());
    let agent = Agent::spawn(AgentConfig {
        agent_id: AgentId("test".into()),
        provider,
        model: Model::new("test-model"),
        tools: vec![],
        hooks: hooks(),
        store,
        skill_store: Some(Arc::new(OneSkillStore)),
        memory_store: None,
        system_prompt: "test".into(),
        max_retries: 2,
        max_goal_rounds: None,
    });
    let mut dev = agent.subscribe_dev();
    let _events = collect(&agent, user_message("hi")).await;

    let mut saw_skill = false;
    while let Ok(ev) = dev.try_recv() {
        if ev.category == eta_core::dev_category::PROMPT {
            if let Some(p) = ev.data.get("system_prompt").and_then(|v| v.as_str()) {
                if p.contains("<skills>") && p.contains("react") {
                    saw_skill = true;
                }
            }
        }
    }
    assert!(
        saw_skill,
        "skill block should appear in the assembled prompt"
    );
}
