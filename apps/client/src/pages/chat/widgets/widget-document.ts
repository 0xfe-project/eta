const scriptSources =
  "'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/";
const policy = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "style-src 'unsafe-inline'",
  `script-src ${scriptSources}`,
];

const style = `
*{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{color:var(--color-text-primary);font:14px/1.5 var(--font-sans)}
#root{display:flow-root;padding:2px 0;overflow-wrap:anywhere}
:root{
  --font-sans:system-ui,sans-serif;--font-mono:ui-monospace,monospace;
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
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

// The port is handed over before any widget code is drawn. Keeping it in the shell’s
// closure prevents the widget from sending its own bridge messages.
const widgetRuntime = `(() => {
  const root = document.querySelector("#root");
  let connected = false;
  addEventListener("message", function connect(event) {
    if (connected || !event.isTrusted || event.source !== parent ||
        event.data !== "eta-widget:connect" || !event.ports[0]) return;
    connected = true;
    removeEventListener("message", connect);
    const port = event.ports[0];
    const send = port.postMessage.bind(port);
    let finished = false;
    let mayDraft = false;
    let draftTimer;
    addEventListener("click", (event) => {
      if (!finished || !event.isTrusted) return;
      mayDraft = true;
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => { mayDraft = false; }, 0);
    }, true);
    Object.defineProperty(window, "sendPrompt", { value(text) {
      if (!mayDraft || typeof text !== "string" || text.length > 8192) return;
      mayDraft = false;
      send({ kind: "draft", text });
    } });

    // The stream updates DOM nodes in place. Controls are inert and code runs only when
    // the tool has finished. The final document contains real nodes for keyboard users.
    const reduceMotion = matchMedia("(prefers-reduced-motion:reduce)");
    function patch(parent, fragment) {
      const children = [...fragment.childNodes];
      children.forEach((node, index) => {
        const previous = parent.childNodes[index];
        if (!previous) parent.append(node);
        else if (node.isEqualNode(previous)) return;
        else if (node.nodeType === 1 && previous.nodeName === node.nodeName &&
                 previous.namespaceURI === node.namespaceURI) {
          for (const attr of [...previous.attributes])
            if (!node.hasAttribute(attr.name)) previous.removeAttribute(attr.name);
          for (const attr of node.attributes) {
            if (previous.getAttribute(attr.name) === attr.value) continue;
            if (attr.namespaceURI) previous.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
            else previous.setAttribute(attr.name, attr.value);
          }
          patch(previous, node);
          return;
        } else previous.replaceWith(node);
        if (!reduceMotion.matches && node.nodeType === 1 && node.tagName !== "STYLE")
          node.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
      });
      while (parent.childNodes.length > children.length) parent.lastChild.remove();
    }
    async function run(scripts) {
      for (const [source, placeholder] of scripts) {
        const script = document.createElement("script");
        for (const name of ["type", "crossorigin", "integrity"])
          if (source.hasAttribute(name)) script.setAttribute(name, source.getAttribute(name));
        if (source.hasAttribute("src")) {
          script.src = source.getAttribute("src");
          script.referrerPolicy = "no-referrer";
        } else script.textContent = source.textContent;
        const loaded = script.hasAttribute("src") || script.type === "module"
          ? new Promise((resolve) => {
              script.addEventListener("load", resolve, { once: true });
              script.addEventListener("error", resolve, { once: true });
            }) : undefined;
        placeholder.replaceWith(script);
        if (loaded) await loaded;
      }
    }
    port.onmessage = ({ data }) => {
      if (data.kind === "font" && typeof data.family === "string" &&
          typeof data.data === "string") {
        // The app's faces arrive as bytes, one message a weight: the frame loads fonts from data: only.
        const family = data.family.replace(/^(["'])(.*)\\1$/, "$2");
        const bytes = Uint8Array.from(atob(data.data), (char) => char.charCodeAt(0));
        const weight = typeof data.weight === "number" ? String(data.weight) : "400";
        new FontFace(family, bytes, { weight }).load()
          .then((face) => document.fonts.add(face))
          .catch((error) => console.error("eta widget: font", error));
      } else if (data.kind === "theme") {
        const element = document.documentElement;
        for (const [name, value] of Object.entries(data.colors))
          element.style.setProperty(name, value);
        element.style.colorScheme = data.mode;
        element.dataset.theme = data.mode;
      } else if (data.kind === "content" && !finished) {
        const template = document.createElement("template");
        template.innerHTML = data.html;
        const content = template.content;
        for (const entry of content.querySelectorAll("base, meta, frame, iframe, object, embed, link"))
          entry.remove();
        const scripts = [];
        for (const source of content.querySelectorAll("script")) {
          const placeholder = document.createComment("widget script");
          source.replaceWith(placeholder);
          scripts.push([source, placeholder]);
        }
        if (data.final) {
          finished = true;
          root.replaceChildren(content);
          root.inert = false;
          void run(scripts);
        } else {
          for (const entry of content.querySelectorAll("*"))
            for (const attr of [...entry.attributes])
              if (attr.name.startsWith("on")) entry.removeAttribute(attr.name);
          patch(root, content);
        }
      }
    };
    new ResizeObserver(() => {
      send({ kind: "height", height: root.childNodes.length ? Math.ceil(root.getBoundingClientRect().height) : 0 });
    }).observe(root);
    send({ kind: "ready" });
  });
  parent.postMessage("eta-widget:ready", "*");
})();`;

const widgetPage = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${[...policy, "img-src data: blob:", "font-src data:"].join("; ")}">
<style>${style}</style><div id="root" inert></div><script>${widgetRuntime}</script>`;

export function widgetDocument(token: string) {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${[...policy, "img-src data: blob:", "font-src data:", "frame-src about:"].join("; ")}">
<style>html,body,iframe{display:block;margin:0;border:0;width:100%;height:100%;background:transparent}html{overflow:hidden}</style>
<iframe title="Interactive widget" sandbox="allow-scripts" referrerpolicy="no-referrer"
  allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'"></iframe>
<script>(() => {
  const token = ${JSON.stringify(token)};
  const frame = document.querySelector("iframe");
  let port;
  addEventListener("message", (event) => {
    if (event.source === frame.contentWindow) {
      if (port || event.data !== "eta-widget:ready") return;
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = ({ data }) => window.nsh.postMessage(JSON.stringify({ ...data, token }));
      frame.contentWindow.postMessage("eta-widget:connect", "*", [channel.port2]);
      return;
    }
    if (!port || typeof event.data !== "string") return;
    let envelope;
    try { envelope = JSON.parse(event.data); } catch { return; }
    if (envelope?.token === token) port.postMessage(envelope.message);
  });
  frame.srcdoc = ${JSON.stringify(widgetPage).replaceAll("<", "\\u003c")};
})()</script>`;
}
