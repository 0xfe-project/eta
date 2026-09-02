//! Path layout resolution.

use eta_fs::{EtaPaths, agent_db, eta_home, mcp_json, session_db};

/// Serialize env mutation across tests (edition 2024 marks `set_var` unsafe).
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn layout_uses_eta_home_override() {
    let _g = LOCK.lock().unwrap();
    unsafe { std::env::set_var("ETA_HOME", "/tmp/eta-test-home") };
    assert_eq!(eta_home(), std::path::PathBuf::from("/tmp/eta-test-home"));
    assert_eq!(
        session_db("abc"),
        std::path::PathBuf::from("/tmp/eta-test-home/sessions/abc.sqlite")
    );
    assert_eq!(
        agent_db("bob"),
        std::path::PathBuf::from("/tmp/eta-test-home/agents/bob.sqlite")
    );
    assert_eq!(
        mcp_json(),
        std::path::PathBuf::from("/tmp/eta-test-home/mcp.json")
    );
}

#[test]
fn eta_paths_struct_resolves_consistently() {
    let _g = LOCK.lock().unwrap();
    unsafe { std::env::set_var("ETA_HOME", "/tmp/eta-test-home2") };
    let p = EtaPaths::default();
    assert_eq!(p.home, std::path::PathBuf::from("/tmp/eta-test-home2"));
    assert_eq!(
        p.session_db("s1"),
        std::path::PathBuf::from("/tmp/eta-test-home2/sessions/s1.sqlite")
    );
    assert_eq!(
        p.agent_db("a1"),
        std::path::PathBuf::from("/tmp/eta-test-home2/agents/a1.sqlite")
    );
}
