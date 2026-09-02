//! Resource discovery for `.agents/skills` and `.eta` directories.
//!
//! Discovery is deliberately kept in the adapter layer: the core engine only
//! receives already-loaded resources and never makes path assumptions.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Filesystem resource scanner.  Roots are ordered from lowest to highest
/// precedence, so later roots replace an earlier skill with the same name.
#[derive(Clone, Debug)]
pub struct ResourceScanner {
    start: PathBuf,
}

impl ResourceScanner {
    pub fn new(start: impl Into<PathBuf>) -> Self {
        Self {
            start: start.into(),
        }
    }

    /// Ordered skill roots: ancestors, global, git root, then submodules.
    pub fn skill_roots(&self) -> Vec<PathBuf> {
        let mut roots = ancestor_dirs(&self.start)
            .into_iter()
            .map(|p| p.join(".agents/skills"))
            .collect::<Vec<_>>();
        if let Some(global) = dirs::home_dir() {
            roots.push(global.join(".agents/skills"));
        }
        if let Some(git_root) = git_root(&self.start) {
            roots.push(git_root.join(".agents/skills"));
            roots.extend(submodule_roots(&git_root, ".agents/skills"));
        }
        roots
    }

    /// Ordered `.eta` roots using the same precedence rules as skills.
    pub fn eta_roots(&self) -> Vec<PathBuf> {
        let mut roots = ancestor_dirs(&self.start)
            .into_iter()
            .map(|p| p.join(".eta"))
            .collect::<Vec<_>>();
        if let Some(global) = dirs::home_dir() {
            roots.push(global.join(".eta"));
        }
        if let Some(git_root) = git_root(&self.start) {
            roots.push(git_root.join(".eta"));
            roots.extend(submodule_roots(&git_root, ".eta"));
        }
        roots
    }

    /// Find skill files and merge by directory name.  A later root shadows an
    /// earlier one, matching the documented project/global override rule.
    pub fn skills(&self) -> BTreeMap<String, PathBuf> {
        let mut merged = BTreeMap::new();
        for root in self.skill_roots() {
            let Ok(entries) = fs::read_dir(root) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let skill_file = path.join("SKILL.md");
                if skill_file.is_file() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        merged.insert(name.to_owned(), skill_file);
                    }
                }
            }
        }
        merged
    }

    /// Paths that should be watched for hot reloads.
    pub fn watch_paths(&self) -> Vec<PathBuf> {
        self.skill_roots()
            .into_iter()
            .chain(self.eta_roots())
            .collect()
    }
}

pub fn scan_skill_dirs(start: impl AsRef<Path>) -> Vec<PathBuf> {
    ResourceScanner::new(start.as_ref().to_path_buf()).skill_roots()
}

pub fn scan_eta_dirs(start: impl AsRef<Path>) -> Vec<PathBuf> {
    ResourceScanner::new(start.as_ref().to_path_buf()).eta_roots()
}

fn ancestor_dirs(start: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut current = if start.is_file() {
        start.parent().unwrap_or(start)
    } else {
        start
    };
    loop {
        out.push(current.to_path_buf());
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    out.reverse();
    out
}

fn git_root(start: &Path) -> Option<PathBuf> {
    ancestor_dirs(start)
        .into_iter()
        .rev()
        .find(|p| p.join(".git").exists())
}

fn submodule_roots(root: &Path, suffix: &str) -> Vec<PathBuf> {
    let file = root.join(".gitmodules");
    let Ok(text) = fs::read_to_string(file) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            line.strip_prefix("\tpath = ")
                .or_else(|| line.strip_prefix("path = "))
        })
        .map(|path| root.join(path.trim()).join(suffix))
        .collect()
}
