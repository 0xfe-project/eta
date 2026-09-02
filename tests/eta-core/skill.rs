//! Skill tool: manage preferred skills.

use eta_core::{Agent, AgentConfig, AgentId, SkillEntry, render_skills};

use super::*;

#[test]
fn renders_skills_block() {
    let skills = vec![SkillEntry {
        name: "react".into(),
        content: "~/skills/react.md".into(),
    }];
    let out = render_skills(&skills);
    assert!(out.contains("<skills>"));
    assert!(out.contains("react"));
    assert!(out.contains("~/skills/react.md"));
}

#[tokio::test]
async fn skill_tool_writes_skills() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![
            tool_call(
                "s1",
                "skill",
                serde_json::json!({
                    "add": [{ "name": "react", "content": "~/skills/react.md" }]
                }),
            ),
            end(StopReason::ToolUse),
        ],
        vec![content("done"), end(StopReason::EndTurn)],
    ]));

    let store = Arc::new(MemStore::default());
    let agent = Agent::spawn(AgentConfig {
        agent_id: AgentId("test".into()),
        provider,
        model: Model::new("test-model"),
        tools: vec![],
        hooks: hooks(),
        store: store.clone(),
        system_prompt: "test".into(),
        max_retries: 2,
        max_goal_rounds: None,
    });
    let _events = collect(&agent, user_message("hi")).await;

    let saved = store.get_state("eta.skills").await.unwrap();
    let skills: Vec<SkillEntry> = serde_json::from_value(saved).unwrap();
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].name, "react");
    assert_eq!(skills[0].content, "~/skills/react.md");
}
