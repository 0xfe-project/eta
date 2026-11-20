import { artifactResourceLoader } from "./pdf-resources";

const container = String.raw`
const frame = document.querySelector('iframe');
const parse = document.implementation.createHTMLDocument('Artifact');
const original = new DOMParser().parseFromString(job.html, 'text/html');
const root = parse.importNode(original.documentElement, true);
parse.replaceChild(root, parse.documentElement);

let base = job.url;
const originalBase = parse.querySelector('base[href]')?.getAttribute('href');
if (originalBase) {
  try {
    const candidate = new URL(originalBase, base);
    if (candidate.href.startsWith(job.resources)) base = candidate.href;
  } catch {}
}
parse.querySelectorAll('base, meta[http-equiv], iframe, frame, object, embed')
  .forEach(node => node.remove());
parse.querySelectorAll('link').forEach(link => {
  if (link.relList.contains('stylesheet')) link.crossOrigin = 'anonymous';
  else link.remove();
});
parse.querySelectorAll('script[src], img, video, audio').forEach(node => {
  node.crossOrigin = 'anonymous';
});

const policy = parse.createElement('meta');
policy.httpEquiv = 'Content-Security-Policy';
policy.content = "default-src 'none'; script-src 'unsafe-inline' data: " + job.resources +
  "; style-src 'unsafe-inline' data: " + job.resources +
  '; img-src data: blob: ' + job.resources + '; font-src data: ' + job.resources +
  '; media-src data: blob: ' + job.resources + '; connect-src ' + job.resources +
  "; frame-src about:; base-uri " + new URL(base).origin + "; form-action 'none'";
const referrer = parse.createElement('meta');
referrer.name = 'referrer';
referrer.content = 'no-referrer';
const baseNode = parse.createElement('base');
baseNode.href = base;
const capture = parse.createElement('script');
capture.textContent = job.capture;
parse.head.prepend(policy, referrer, baseNode, capture);

let wire, next = 0, renderRevision = 0;
const pending = new Map();
const opened = new Promise(resolve => {
  addEventListener('message', event => {
    if (wire || event.source !== frame.contentWindow || event.data !== 'eta-artifact-capture-init') return;
    const channel = new MessageChannel();
    wire = channel.port1;
    channel.port1.onmessage = ({data}) => {
      if (data?.ready) {
        resolve();
        return;
      }
      if (Number.isSafeInteger(data?.resourceId) && typeof data.url === 'string') {
        const url = offeredAsset(data.url, base);
        if (!url) wire.postMessage({resourceId:data.resourceId});
        else {
          void asset(url).then(({body,mime}) => wire.postMessage({resourceId:data.resourceId,body,mime}),
            () => wire.postMessage({resourceId:data.resourceId}));
        }
        return;
      }
      const request = pending.get(data?.id);
      if (!request) return;
      pending.delete(data.id);
      clearTimeout(request.timer);
      request.resolve(data);
    };
    frame.contentWindow.postMessage('eta-artifact-capture', '*', [channel.port2]);
  });
});
function loadFrame() {
  frame.src = 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html>' + root.outerHTML);
}

async function askPage(operation, index) {
  await opened;
  const id = ++next;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({id, problem:'timeout'});
    }, 20_000);
    pending.set(id, {resolve, timer});
    wire.postMessage({id, operation, index});
  });
}

async function runCapture(operation, index) {
  if (operation === 'prepare') {
    const revision = ++renderRevision;
    const saved = await askPage('scroll');
    if (saved.problem) return saved;
    if (revision !== renderRevision) return {problem:'cancelled'};
    frame.style.width = '730px';
    frame.style.height = '1059px';
  } else if (operation === 'restore') {
    renderRevision++;
    frame.style.width = '';
    frame.style.height = '';
  }
  return askPage(operation, index);
}

void opened.then(() => window.nsh.postMessage(JSON.stringify({bridge:job.bridge,ready:true})));
addEventListener('message', async event => {
  if (typeof event.data !== 'string' || event.data.length > 150_000) return;
  let request;
  try { request = JSON.parse(event.data); } catch { return; }
  if (request.bridge !== job.bridge) return;
  if (Number.isSafeInteger(request.assetId)) {
    resolveAsset(request);
    return;
  }
  if (event.data.length > 512 || !Number.isSafeInteger(request.id) ||
      !['prepare','render','restore'].includes(request.operation)) return;
  const {problem, result} = await runCapture(request.operation, request.index);
  window.nsh.postMessage(JSON.stringify({bridge:job.bridge,id:request.id,problem,result}));
});
void embedResources(parse, base).then(loadFrame, () => {
  window.nsh.postMessage(JSON.stringify({bridge:job.bridge, loadError:true}));
});
`;

