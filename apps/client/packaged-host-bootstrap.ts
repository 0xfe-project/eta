export function packagedHostBootstrap(): string | undefined {
  // The desktop package puts the launcher beside the bundle, at the app source root.
  const launcher = new URL("eta-bootstrap", import.meta.url);
  if (launcher.protocol === "file:")
    return decodeURIComponent(launcher.pathname);
}
