import { expect, test } from "nsh/test";
import { launcherPath } from "../packaged-host-bootstrap";

test("resolves the Windows launcher relative to the bundle, stripping /E: and converting slashes", () => {
  expect(
    launcherPath("file:///E:/download/x/Eta/nsh/bundle.nshc", "windows"),
  ).toBe("E:\\download\\x\\Eta\\eta-bootstrap.exe");
});

test("resolves the macOS launcher alongside the bundle", () => {
  expect(
    launcherPath(
      "file:///Applications/Eta.app/Contents/Resources/nsh/bundle.nshc",
      "macos",
    ),
  ).toBe("/Applications/Eta.app/Contents/Resources/nsh/eta-bootstrap");
});

test("resolves the Linux launcher alongside the bundle", () => {
  expect(launcherPath("file:///opt/Eta/nsh/bundle.nshc", "linux")).toBe(
    "/opt/Eta/nsh/eta-bootstrap",
  );
});

test("decodes URL-encoded characters such as %20 in paths", () => {
  expect(
    launcherPath("file:///E:/my%20apps/Eta/nsh/bundle.nshc", "windows"),
  ).toBe("E:\\my apps\\Eta\\eta-bootstrap.exe");
});