const capturePage = String.raw`
(() => {
  const raster = window.html2canvas;
  const width = 730;
  const height = 1059;
  let port, slices = [], restore = [], scroll, originalScroll;
  let renderGeneration = 0;
  let nextResource = 0;
  const reads = new Map();
  let connected;
  const bridgeReady = new Promise(resolve => connected = resolve);
  let missingResources = false;
  const frame = () => new Promise(resolve => {
    // Native WebKit may pause animation frames during a sheet or a resize.
    const timeout = setTimeout(resolve, 75);
    requestAnimationFrame(() => { clearTimeout(timeout); resolve(); });
  });
  const limit = (promise, time) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, time))]);
  addEventListener('error', event => {
    if (event.target instanceof HTMLScriptElement ||
        event.target instanceof HTMLImageElement ||
        (event.target instanceof HTMLLinkElement && event.target.relList.contains('stylesheet')))
      missingResources = true;
  }, true);

  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    if (!link || (link.target && link.target !== '_self')) return;
    const fragment = link.getAttribute('href').slice(1);
    let id;
    try { id = decodeURIComponent(fragment); } catch { return; }
    event.preventDefault();
    if (!id) scrollTo(0, 0);
    else (document.getElementById(id) || document.getElementsByName(id)[0])?.scrollIntoView();
  });

  const localFetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    const method = options?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method.toUpperCase() !== 'GET' || options?.signal?.aborted) throw new TypeError('Artifact resources can only be read');
    const address = new URL(input instanceof Request ? input.url : input, document.baseURI);
    if (address.protocol === 'data:' || address.protocol === 'blob:') return localFetch(input, options);
    const current = new URL(document.baseURI);
    const version = /^\/preview\/[^/]+\/files\//.exec(current.pathname)?.[0];
    if (!version || address.origin !== current.origin || !address.pathname.startsWith(version))
      throw new TypeError('Artifact resource is outside this version');
    await bridgeReady;
    const resourceId = ++nextResource;
    const answer = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reads.delete(resourceId); reject(new TypeError('Artifact resource timed out')); }, 14_000);
      reads.set(resourceId, payload => {
        clearTimeout(timeout);
        if (!payload.mime) reject(new TypeError('Artifact resource could not be loaded'));
        else resolve(payload);
      });
      port.postMessage({resourceId,url:address.href});
    });
    return new Response(Uint8Array.from(atob(answer.body), character => character.charCodeAt(0)), {headers:{'Content-Type':answer.mime}});
  };

  function mediaForPrint(media, remember) {
    if (!media?.length) return;
    const before = media.mediaText;
    const print = Array.from(media, query => {
      if (/^(?:only\s+)?screen\b/i.test(query)) return 'not all';
      return query.replace(/^(?:only\s+)?print\b/i, 'all');
    }).join(', ');
    if (print !== before) {
      if (remember) restore.push(() => media.mediaText = before);
      media.mediaText = print;
    }
  }

  function printSheet(sheet, remember) {
    mediaForPrint(sheet.media, remember);
    printRules(sheet.cssRules, remember);
  }

  function printRules(rules, remember) {
    for (const rule of rules) {
      if (rule.type === CSSRule.IMPORT_RULE && rule.styleSheet) {
        try { printSheet(rule.styleSheet, remember); } catch {}
      }
      else if (rule.cssRules) {
        mediaForPrint(rule.media, remember);
        printRules(rule.cssRules, remember);
      }
    }
  }

  function applyPrintStyles(document, remember) {
    for (const sheet of document.styleSheets) {
      try { printSheet(sheet, remember); } catch {}
    }
  }

  function leavePrint() {
    renderGeneration++;
    slices = [];
    if (!scroll) return;
    for (const undo of restore.reverse()) undo();
    restore = [];
    dispatchEvent(new Event('afterprint'));
    scrollTo(scroll[0], scroll[1]);
    scroll = undefined;
  }

  function pageSlices() {
    const total = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const boundaries = [], protectedBlocks = [];
    for (const element of document.body.querySelectorAll('*')) {
      const {top, bottom, height: size} = element.getBoundingClientRect();
      if (size < 1) continue;
      const css = getComputedStyle(element);
      if (css.display === 'none' || css.position === 'fixed') continue;
      const forced = value => /^(?:page|always|left|right|recto|verso)$/.test(value);
      // Leave overhanging glyphs at the start of the new block together.
      if (forced(css.breakBefore)) boundaries.push(Math.floor(top) - 5);
      if (forced(css.breakAfter)) boundaries.push(Math.round(bottom));
      if (size <= height && (css.breakInside.startsWith('avoid') || /^(P|H[1-6]|LI|TR|IMG|CANVAS|SVG)$/.test(element.tagName)))
        protectedBlocks.push({top: Math.floor(top), bottom: Math.ceil(bottom)});
    }
    boundaries.sort((a, b) => a - b);
    let top = 0;
    const pages = [];
    while (top < total) {
      const desired = Math.min(top + height, total);
      const boundary = boundaries.find(point => point > top + 2 && point < desired);
      const split = boundary === undefined && protectedBlocks.find(block =>
        block.top > top + height / 2 && block.top < desired && block.bottom > desired);
      const end = boundary ?? (split ? split.top : desired);
      pages.push({top, height: end - top});
      if (pages.length > 60) throw new Error('too-many-pages');
      top = end;
    }
    return pages;
  }

  async function prepare() {
    leavePrint();
    const generation = renderGeneration;
    if (!document.body || typeof raster !== 'function') throw new Error('unavailable');
    scroll = originalScroll ?? [scrollX, scrollY];
    originalScroll = undefined;
    scrollTo(0, 0);
    dispatchEvent(new Event('beforeprint'));
    applyPrintStyles(document, true);
    document.images && Array.from(document.images, img => {
      if (img.loading === 'lazy') {
        restore.push(() => img.loading = 'lazy');
        img.loading = 'eager';
      }
    });
    await limit(Promise.all([document.fonts?.ready, ...Array.from(document.images, img => img.decode().catch(() => {}))]), 2500);
    if (missingResources) throw new Error('missing-resources');
    await frame();
    await frame();
    if (generation !== renderGeneration) throw new Error('capture cancelled');
    slices = pageSlices();
    return {pages: slices.length};
  }

  async function render(index) {
    const page = slices[index];
    if (!page) throw new Error('unavailable');
    const canvas = await raster(document.documentElement, {
      x: 0, y: page.top, width, height: page.height, windowWidth: width,
      windowHeight: height, scrollX: 0, scrollY: 0, scale: 1.5,
      backgroundColor: '#ffffff', useCORS: true, imageTimeout: 5000, logging: false,
      onclone: copy => applyPrintStyles(copy, false),
    });
    const result = {height: canvas.height, width: canvas.width, jpeg: canvas.toDataURL('image/jpeg', 0.88).slice(23)};
    canvas.width = canvas.height = 0;
    return result;
  }

  addEventListener('message', event => {
    if (port || event.source !== parent || event.data !== 'eta-artifact-capture' || !event.ports[0]) return;
    event.stopImmediatePropagation();
    port = event.ports[0];
    connected();
    const ready = () => port.postMessage({ready:true});
    if (document.readyState === 'complete') ready();
    else addEventListener('load', ready, {once:true});
    port.onmessage = async ({data}) => {
      if (Number.isSafeInteger(data?.resourceId)) {
        const receive = reads.get(data.resourceId);
        reads.delete(data.resourceId);
        receive?.(data);
        return;
      }
      const {id, operation, index} = data;
      try {
        let result;
        if (operation === 'prepare') result = await prepare();
        else if (operation === 'render') result = await render(index);
        else if (operation === 'restore') {
          await frame();
          leavePrint();
          originalScroll = undefined;
        } else if (operation === 'scroll') originalScroll = [scrollX, scrollY];
        port.postMessage({id, result: result ?? null});
      } catch (error) {
        const message = error?.message;
        port.postMessage({id, problem: ['too-many-pages','missing-resources'].includes(message) ? message : 'render'});
      }
    };
  }, true);
  parent.postMessage('eta-artifact-capture-init', '*');
})();
`;

