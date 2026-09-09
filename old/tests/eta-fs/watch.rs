//! Hot-reload watcher: a file change emits an event on the channel.

use std::time::Duration;

use eta_fs::{FsWatcher, WatchEvent};

#[test]
fn watch_emits_on_file_create() {
    let dir = tempfile::tempdir().unwrap();
    let (_watcher, rx) = FsWatcher::watch(&[dir.path().to_path_buf()]).unwrap();

    // Allow the watcher to register before touching the tree.
    std::thread::sleep(Duration::from_millis(200));
    std::fs::write(dir.path().join("hello.txt"), "hi").unwrap();

    let ev = rx
        .recv_timeout(Duration::from_secs(3))
        .expect("should observe a change");
    match ev {
        WatchEvent::Changed(p) => assert!(p.ends_with("hello.txt")),
        other => panic!("expected Changed, got {other:?}"),
    }
}

#[test]
fn watch_emits_on_remove() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("bye.txt");
    std::fs::write(&f, "x").unwrap();
    let (_watcher, rx) = FsWatcher::watch(&[dir.path().to_path_buf()]).unwrap();

    std::thread::sleep(Duration::from_millis(200));
    std::fs::remove_file(&f).unwrap();

    let ev = rx
        .recv_timeout(Duration::from_secs(3))
        .expect("should observe a removal");
    // macOS FSEvents may report a deletion as a modification; accept either.
    match ev {
        WatchEvent::Changed(p) | WatchEvent::Removed(p) => assert!(p.ends_with("bye.txt")),
    }
}
