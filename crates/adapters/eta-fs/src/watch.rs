//! A `notify`-based filesystem watcher. Emits a coarse `WatchEvent` per change
//! (path + kind) on a channel; the adapter layer rescan-on-change + debounces.

use std::path::PathBuf;
use std::sync::mpsc;

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// What kind of filesystem change triggered a watch event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WatchEvent {
    /// A file/dir appeared or changed.
    Changed(PathBuf),
    /// A file/dir was removed.
    Removed(PathBuf),
}

/// A live watcher over a set of paths. Drop it to stop watching.
pub struct FsWatcher {
    _watcher: RecommendedWatcher,
}

impl FsWatcher {
    /// Watch `paths` recursively. Returns a watcher plus its event receiver.
    /// Keep the watcher alive to keep watching; drop it to stop.
    pub fn watch(paths: &[PathBuf]) -> notify::Result<(FsWatcher, mpsc::Receiver<WatchEvent>)> {
        let (tx, rx) = mpsc::channel();
        let mut watcher = RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                let Ok(event) = res else {
                    return;
                };
                let kind: Vec<WatchEvent> = match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) => {
                        event.paths.into_iter().map(WatchEvent::Changed).collect()
                    }
                    EventKind::Remove(_) => {
                        event.paths.into_iter().map(WatchEvent::Removed).collect()
                    }
                    _ => vec![],
                };
                for ev in kind {
                    let _ = tx.send(ev);
                }
            },
            Config::default(),
        )?;
        for p in paths {
            watcher.watch(p, RecursiveMode::Recursive)?;
        }
        Ok((FsWatcher { _watcher: watcher }, rx))
    }
}