export const artifactDocumentOrigin = "http://eta-artifact.invalid/";

export function artifactResourcePrefix(url: URL) {
  const path = /^\/preview\/[\w.~%-]+\/files\//.exec(url.pathname);
  if (
    !path ||
    url.username ||
    url.password ||
    !(url.protocol === "https:" || url.protocol === "http:")
  )
    throw new Error("Invalid artifact preview path");
  return `${url.origin}${path[0]}`;
}

export function artifactPdfDocument(
  url: URL,
  html: string,
  rasterizer: string,
  bridge: string,
  lexer: string,
) {
  const resources = artifactResourcePrefix(url);
  const assets = `img-src data: blob: ${resources}; font-src data: ${resources}; media-src data: blob: ${resources}; connect-src ${resources}`;
  const job = JSON.stringify({
    html,
    url: url.href,
    resources,
    bridge,
    lexer,
    capture: `${rasterizer}\n${capturePage}`.replace(
      /<\/script/gi,
      "<\\/script",
    ),
  }).replaceAll("<", "\\u003c");
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src data: about:; script-src 'unsafe-inline' 'unsafe-eval' data: ${resources}; style-src 'unsafe-inline' data: ${resources}; ${assets}; form-action 'none'">
<style>html,body,iframe{border:0;margin:0;width:100%;height:100%;display:block;background:white}body{overflow:hidden}iframe{width:100%;height:100%}</style>
<iframe title="Artifact" sandbox="allow-scripts allow-same-origin" allow="camera 'none'; microphone 'none'; geolocation 'none'" referrerpolicy="no-referrer"></iframe>
<script>const job=${job};${artifactResourceLoader}${container}</script>`;
}
