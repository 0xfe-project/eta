---
name: artifacts
description: Publishing a static web page or small site (a report, a chart, a prototype, a demo) for the user to open in AXP and share. Use when the result is best seen as a page rather than read as text.
---

# Artifacts

An artifact is a static site the user opens from a card in this chat (and on
a task, when you give one): a preview in AXP, a new window, a download, and a
public link if they choose to share it. Each publish is a new version; older
versions and their links stay as they were.

1. Build the site in a directory of its own: `index.html` at its root, with
   its CSS, JS, images and data beside it, linked by relative paths
   (`./app.js`, `img/chart.png`). It may be interactive.
2. `publish_artifact` with that directory (or a `.zip` whose root holds
   `index.html`) and a short title. Add `task` when it is for a task. To
   update it, publish again with `artifact` set to the id it returned.
3. Tell the user what it shows; the card is already in the chat. Sharing is
   theirs to do.

The page runs sandboxed on AXP's address: no cookies, storage or AXP API,
and no login. It may load scripts, fonts and data from public CDNs and
APIs that allow cross-origin requests, but anything bundled with it is more
reliable. Never put secrets in it: a shared page is public.

Limits: 90 MiB zipped, 5000 files, 512 MiB unzipped; no symlinks.
