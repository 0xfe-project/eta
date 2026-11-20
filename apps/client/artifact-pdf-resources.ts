// Runs in the trusted wrapper. Only it holds the token for the NSH asset bridge.
export const artifactResourceLoader = String.raw`
const assetRequests = new Map();
const assetCache = new Map();
let assetId = 0;

function offeredAsset(value, relativeTo) {
  try {
    const address = new URL(value, relativeTo);
    address.hash = '';
    return address.href.startsWith(job.resources) ? address.href : undefined;
  } catch { return undefined; }
}

function asset(address) {
  if (!assetCache.has(address)) {
    assetCache.set(address, new Promise((resolve, reject) => {
      const id = ++assetId;
      const timer = setTimeout(() => {
        assetRequests.delete(id);
        reject(new Error('asset-timeout'));
      }, 12_000);
      assetRequests.set(id, {resolve, reject, timer, parts:[]});
      window.nsh.postMessage(JSON.stringify({bridge:job.bridge,asset:address,id}));
    }));
  }
  return assetCache.get(address);
}

function resolveAsset(packet) {
  const request = assetRequests.get(packet.assetId);
  if (!request) return;
  if (typeof packet.part === 'string') request.parts.push(packet.part);
  if (!packet.done) return;
  assetRequests.delete(packet.assetId);
  clearTimeout(request.timer);
  if (!packet.mime) request.reject(new Error('missing-asset'));
  else {
    const body = request.parts.join('');
    request.resolve({uri:'data:' + packet.mime + ';base64,' + body, body, mime:packet.mime});
  }
}

function fromBase64(value) {
  return new TextDecoder().decode(Uint8Array.from(atob(value), character => character.charCodeAt(0)));
}

async function replaceAsync(source, pattern, replacement) {
  const matches = [...source.matchAll(pattern)];
  const replacements = await Promise.all(matches.map(replacement));
  let result = '', index = 0;
  matches.forEach((match, i) => {
    result += source.slice(index, match.index) + replacements[i];
    index = match.index + match[0].length;
  });
  return result + source.slice(index);
}

function dataText(mime, source) {
  return 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(source);
}

async function resolveCss(source, place, ancestry = []) {
  const local = async (value, imports) => {
    const address = offeredAsset(value, place);
    if (!address) return value;
    if (ancestry.includes(address) || ancestry.length > 12)
      throw new Error('nested stylesheet cycle');
    const result = await asset(address);
    return imports ? dataText('text/css', await resolveCss(fromBase64(result.body), address, [...ancestry, address])) : result.uri;
  };
  return replaceAsync(source, /(\@import\s+)(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|"([^"]*)"|'([^']*)')|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi, async (match) => {
    const value = match.slice(2).find((capture) => typeof capture === 'string')?.trim();
    if (!value || value.startsWith('#')) return match[0];
    const uri = await local(value, Boolean(match[1]));
    return (match[1] || '') + 'url(' + JSON.stringify(uri) + ')';
  });
}

async function replaceSource(node, attr, base) {
  const ref = node.getAttribute(attr);
  if (!ref) return;
  const address = offeredAsset(ref, base);
  if (address) node.setAttribute(attr, (await asset(address)).uri);
}

async function embedModules(doc, base) {
  const scripts = [...doc.querySelectorAll('script[type="module"]')];
  if (!scripts.length) return;
  const lexer = await import(dataText('text/javascript', job.lexer));
  await lexer.init;
  const mappings = new Map();
  for (const entry of doc.querySelectorAll('script[type="importmap"]')) {
    try {
      for (const [name, address] of Object.entries(JSON.parse(entry.textContent).imports || {}))
        if (typeof address === 'string') mappings.set(name, address);
    } catch {}
  }
  const prefixes = [...mappings.keys()].filter(name => name.endsWith('/')).sort((a,b) => b.length-a.length);
  const resolveModule = (name, file) => {
    if (mappings.has(name)) return offeredAsset(mappings.get(name), base);
    const prefix = prefixes.find(prefix => name.startsWith(prefix));
    if (prefix) return offeredAsset(mappings.get(prefix) + name.slice(prefix.length), base);
    return /^(?:\.{1,2}\/|\/|https?:)/i.test(name) ? offeredAsset(name, file) : undefined;
  };
  const remaining = new Set();
  const sources = new Map();
  const translate = (source, file) => {
    const [imports] = lexer.parse(source);
    const edits = [];
    for (const entry of imports) {
      if (entry.t === 3 && source.slice(entry.e, entry.e + 4) === '.url')
        edits.push([entry.s, entry.e + 4, JSON.stringify(file)]);
      else if (entry.n) {
        const address = resolveModule(entry.n, file);
        if (!address) continue;
        remaining.add(address);
        edits.push([entry.s, entry.e, entry.d < 0 ? address.replaceAll("'", '%27') : JSON.stringify(address)]);
      }
    }
    for (const [start, end, replacement] of edits.reverse())
      source = source.slice(0, start) + replacement + source.slice(end);
    return source;
  };
  for (const script of scripts) {
    const source = script.getAttribute('src');
    const address = source && offeredAsset(source, base);
    if (address) remaining.add(address);
    else if (!source) script.textContent = translate(script.textContent, base);
  }
  for (const address of remaining) {
    if (sources.has(address)) continue;
    const module = await asset(address);
    sources.set(address, dataText('text/javascript', translate(fromBase64(module.body), address)));
  }
  const imports = doc.createElement('script');
  imports.type = 'importmap';
  imports.textContent = JSON.stringify({imports:Object.fromEntries(sources)}).replaceAll('<', '\\u003c');
  doc.head.prepend(imports);
  for (const script of scripts) {
    const src = script.getAttribute('src');
    if (src) {
      const replacement = sources.get(offeredAsset(src, base));
      if (replacement) script.src = replacement;
    }
  }
}

async function embedResources(doc, base) {
  const tasks = [...doc.querySelectorAll('link[rel~="stylesheet"]')].map(async (link) => {
    const address = offeredAsset(link.getAttribute('href'), base);
    if (!address) return;
    const sheet = await asset(address);
    const style = doc.createElement('style');
    style.media = link.media;
    style.textContent = await resolveCss(fromBase64(sheet.body), address, [address]);
    link.replaceWith(style);
  });
  for (const element of doc.querySelectorAll('style, [style]')) {
    if (element.tagName === 'STYLE') tasks.push(resolveCss(element.textContent, base).then(text => element.textContent = text));
    const css = element.getAttribute('style');
    if (css) tasks.push(resolveCss(css, base).then(text => element.setAttribute('style', text)));
  }
  for (const node of doc.querySelectorAll('script[src]:not([type="module"]), img[src], source[src], video[src], audio[src], track[src], input[type="image"][src]'))
    tasks.push(replaceSource(node, 'src', base));
  for (const node of doc.querySelectorAll('video[poster]')) tasks.push(replaceSource(node, 'poster', base));
  for (const node of doc.querySelectorAll('svg image[href]')) tasks.push(replaceSource(node, 'href', base));
  for (const node of doc.querySelectorAll('[srcset]')) {
    const srcset = node.getAttribute('srcset');
    if (!srcset.startsWith('data:') && !srcset.includes(' data:')) {
      tasks.push(Promise.all(srcset.split(',').map(async candidate => {
        const [source, ...descriptor] = candidate.trim().split(/\s+/);
        const address = source && offeredAsset(source, base);
        return [address ? (await asset(address)).uri : source, ...descriptor].join(' ');
      })).then(values => node.setAttribute('srcset', values.join(', '))));
    }
  }
  tasks.push(embedModules(doc, base));
  await Promise.all(tasks);
}
`;
