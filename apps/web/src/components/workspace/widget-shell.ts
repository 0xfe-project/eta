/**
 * The page a widget is drawn in: a sandboxed frame (scripts, no origin of its own) whose document
 * is this shell, fixed for the frame's life. What the agent wrote arrives by message and is
 * morphed into `#root`, so a frame that streams never reloads.
 *
 * The shell holds what the guidelines promise (`apps/eta/src/widget/guidelines.ts`): the colour
 * variables (filled from the app's own theme by message), the SVG classes, the fade new elements
 * come in with, `sendPrompt` (which only fills the message box), and a policy that lets scripts load only from the two CDNs and
 * nothing at all leave the frame.
 */
import morphdom from "morphdom/dist/morphdom-umd.min.js?raw";

/** Messages in both directions carry this, so the page can tell them from anyone else's. */
export const WIDGET_MESSAGE = "eta-widget";

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join("; ");

// Series and node colours are the one place a widget has hues: data needs telling apart, and the
// app's own chart colours are greys. Each theme gets a set that reads on its background.
const STYLE = `
*{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{color:var(--color-text-primary);font:14px/1.5 var(--font-sans);overflow:auto hidden}
#root{padding:2px 0}
:root{
  --border-radius-md:0;--border-radius-lg:0;--border-radius-xl:0;
  --color-text-tertiary:color-mix(in oklab,var(--color-text-secondary) 70%,var(--color-background-primary));
  --color-border-secondary:color-mix(in oklab,var(--color-border-primary) 60%,var(--color-text-secondary));
  --color-background-info:color-mix(in oklab,var(--color-text-info) 14%,transparent);
  --color-background-success:color-mix(in oklab,var(--color-text-success) 14%,transparent);
  --color-background-warning:color-mix(in oklab,var(--color-text-warning) 14%,transparent);
  --color-background-danger:color-mix(in oklab,var(--color-text-danger) 14%,transparent);
  --color-series-1:#2f6fdf;--color-series-2:#159a7a;--color-series-3:#d98a10;
  --color-series-4:#d2453b;--color-series-5:#7a5bd6;--color-series-6:#6b7280;
}
:root[data-theme=dark]{
  --color-series-1:#6ea2ff;--color-series-2:#3cc9a4;--color-series-3:#f0b143;
  --color-series-4:#f0776d;--color-series-5:#a891f5;--color-series-6:#9ca3af;
}
h1,h2,h3,h4{margin:0 0 8px;font-weight:500;line-height:1.3}
h1{font-size:20px}h2{font-size:16px}h3,h4{font-size:14px}
p{margin:0 0 8px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:4px 8px;text-align:left;border-bottom:1px solid var(--color-border-tertiary)}
th{font-weight:500;color:var(--color-text-secondary)}
button,select,input{font:inherit;color:inherit}
button{background:transparent;border:1px solid var(--color-border-secondary);padding:4px 10px;cursor:pointer}
button:hover{background:var(--color-background-secondary)}
input[type=range]{accent-color:var(--color-text-primary)}
svg .t{font:14px var(--font-sans);fill:var(--color-text-primary)}
svg .ts{font:12px var(--font-sans);fill:var(--color-text-secondary)}
svg .th{font:500 14px var(--font-sans);fill:var(--color-text-primary)}
svg .box{fill:var(--color-background-secondary);stroke:var(--color-border-secondary)}
svg .arr{stroke:var(--color-text-tertiary);stroke-width:1.5;fill:none}
svg .leader{stroke:var(--color-text-tertiary);stroke-width:.5;stroke-dasharray:4 3;fill:none}
${["blue:1", "teal:2", "amber:3", "red:4", "purple:5", "gray:6"]
  .map((pair) => {
    const [name, n] = pair.split(":");
    const c = `var(--color-series-${n})`;
    return `svg .c-${name}>rect,svg .c-${name}>circle,svg .c-${name}>ellipse,svg rect.c-${name},svg circle.c-${name}{fill:color-mix(in oklab,${c} 16%,var(--color-background-primary));stroke:${c};stroke-width:1}
