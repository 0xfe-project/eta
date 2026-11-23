import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FileBrokerError,
  FileBrokerPolicy,
  isWindowsReservedDeviceName,
} from "../src/file-broker";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function createSymlinkOrJunction(targetDir: string, linkPath: string): void {
  if (process.platform === "win32") {
    fs.symlinkSync(targetDir, linkPath, "junction");
  } else {
    fs.symlinkSync(targetDir, linkPath, "dir");
  }
}

describe("fileBrokerPolicy", () => {
  let fixtureRoot = "";
  let projectDir = "";
  let worktreeDir = "";
  let uploadsDir = "";
  let stagingDir = "";
  let outsideDir = "";
  let homeDir = "";

  beforeEach(() => {
    const baseTmp = path.join(PACKAGE_ROOT, ".test-fixtures");
    fs.mkdirSync(baseTmp, { recursive: true });
    fixtureRoot = fs.mkdtempSync(path.join(baseTmp, "broker-"));
    projectDir = path.join(fixtureRoot, "project");
    worktreeDir = path.join(fixtureRoot, "worktree");
    uploadsDir = path.join(fixtureRoot, "uploads");
    stagingDir = path.join(fixtureRoot, "staging");
    outsideDir = path.join(fixtureRoot, "outside");
    homeDir = path.join(fixtureRoot, "home");

    for (const dir of [
      projectDir,
      worktreeDir,
      uploadsDir,
      stagingDir,
      outsideDir,
      homeDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fixtureRoot && fs.existsSync(fixtureRoot)) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
    const baseTmp = path.join(PACKAGE_ROOT, ".test-fixtures");
    if (fs.existsSync(baseTmp) && fs.readdirSync(baseTmp).length === 0) {
      fs.rmdirSync(baseTmp);
    }
  });

  it("silently allows read and write inside projectDir, worktreeDir, uploadsDir, and stagingDir without calling askApproval", async () => {
    const askApproval = vi.fn().mockResolvedValue(true);
    const policy = new FileBrokerPolicy({
      projectDir,
      worktreeDir,
      uploadsDir,
      stagingDir,
      homeDir,
      askApproval,
    });

    const projectFile = path.join(projectDir, "src", "index.ts");
    const worktreeFile = path.join(worktreeDir, "feature.ts");
    const uploadFile = path.join(uploadsDir, "avatar.png");
    const stagingFile = path.join(stagingDir, "download-report.pdf");

    expect(policy.decide(projectFile)).toBe("allow");
    expect(policy.decide(worktreeFile)).toBe("allow");
    expect(policy.decide(uploadFile)).toBe("allow");
    expect(policy.decide(stagingFile)).toBe("allow");

    const result = await policy.authorizeFiles(
      [projectFile, worktreeFile, uploadFile, stagingFile],
      "write",
    );

    expect(result.asked).toBe(false);
    expect(result.allowed).toHaveLength(4);
    expect(askApproval).not.toHaveBeenCalled();
  });

  it("does not allow sibling prefix-collision directories (e.g. project-evil vs project)", () => {
    const policy = new FileBrokerPolicy({
      projectDir: "/workspace/project",
      platform: "posix",
    });

    expect(policy.decide("/workspace/project/file.txt")).toBe("allow");
    expect(policy.decide("/workspace/project-evil/file.txt")).toBe("ask");
  });

  it("catches symlink escape outside projectDir for both existing files and non-existent save targets", async () => {
    const secretOutsideFile = path.join(outsideDir, "escaped.txt");
    fs.writeFileSync(secretOutsideFile, "outside-data", "utf8");

    const symlinkDir = path.join(projectDir, "linked-outside");
    createSymlinkOrJunction(outsideDir, symlinkDir);

    const existingViaSymlink = path.join(symlinkDir, "escaped.txt");
    const nonExistentSaveTargetViaSymlink = path.join(
      symlinkDir,
      "nested",
      "new-save-target.txt",
    );

    const askApproval = vi.fn().mockResolvedValue(false);
    const policy = new FileBrokerPolicy({
      projectDir,
      uploadsDir,
      stagingDir,
      homeDir,
      askApproval,
    });

    // Neither existing file nor non-existent save target inside the symlinked parent may be silently allowed
    const evalExisting = policy.evaluate(existingViaSymlink);
    expect(evalExisting.decision).toBe("ask");

    const evalNewTarget = policy.evaluate(nonExistentSaveTargetViaSymlink);
    expect(evalNewTarget.decision).toBe("ask");

    await expect(
      policy.authorizeFiles([existingViaSymlink], "read"),
    ).rejects.toMatchObject({
      code: "file_broker_rejected_by_user",
    });

    await expect(
      policy.authorizeFiles([nonExistentSaveTargetViaSymlink], "write"),
    ).rejects.toMatchObject({
      code: "file_broker_rejected_by_user",
    });
    expect(askApproval).toHaveBeenCalledTimes(2);
  });

  it("hard-denies symlink inside projectDir pointing to ~/.eta secrets", async () => {
    const etaDir = path.join(homeDir, ".eta");
    fs.mkdirSync(etaDir, { recursive: true });
    fs.writeFileSync(path.join(etaDir, "secret.key"), "top-secret", "utf8");

    const symlinkToEta = path.join(projectDir, "innocent-dir");
    createSymlinkOrJunction(etaDir, symlinkToEta);

    const askApproval = vi.fn().mockResolvedValue(true);
    const policy = new FileBrokerPolicy({
      projectDir,
      homeDir,
      askApproval,
    });

    const disguisedSecret = path.join(symlinkToEta, "secret.key");
    expect(policy.decide(disguisedSecret)).toBe("deny");

    await expect(
      policy.authorizeFiles([disguisedSecret], "read"),
    ).rejects.toMatchObject({
      code: "file_broker_denied",
    });
    expect(askApproval).not.toHaveBeenCalled();
  });

  it("rejects .. traversal, empty strings, null bytes, trailing dots/spaces, and Windows reserved device names", async () => {
    const policy = new FileBrokerPolicy({
      projectDir: "C:\\Workspace\\Project",
      platform: "win32",
    });

    const invalidInputs = [
      "",
      "   ",
      "C:\\Workspace\\Project\\file\0.txt",
      "C:\\Workspace\\Project\\..\\secret.txt",
      "../outside.txt",
      "C:\\Workspace\\Project\\sub\\..\\..\\outside.txt",
      "C:\\Workspace\\Project\\CON.txt",
      "C:\\Workspace\\Project\\nul",
      "C:\\Workspace\\Project\\aux.json",
      "C:\\Workspace\\Project\\COM1.log",
      "C:\\Workspace\\Project\\lpt9",
      "C:\\Workspace\\Project\\prn.tar.gz",
      "C:\\Workspace\\Project\\trailingdot.",
      "C:\\Workspace\\Project\\trailingspace ",
      "\\\\.\\CON",
      "C:relative.txt",
    ];

    for (const badPath of invalidInputs) {
      expect(() => policy.resolvePath(badPath)).toThrowError(FileBrokerError);
      await expect(
        policy.authorizeFiles([badPath], "read"),
      ).rejects.toMatchObject({
        code: "file_broker_invalid_path",
      });
    }

    expect(isWindowsReservedDeviceName("CON.txt")).toBe(true);
    expect(isWindowsReservedDeviceName("nul")).toBe(true);
    expect(isWindowsReservedDeviceName("aux.json")).toBe(true);
    expect(isWindowsReservedDeviceName("console.txt")).toBe(false);
  });

  it("supports case-insensitive path matching on win32 and case-sensitive matching on posix", () => {
    const winPolicy = new FileBrokerPolicy({
      projectDir: "C:\\Workspace\\EtaProject",
      uploadsDir: "C:\\Workspace\\Uploads",
      platform: "win32",
    });

    expect(winPolicy.decide("c:\\workspace\\etaproject\\src\\App.tsx")).toBe(
      "allow",
    );
    expect(winPolicy.decide("C:/WORKSPACE/UPLOADS/photo.jpg")).toBe("allow");
    expect(winPolicy.decide("D:\\workspace\\etaproject\\src\\App.tsx")).toBe(
      "ask",
    );

    const posixPolicy = new FileBrokerPolicy({
      projectDir: "/workspace/EtaProject",
      uploadsDir: "/workspace/Uploads",
      platform: "posix",
    });

    expect(posixPolicy.decide("/workspace/EtaProject/src/App.tsx")).toBe(
      "allow",
    );
    expect(posixPolicy.decide("/workspace/etaproject/src/App.tsx")).toBe("ask");
    expect(posixPolicy.decide("/workspace/uploads/photo.jpg")).toBe("ask");
  });

  it("hard-denies ~/.eta/secret.key, ~/.eta/access-token, and other sensitive paths even when askApproval returns true", async () => {
    const askApproval = vi.fn().mockResolvedValue(true);
    const policy = new FileBrokerPolicy({
      projectDir: "/Users/alice/project",
      homeDir: "/Users/alice",
      deniedPaths: ["/Users/alice/private-vault"],
      platform: "posix",
      askApproval,
    });

    const deniedCandidates = [
      "~/.eta/secret.key",
      "~/.eta/access-token",
      "~/.eta/identity.json",
      "~/.eta/plugin_config",
      "~/.eta/credential",
      "~/.eta/llm/auths/anthropic.json",
      "~/.ssh/id_rsa",
      "~/.gnupg/private-keys-v1.d/key.gpg",
      "/Users/alice/.eta/secret.key",
      "/Users/alice/.eta/access-token",
      "/Users/alice/project/secret.key",
      "/Users/alice/private-vault/passwords.kdbx",
    ];

    for (const target of deniedCandidates) {
      expect(policy.decide(target)).toBe("deny");
      await expect(
        policy.authorizeFiles([target], "read"),
      ).rejects.toMatchObject({
        code: "file_broker_denied",
      });
    }

    expect(askApproval).not.toHaveBeenCalled();
  });

  it("invokes askApproval for outside paths and only succeeds when askApproval resolves to true", async () => {
    const outsideFile = path.join(outsideDir, "quarterly-report.xlsx");

    // 1. Without askApproval callback -> rejects with file_broker_rejected_by_user
    const policyWithoutCallback = new FileBrokerPolicy({
      projectDir,
      uploadsDir,
      stagingDir,
      homeDir,
    });
    await expect(
      policyWithoutCallback.authorizeFiles([outsideFile], "read"),
    ).rejects.toMatchObject({
      code: "file_broker_rejected_by_user",
    });

    // 2. With askApproval returning false -> rejects with file_broker_rejected_by_user
    const rejectCallback = vi.fn().mockResolvedValue(false);
    const rejectingPolicy = new FileBrokerPolicy({
      projectDir,
      uploadsDir,
      stagingDir,
      homeDir,
      askApproval: rejectCallback,
    });
    await expect(
      rejectingPolicy.authorizeFiles([outsideFile], "write"),
    ).rejects.toMatchObject({
      code: "file_broker_rejected_by_user",
    });
    expect(rejectCallback).toHaveBeenCalledTimes(1);
    expect(rejectCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "write",
        paths: [rejectingPolicy.resolvePath(outsideFile)],
      }),
    );

    // 3. With askApproval returning true -> resolves with allowed paths and asked: true
    const approveCallback = vi.fn().mockResolvedValue(true);
    const approvingPolicy = new FileBrokerPolicy({
      projectDir,
      uploadsDir,
      stagingDir,
      homeDir,
      askApproval: approveCallback,
    });

    const authorized = await approvingPolicy.authorizeFiles(
      [outsideFile],
      "read",
    );
    expect(authorized).toEqual({
      allowed: [approvingPolicy.resolvePath(outsideFile)],
      asked: true,
    });
    expect(approveCallback).toHaveBeenCalledTimes(1);
  });
});
