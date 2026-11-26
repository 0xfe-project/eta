# Third-party notices

eta's own code is under the [MIT License](LICENSE). The components below are not: each stays under
its own license, and the MIT License does not change or replace those terms.

A compiled host also carries the full list of npm packages in its build, with their license texts. A
running host serves it at `/THIRD_PARTY_NOTICES.md`; `apps/eta/scripts/notices.ts` writes it.

## Eta Sans (font)

Three faces of one family, the default interface and monospace face of the client
(`apps/client/src/components/theme.ts`): `apps/client/assets/AKRDWGSCNFM-Light.woff2` (weight 300),
`apps/client/assets/AKRDWGSCNFM-Regular.woff2` (400) and `apps/client/assets/AKRDWGSCNFM-Bold.woff2` (700).
They are the WOFF2 files of the
[AKR DWG SC NFM 1.1.0 release](https://github.com/AkaraChen/font/releases/tag/v1.1.0), unchanged, and are in
the client builds (web, desktop, phone) and in every compiled host. They are **not** covered by eta's MIT
License. The release's own notes and the texts of both sources are next to them in `apps/client/assets/`
(`AKRDWGSCNFM-README.txt`, `AKRDWGSCNFM-OFL-CascadiaCode.txt`, `AKRDWGSCNFM-Alibaba-PuHuiTi.txt`); they cover
all three faces.

Each file is a merge of two fonts, named "AKR DWG SC NFM" inside it (the CJK of Light, Regular and Bold
comes from PuHuiTi Light, Regular and SemiBold):

| Source                                                                                                                                                      | Copyright                                                    | License                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| CaskaydiaCove Nerd Font Mono: [Cascadia Code](https://github.com/microsoft/cascadia-code), patched by [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) | Microsoft Corporation; the icon sets belong to their authors | [SIL Open Font License 1.1](https://openfontlicense.org); Nerd Fonts' icon sets have their own licenses |
| [Alibaba PuHuiTi 3.0](https://fonts.alibabagroup.com)                                                                                                       | Alibaba Group                                                | Alibaba's own terms for the font, not an open source license                                            |

The license text inside each file came along with the merge and does not describe it. The merged files
are not a release of either source. If you redistribute them, check both sets of terms first.

## Inter (font)

`apps/client/assets/InterVariable.woff2`, the client's fallback interface face after Eta Sans:
[Inter](https://github.com/rsms/inter), © The Inter Project Authors, under the SIL Open Font License 1.1
(`apps/client/assets/Inter-OFL.txt`).

## Lobe Icons (runtime marks)

`apps/client/src/pages/settings/runtimes/logos.ts` holds the one-colour marks of the agent runtimes
(Claude Code, Codex, OpenCode, Pi, Gemini CLI and other external agents) from
[Lobe Icons](https://github.com/lobehub/lobe-icons) (`@lobehub/icons-static-svg` 1.104.0). They are in
the client builds (web, desktop, phone).

- Copyright (c) 2023 LobeHub, under the MIT License, not under eta's MIT License.
- The marks themselves are the trademarks of their owners.

## grokbot-field-notes (agent templates)

The client's agent templates (`apps/client/src/pages/templates/catalog.ts`) are the role cards of
[unicodef1wn/grokbot-field-notes](https://github.com/unicodef1wn/grokbot-field-notes) (`roster/`,
commit `02780c04ef5f412b28573bce6f82afd15d195d1f`): each card's name, category, summary,
the lists of what it owns, leaves alone and needs approval for, and its role description, with the
hand-wrapped lines joined. `apps/client/scripts/agent-templates.ts` writes the file from them.

Copyright (c) 2026 unicodef1wn, under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
> OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Programs in a compiled host

`eta-host`, `eta-daemon` and the desktop app are compiled with Bun, and `eta-host` embeds the programs
below.

| Program                                                     | License           | Where it is                                                                               |
| ----------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| [Bun](https://github.com/oven-sh/bun)                       | MIT               | The runtime of every compiled file. Statically links JavaScriptCore and WebKit, see below |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | MIT               | Embedded in `eta-host`, run as a child process (`@cpajs/*`)                               |
| [SearXNG](https://github.com/searxng/searxng)               | AGPL-3.0-or-later | Embedded in `eta-host`, run as a child process (`@searxng-js/*`), see below               |

### JavaScriptCore and WebKit

Bun statically links JavaScriptCore and WebKit, which are under the LGPL 2. The source Bun builds them
from, and how to relink, are at [oven-sh/WebKit](https://github.com/oven-sh/WebKit) and in
[Bun's license notes](https://bun.com/docs/project/license).

### SearXNG

SearXNG, with CPython and the Python packages it needs, is compiled with Nuitka into one executable
published as `@searxng-js/<platform>`. It runs as a separate program: eta starts it on first search
and talks to it over HTTP on loopback. The AGPL covers that program, and eta's MIT License covers eta's
own code.

Corresponding source: [searxng/searxng](https://github.com/searxng/searxng) and the build scripts in
[AkaraChen/searxng](https://github.com/AkaraChen/searxng). The exact commits are in the package's
`THIRD-PARTY-NOTICES.md`, which is reproduced in the list a compiled host serves. `--searxng-url`
points eta at a SearXNG of your own instead.

## Adapted code

### Gemini CLI (terminal rendering)

`apps/tui/src/ui/gemini/` holds markdown, code highlighting, table and diff rendering adapted from
[Gemini CLI](https://github.com/google-gemini/gemini-cli) (`packages/cli/src/ui/`, commit
`62bab5b`). It is in the TUI build and in every compiled `eta`.

- Copyright 2025 Google LLC, under the [Apache License 2.0](apps/tui/src/ui/gemini/LICENSE), not
  under eta's MIT License.
- Each adapted file keeps its original license header and says how it was changed for eta.

### pi-mcp-adapter and opencode (MCP)

`packages/eta-mcp` includes code adapted from
[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) and
[opencode](https://github.com/anomalyco/opencode), both MIT. The notice is in
`packages/eta-mcp/NOTICE`.

### TOBEREFR

`packages/TOBEREFR` is not part of any build. It keeps its own notices:

- `packages/TOBEREFR/eta-plugin-akhook/presets/omp/LICENSE`: MIT.
