//! Todo system: `update_todos` tool + `<current_tasks>` durable block.

use eta_core::{TodoItem, TodoStatus, render_todos};

use super::*;

#[test]
fn renders_current_tasks_block() {
    let todos = vec![
        TodoItem {
            id: "1".into(),
            content: "design schema".into(),
            status: TodoStatus::InProgress,
        },
        TodoItem {
            id: "2".into(),
            content: "write handler".into(),
            status: TodoStatus::Pending,
        },
    ];
    let out = render_todos(&todos);
    assert!(out.contains("<current_tasks>"));
    assert!(out.contains("- [in_progress] design schema"));
    assert!(out.contains("- [pending] write handler"));
}

#[tokio::test]
async fn update_todos_persists_and_merges() {
    // Two update_todos calls: first sets [1], then merges in [1 done, 2 new].
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![
            tool_call(
                "t1",
                "update_todos",
                serde_json::json!({
                    "merge": false,
                    "todos": [{ "id": "1", "content": "do x", "status": "in_progress" }]
                }),
            ),
            end(StopReason::ToolUse),
        ],
        vec![
            tool_call(
                "t2",
                "update_todos",
                serde_json::json!({
                    "merge": true,
                    "todos": [
                        { "id": "1", "status": "completed" },
                        { "id": "2", "content": "do y", "status": "pending" }
                    ]
                }),
            ),
            end(StopReason::ToolUse),
        ],
        vec![content("ok"), end(StopReason::EndTurn)],
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
        adapter_system_prompt: "".into(),
        max_retries: 2,
        skill_store: None,
        memory_store: Arc::new(MemMemoryStore::default()),
        max_goal_rounds: None,
    });
    let _events = collect(&agent, user_message("plan")).await;

    let saved = store.get_state("eta.todos").await.unwrap();
    let todos: Vec<TodoItem> = serde_json::from_value(saved).unwrap();
    assert_eq!(todos.len(), 2);
    assert_eq!(todos[0].id, "1");
    assert_eq!(todos[0].content, "do x"); // merged keeps content
    assert_eq!(todos[0].status, TodoStatus::Completed);
    assert_eq!(todos[1].id, "2");
    assert_eq!(todos[1].status, TodoStatus::Pending);
}