svg .c-${name}>.t,svg .c-${name}>.th,svg .c-${name}>.ts{fill:color-mix(in oklab,${c} 70%,var(--color-text-primary))}`;
  })
  .join("\n")}
@keyframes eta-widget-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

// Runs in the frame. `content` morphs #root to the code so far: elements that stay are left alone,
// new ones fade in, and scripts (inert while streaming) run once, in order, on the final message.
const RUNTIME = `(() => {
  const TYPE = ${JSON.stringify(WIDGET_MESSAGE)};
  const root = document.getElementById("root");
  const post = (message) => parent.postMessage({ type: TYPE, ...message }, "*");
  let ran = false;
  function apply(html) {
    const next = root.cloneNode(false);
    next.innerHTML = html;
    morphdom(root, next, {
      onBeforeElUpdated: (from, to) => !from.isEqualNode(to),
      onNodeAdded(node) {
        if (node.nodeType === 1 && node.tagName !== "STYLE" && node.tagName !== "SCRIPT")
          node.style.animation = "eta-widget-in .3s ease both";
        return node;
      },
    });
  }
  async function run() {
    if (ran) return;
    ran = true;
    for (const old of [...root.querySelectorAll("script")]) {
      const script = document.createElement("script");
      for (const attr of old.attributes) script.setAttribute(attr.name, attr.value);
      if (old.src) {
        const loaded = new Promise((resolve) => {
          script.addEventListener("load", resolve, { once: true });
          script.addEventListener("error", resolve, { once: true });
        });
        old.replaceWith(script);
        await loaded;
      } else {
        script.textContent = old.textContent;
        old.replaceWith(script);
      }
    }
  }
  // Fills the message box; the user sends it. A widget never speaks for the user.
  window.sendPrompt = (text) => post({ kind: "draft", text: String(text) });
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.type !== TYPE) return;
    const message = event.data;
    if (message.kind === "theme") {
      const style = document.documentElement.style;
      for (const [name, value] of Object.entries(message.vars)) style.setProperty(name, value);
      // Without it a dark page shows the frame on a white canvas.
      style.colorScheme = message.theme;
      document.documentElement.dataset.theme = message.theme;
    } else if (message.kind === "content") {
      apply(message.html);
      if (message.final) run();
    } else if (message.kind === "font") {
      // The app's face arrives as bytes: the frame may load no font, and a widget drawn in a
      // system face would be a second typeface in the product.
      new FontFace(message.family, message.data)
        .load()
        .then((face) => document.fonts.add(face))
        .catch((error) => console.error("eta widget: font", error));
    }
  });
  new ResizeObserver(() =>
    post({ kind: "height", height: Math.ceil(root.getBoundingClientRect().height) }),
  ).observe(root);
  post({ kind: "ready" });
})();`;

export const WIDGET_SHELL = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${STYLE}</style></head><body><div id="root"></div>
<script>${morphdom}</script><script>${RUNTIME}</script></body></html>`;

/** The one face the app ships (declared in index.html), as `--font-sans` names it. */
export const APP_FONT = {
  family: "Eta Sans",
  url: "AKRDWGSCNFM-Regular.woff2",
} as const;

let appFont: Promise<ArrayBuffer> | undefined;

/**
 * The app's face, read once for every widget: the page has fetched it already, so this comes from
 * the browser's cache.
 */
export function appFontData(): Promise<ArrayBuffer> {
  appFont ??= fetch(new URL(APP_FONT.url, document.baseURI)).then(
    (response) => {
      if (!response.ok) throw new Error(`font: HTTP ${response.status}`);
      return response.arrayBuffer();
    },
  );
  return appFont;
}

/** The app's theme as the shell's variables: read from the page, so the frame matches it. */
export function widgetTheme(): {
  theme: "light" | "dark";
  vars: Record<string, string>;
} {
  const css = getComputedStyle(document.documentElement);
  const value = (name: string) => css.getPropertyValue(name).trim();
  return {
    theme: document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
    vars: {
      "--color-text-primary": value("--foreground"),
      "--color-text-secondary": value("--muted-foreground"),
      "--color-background-primary": value("--background"),
      "--color-background-secondary": value("--muted"),
      "--color-border-primary": value("--border-strong"),
      "--color-border-tertiary": value("--border"),
      "--color-text-info": value("--state-info"),
      "--color-text-success": value("--state-success"),
      "--color-text-warning": value("--state-warning"),
      "--color-text-danger": value("--state-error"),
      "--font-sans": value("--font-sans"),
      "--font-mono": value("--font-mono"),
    },
  };
}
