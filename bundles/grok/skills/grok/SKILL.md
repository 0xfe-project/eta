---
name: grok
description: Generate or edit images and videos with Grok Imagine, and search the web or X with Grok. Use when the user asks for a picture, illustration, logo, photo edit or video clip, or for current information from the web or posts on X.
---

# Grok

The `grok__*` tools call xAI through the LLM gateway, with the Grok account connected in eta's
settings → Model services (subscriptions). When no Grok account is connected they fail; tell
the user to connect one there.

- `image_generate`: generate an image from a prompt, or edit images by passing them as
  `image` / `images`. Save results into the workspace with `out` (one file) or `out_dir`
  (several), and tell the user where they are.
- `video_generate`: generate a clip from a prompt or animate an image. Set `download` to a
  workspace path to wait for it and save it; otherwise poll with `video_task_get` and save
  with `video_download`.
- `search_query`: search the web; `search_x`: search posts on X. Prefer them for recent
  events and anything you cannot know from training.

Relative paths are relative to the workspace.

If the tools are missing, `grok-api` is not installed on this machine: read
[references/setup.md](references/setup.md) and walk the user through it.
