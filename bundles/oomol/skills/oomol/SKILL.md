---
name: oomol
description: Use the apps connected in OOMOL (email, calendar, drive, chat, notes, issue trackers, CRM) and OOMOL's hosted capabilities (OCR, translation, transcription, text to speech, image generation) through the oo CLI. Use when the user asks for something in one of their connected accounts, or for one of those hosted capabilities.
---

# OOMOL

The `oomol__oo` tool runs the `oo` CLI with the OOMOL key the user set in eta's settings →
Bundles → oomol. It takes `args`, the list of arguments, and no shell is involved.

- Start with `oo --help` (`args: ["--help"]`) and `oo <command> --help`; do not guess a
  command or a flag.
- Say what you are about to do to the user's accounts before you change something there
  (send a mail, create an event), and report what the CLI answered.
- Files go through paths in the workspace; give `oo` paths, not contents.

If the tool is missing, the key or team name is not set, or `oo` is not installed on this
machine: read [references/setup.md](references/setup.md) and walk the user through it.
