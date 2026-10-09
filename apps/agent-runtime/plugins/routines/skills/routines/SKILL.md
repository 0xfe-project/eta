---
name: routines
description: AXP routines, agents that run on a schedule and leave a report. Use when the user wants something done regularly ("every morning, ..."), asks about a routine or its reports, or wants one changed or paused.
---

# Routines

A routine runs on its schedule (daily, weekly, every few hours, or cron, in
a time zone), does what its brief says with its own tools (web search among
them) and leaves a report the user reads in AXP's 定时 tab. Each run starts
fresh; it sees its earlier reports and the user's feedback on them, and a
handoff note from the run before.

- `list_routines` and `get_routine` show what exists: schedules, briefs,
  recent runs and their reports. `get_run` reads one report.
- `create_routine` when the user asks for something done regularly. Write
  the brief as a complete instruction in the user's words and language: no
  one is there to answer questions when it runs. Ask for the time and time
  zone if they are not clear. The model defaults to the one the user's
  latest routine uses.
- `update_routine` changes only what you pass; a new brief becomes a new
  version, and the user can restore older ones. `enabled: false` pauses it.
- `run_routine` runs it now, to try a new brief.
- Tell the user what you set up: its name, when it runs, and that its
  reports show up in the 定时 tab.
