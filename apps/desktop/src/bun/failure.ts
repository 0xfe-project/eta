/**
 * The page the window shows when there is no host to show it.
 *
 * A string, not a file under `src/mainview`: `build.copy` does not land files in the dev bundle
 * (see host.ts), and a page that explains a failure has to exist exactly then — when the build or
 * the checkout is what is broken. `BrowserWindow`'s `html` option puts it in the window with no
 * server behind it.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function failurePage(reason: string): string {
  return `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <title>eta</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        height: 100vh;
        display: grid;
        place-items: center;
        font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
        background: #f4f4f5;
        color: #3f3f46;
      }
      @media (prefers-color-scheme: dark) {
        body { background: #18181b; color: #d4d4d8; }
      }
      main { max-width: 46rem; padding: 2rem; }
      h1 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
      p { margin: 0 0 8px; }
      p.reason {
        font-family: ui-monospace, monospace;
        font-size: 12px;
        white-space: pre-wrap;
        word-break: break-word;
        border-left: 2px solid currentColor;
        padding-left: 10px;
        opacity: 0.85;
      }
      p.hint { opacity: 0.75; }
    </style>
  </head>
  <body>
    <main>
      <h1>eta 没能启动 host</h1>
      <p class="reason">${escapeHtml(reason)}</p>
      <p class="hint">窗口先开着了，页面在 host 起来之前不会出现。修好后退出应用重开。</p>
    </main>
  </body>
</html>
`;
}
