import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bootstrapExitKind,
  desktopHostLauncherCommand,
  desktopHostLauncherName,
  desktopHostLauncherPath,
  desktopHostLauncherURL,
  desktopHostProcessGrants,
  fileURLToPath,
} from "../src/host-launcher";

describe("desktop host launcher", () => {
  it("names the launcher for each desktop package", () => {
    expect(desktopHostLauncherName("macos")).toBe("eta-bootstrap");
    expect(desktopHostLauncherName("linux")).toBe("eta-bootstrap");
    expect(desktopHostLauncherName("windows")).toBe("eta-bootstrap.exe");
  });

  it("finds the launcher around the packaged nsh bundle", () => {
    expect(
      desktopHostLauncherURL(
        "macos",
        "file:///Applications/Eta.app/Contents/Resources/nsh/bundle.nshc",
      ).pathname,
    ).toBe("/Applications/Eta.app/Contents/Resources/nsh/eta-bootstrap");
    expect(
      desktopHostLauncherURL("linux", "file:///opt/Eta/nsh/bundle.nshc")
        .pathname,
    ).toBe("/opt/Eta/nsh/eta-bootstrap");
    expect(
      desktopHostLauncherURL("windows", "file:///E:/Apps/Eta/nsh/bundle.nshc")
        .pathname,
    ).toBe("/E:/Apps/Eta/eta-bootstrap.exe");
  });

  it("turns Windows file URLs into executable paths", () => {
    expect(
      desktopHostLauncherPath(
        "windows",
        "file:///C:/Program%20Files/Eta/nsh/bundle.nshc",
      ),
    ).toBe("C:\\Program Files\\Eta\\eta-bootstrap.exe");
  });

  it("decodes non-ASCII install directories on every desktop", () => {
    expect(
      desktopHostLauncherPath(
        "macos",
        "file:///Users/me/%E5%BA%94%E7%94%A8/Eta.app/Contents/Resources/nsh/bundle.nshc",
      ),
    ).toBe("/Users/me/应用/Eta.app/Contents/Resources/nsh/eta-bootstrap");
    expect(
      desktopHostLauncherPath(
        "windows",
        "file:///C:/Users/%E5%BA%94%E7%94%A8/Eta/nsh/bundle.nshc",
      ),
    ).toBe("C:\\Users\\应用\\Eta\\eta-bootstrap.exe");
  });

  it("keeps UNC shares on Windows", () => {
    expect(
      fileURLToPath(
        new URL("file://server/share/Eta/nsh/bundle.nshc"),
        "windows",
      ),
    ).toBe("\\\\server\\share\\Eta\\nsh\\bundle.nshc");
  });

  it("does not claim a launcher in a page or development source URL", () => {
    expect(
      desktopHostLauncherPath("linux", "https://example.com/bundle.nshc"),
    ).toBeUndefined();
    expect(desktopHostLauncherPath("web", "file:///tmp/bundle.nshc")).toBe(
      undefined,
    );
  });

  it("uses the exact commands NSH can grant on each desktop", () => {
    expect(
      desktopHostLauncherCommand(
        "windows",
        "C:\\Apps\\R&D (test)\\eta-bootstrap.exe",
        "1.2.3",
      ),
    ).toEqual({
      command: "cmd.exe",
      args: [
        "/d",
        "/c",
        "call",
        "C:\\Apps\\R&D (test)\\eta-bootstrap.exe",
        "1.2.3",
      ],
    });
    expect(
      desktopHostLauncherCommand(
        "macos",
        "/Applications/Eta.app/Contents/Resources/nsh/eta-bootstrap",
        "1.2.3",
      ),
    ).toEqual({
      command: "env",
      args: [
        "/Applications/Eta.app/Contents/Resources/nsh/eta-bootstrap",
        "1.2.3",
      ],
    });
    expect(desktopHostLauncherCommand("web", "/tmp/launcher", "1.2.3")).toBe(
      undefined,
    );
  });

  it("recognizes a launcher that could not be started", () => {
    expect(bootstrapExitKind("macos", 127)).toBe("missing");
    expect(bootstrapExitKind("linux", 127)).toBe("missing");
    expect(bootstrapExitKind("windows", 1)).toBe("missing");
    expect(bootstrapExitKind("windows", 42)).toBe("start");
    expect(bootstrapExitKind("linux", 1)).toBe("start");
  });

  it("keeps the process capability in step with the commands it uses", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../../apps/client/nsh.json", import.meta.url),
        "utf8",
      ),
    ) as {
      capabilities: { process: { execute: string[] } };
    };
    const granted = manifest.capabilities.process.execute;
    expect(granted).toHaveLength(desktopHostProcessGrants.length);
    expect([...granted].sort()).toEqual([...desktopHostProcessGrants].sort());
  });
});
