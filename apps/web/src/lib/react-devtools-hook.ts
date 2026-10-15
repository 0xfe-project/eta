// A bare React DevTools hook, installed before react-dom loads (first import
// in client.tsx): React registers its renderer only with a hook that exists
// when it starts. React Grab (lib/element-picker.ts) needs that renderer to
// list a production element's components; loaded later, it finds the hook
// here, so 圈选元素 can be turned on without a reload. A real DevTools
// extension's hook is left alone.
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ??= {
  renderers: new Map(),
  supportsFiber: true,
  supportsFlight: false,
  hasUnsupportedRendererAttached: false,
  inject(renderer) {
    this.renderers.set(this.renderers.size + 1, renderer);
    return this.renderers.size;
  },
  on: () => {},
  checkDCE: () => {},
  onCommitFiberRoot: () => {},
  onCommitFiberUnmount: () => {},
  onPostCommitFiberRoot: () => {},
};
