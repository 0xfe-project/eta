# Third-party notices

eta's own code is under the [MIT License](LICENSE). The components below are not: each stays under
its own license, and the MIT License does not change or replace those terms.

A compiled host also carries the full list of npm packages in its build, with their license texts. A
running host serves it at `/THIRD_PARTY_NOTICES.md`; `apps/eta/scripts/notices.ts` writes it.

## Eta Sans (font)

`apps/web/public/AKRDWGSCNFM-Regular.woff2`, declared as "Eta Sans" in `apps/web/index.html`. It is in
the web build and in every compiled host. It is **not** covered by eta's MIT License.

The file is a merge of two fonts, named "AKR DWG SC NFM" inside it:

| Source                                                                                                                                                      | Copyright                                                    | License                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| CaskaydiaCove Nerd Font Mono: [Cascadia Code](https://github.com/microsoft/cascadia-code), patched by [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) | Microsoft Corporation; the icon sets belong to their authors | [SIL Open Font License 1.1](https://openfontlicense.org); Nerd Fonts' icon sets have their own licenses |
| [Alibaba PuHuiTi 3.0](https://fonts.alibabagroup.com)                                                                                                       | Alibaba Group                                                | Alibaba's own terms for the font, not an open source license                                            |

The license text inside the file came along with the merge and does not describe it. The merged file
is not a release of either source. If you redistribute it, check both sets of terms first.

## Programs in a compiled host

`eta-host`, `eta-daemon` and the desktop app are compiled with Bun, and `eta-host` embeds the programs
below.

| Program                                                     | License           | Where it is                                                                               |
| ----------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| [Bun](https://github.com/oven-sh/bun)                       | MIT               | The runtime of every compiled file. Statically links JavaScriptCore and WebKit, see below |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | MIT               | Embedded in `eta-host`, run as a child process (`@cpajs/*`)                               |
| [SearXNG](https://github.com/searxng/searxng)               | AGPL-3.0-or-later | Embedded in `eta-host`, run as a child process (`@searxng-js/*`), see below               |
| [Electrobun](https://github.com/blackboardsh/electrobun)    | MIT               | The desktop app's shell                                                                   |

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

`packages/TOBEREFR` is not part of any build. It keeps its own notices:

- `packages/TOBEREFR/eta-mcp/NOTICE`: code adapted from pi-mcp-adapter and opencode, MIT.
- `packages/TOBEREFR/eta-plugin-akhook/presets/omp/LICENSE`: MIT.
