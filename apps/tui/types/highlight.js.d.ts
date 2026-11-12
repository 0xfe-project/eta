// The one type lowlight's declarations import from highlight.js. The tsconfig maps the module
// here so highlight.js's own declarations, which reference the DOM library and would make the
// DOM WebSocket shadow Bun's across the package, are never loaded.
export type LanguageFn = (hljs?: unknown) => unknown;
