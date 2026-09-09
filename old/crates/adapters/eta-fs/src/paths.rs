//! Filesystem layout for eta's resources. Pure path arithmetic — no IO.

use std::path::PathBuf;

/// Resolve the eta home directory.
///
/// Precedence: `$ETA_HOME` (override, used by tests) → `$HOME/.eta`.
pub fn eta_home() -> PathBuf {
    if let Some(h) = std::env::var_os("ETA_HOME") {
        return PathBuf::from(h);
    }
    dirs::home_dir()
        .map(|h| h.join(".eta"))
        .unwrap_or_else(|| PathBuf::from(".eta"))
}

/// `~/.eta/sessions/` — one `<uuid>.sqlite` per session.
pub fn sessions_dir() -> PathBuf {
    eta_home().join("sessions")
}

/// `~/.eta/agents/` — one `<NAME>.sqlite` per agent.
pub fn agents_dir() -> PathBuf {
    eta_home().join("agents")
}

/// `~/.eta/persona/` — `*.persona.md` persona cards.
pub fn persona_dir() -> PathBuf {
    eta_home().join("persona")
}

/// `~/.eta/skills/` — skills scanned with the same rules as `.agents/skills`.
pub fn skills_dir() -> PathBuf {
    eta_home().join("skills")
}

/// `~/.eta/mcp.json` — user-registered MCP servers.
pub fn mcp_json() -> PathBuf {
    eta_home().join("mcp.json")
}

/// The sqlite file for one session: `~/.eta/sessions/<id>.sqlite`.
pub fn session_db(id: &str) -> PathBuf {
    sessions_dir().join(format!("{id}.sqlite"))
}

/// The sqlite file for one agent: `~/.eta/agents/<name>.sqlite`.
pub fn agent_db(name: &str) -> PathBuf {
    agents_dir().join(format!("{name}.sqlite"))
}

/// All layout paths in one struct, for injecting a resolved layout into
/// adapters (resolved once at startup instead of recomputing env every call).
#[derive(Clone, Debug)]
pub struct EtaPaths {
    pub home: PathBuf,
    pub sessions: PathBuf,
    pub agents: PathBuf,
    pub persona: PathBuf,
    pub skills: PathBuf,
    pub mcp: PathBuf,
}

impl Default for EtaPaths {
    fn default() -> Self {
        Self {
            home: eta_home(),
            sessions: sessions_dir(),
            agents: agents_dir(),
            persona: persona_dir(),
            skills: skills_dir(),
            mcp: mcp_json(),
        }
    }
}

impl EtaPaths {
    pub fn session_db(&self, id: &str) -> PathBuf {
        self.sessions.join(format!("{id}.sqlite"))
    }

    pub fn agent_db(&self, name: &str) -> PathBuf {
        self.agents.join(format!("{name}.sqlite"))
    }
}
