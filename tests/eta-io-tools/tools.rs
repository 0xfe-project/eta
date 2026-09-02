use eta_core::{CancelToken, Tool};
use eta_io_tools::{BashTool, FileTool};

#[tokio::test]
async fn bash_and_file_tools_round_trip_with_bounded_output() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.txt");
    let file = FileTool;

    file.execute(
        serde_json::json!({
            "operation": "write",
            "path": path,
            "content": "alpha\nbeta\n"
        }),
        CancelToken::new(),
    )
    .await
    .unwrap();

    let read = file
        .execute(
            serde_json::json!({
                "operation": "read", "path": path
            }),
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(read["content"], "alpha\nbeta");

    file.execute(
        serde_json::json!({
            "operation": "edit", "path": path, "find": "beta", "replace": "gamma"
        }),
        CancelToken::new(),
    )
    .await
    .unwrap();
    let grep = file
        .execute(
            serde_json::json!({
                "operation": "grep", "path": path, "pattern": "gamma"
            }),
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert!(grep["matches"].as_str().unwrap().contains(":2:gamma"));

    let bash = BashTool::new(Some(dir.path().to_path_buf()));
    let result = bash
        .execute(serde_json::json!({"command": "pwd"}), CancelToken::new())
        .await
        .unwrap();
    assert!(
        result["output"]
            .as_str()
            .unwrap()
            .contains(dir.path().to_str().unwrap())
    );
}

#[tokio::test]
async fn bash_output_is_truncated_at_five_hundred_lines() {
    let bash = BashTool::new(None);
    let result = bash
        .execute(
            serde_json::json!({
                "command": "i=1; while [ $i -le 501 ]; do echo $i; i=$((i+1)); done"
            }),
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["truncated"], true);
    let lines = result["output"].as_str().unwrap().lines().count();
    assert!(lines <= 501, "bounded output unexpectedly large: {lines}");
    assert!(
        result["output"]
            .as_str()
            .unwrap()
            .contains("output truncated")
    );
}
