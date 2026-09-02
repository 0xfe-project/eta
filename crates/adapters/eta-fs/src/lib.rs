#![doc = include_str!("../README.md")]

mod paths;
mod scan;
mod watch;

pub use paths::{
    EtaPaths, agent_db, agents_dir, eta_home, mcp_json, persona_dir, session_db, sessions_dir,
    skills_dir,
};
pub use scan::{ResourceScanner, scan_eta_dirs, scan_skill_dirs};
pub use watch::{FsWatcher, WatchEvent};
