import type {
  ComputerMicroAction,
  ComputerUserInput,
} from "@eta/client-contracts";
import type {
  ManagedRealm,
  PromotableDriver,
  RealmDriver,
  RealmObservation,
  RealmStepResult,
} from "@eta/computer";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiddenDesktopError, RealmManager } from "@eta/computer";
import { describe, expect, it, vi } from "vitest";
import { ComputerService } from "../src/computer/service";

const VIEWPORT = { width: 1280, height: 800, scaleFactor: 1 };

/**
 * A hidden-desktop realm that can take the screen. The real one switches a Win32 desktop and hosts
 * a WinForms overlay; here the switch is recorded and the overlay is two files we can write to.
 */
class FakePromotableDriver implements RealmDriver, PromotableDriver {
  readonly kind = "app" as const;
  readonly tier = "hidden_desktop" as const;
  readonly promoteCalls: number[] = [];
  readonly demoteCalls: number[] = [];
  closed = false;
  directories: string[] = [];

  title(): string {
    return "记事本";
  }

  target(): string {
    return "notepad.exe";
  }

  viewport(): { width: number; height: number; scaleFactor: number } {
    return VIEWPORT;
  }

  async observe(): Promise<RealmObservation> {
    return {
      mimeType: "image/png",
      data: Buffer.from("frame").toString("base64"),
      viewport: VIEWPORT,
    };
  }

  async step(
    _action: ComputerMicroAction,
    _ctx: { signal: AbortSignal; clipboard: unknown },
  ): Promise<RealmStepResult | void> {}

  async userInput(_input: ComputerUserInput): Promise<void> {}

  async promote(): Promise<{ chatFile: string; statusFile: string }> {
    this.promoteCalls.push(Date.now());
    const dir = mkdtempSync(join(tmpdir(), "eta-promote-test-"));
    this.directories.push(dir);
    const chatFile = join(dir, "chat.jsonl");
    const statusFile = join(dir, "status.txt");
    writeFileSync(chatFile, "", "utf8");
    writeFileSync(statusFile, "Agent 正在工作\n", "utf8");
    return { chatFile, statusFile };
  }

  async demote(): Promise<void> {
    this.demoteCalls.push(Date.now());
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function registerPromotable(
  manager: RealmManager,
  conversationId: string,
): { driver: FakePromotableDriver; realm: ManagedRealm } {
  const driver = new FakePromotableDriver();
  const realm = manager.register(driver, {
    id: "realm_promote",
    sessionId: "sess_promote",
    conversationId,
  });
  return { driver, realm };
}

describe("promote / demote: bringing a realm desktop to the user's screen", () => {
  it("switches to the realm as a takeover, forwards overlay chat to the conversation, and hands the screen back", async () => {
    const manager = new RealmManager();
    const { driver, realm } = registerPromotable(manager, "conv_promote");
    const sent: { conversationId: string; text: string }[] = [];
    const service = new ComputerService({
      manager,
      sendChat: (conversationId, text) => {
        sent.push({ conversationId, text });
      },
      latestReply: () => "已收到，正在处理。",
    });

    const promoted = await service.promoteRealm("realm_promote");
    expect(driver.promoteCalls).toHaveLength(1);
    expect(promoted.promoted).toBe(true);
    // The human is in front of the keyboard the moment the screen switches.
    expect(promoted.controller).toBe("user");
    expect(promoted.summary).toContain("screen");

    const overlay = manager.require("realm_promote");
    const chatFile = join(driver.directories[0] as string, "chat.jsonl");
    const statusFile = join(driver.directories[0] as string, "status.txt");
    writeFileSync(chatFile, '{"text":"把窗口最大化"}\n', "utf8");

    await vi.waitFor(
      () => {
        expect(sent).toEqual([
          { conversationId: "conv_promote", text: "把窗口最大化" },
        ]);
      },
      { timeout: 4000 },
    );
    expect(overlay.view().conversationId).toBe("conv_promote");

    // Status file carries JSON with controller + latest agent reply preview.
    await vi.waitFor(
      () => {
        const parsed = JSON.parse(readFileSync(statusFile, "utf8")) as {
          controller?: string;
          reply?: string;
        };
        expect(parsed.controller).toBe("user");
        expect(parsed.reply).toBe("已收到，正在处理。");
      },
      { timeout: 4000 },
    );

    // Control toggle from overlay (`__release__` -> agent, `__pause__` -> paused) works without sending chat.
    writeFileSync(
      chatFile,
      '{"text":"把窗口最大化"}\n{"text":"__release__"}\n',
      "utf8",
    );
    await vi.waitFor(
      () => {
        expect(realm.view().controller).toBe("agent");
      },
      { timeout: 4000 },
    );

    writeFileSync(
      chatFile,
      '{"text":"把窗口最大化"}\n{"text":"__release__"}\n{"text":"__switch_back__"}\n',
      "utf8",
    );
    await vi.waitFor(
      () => {
        expect(driver.demoteCalls).toHaveLength(1);
      },
      { timeout: 4000 },
    );

    await vi.waitFor(() => {
      expect(realm.view().promoted).toBe(false);
      expect(realm.view().controller).toBe("agent");
    });
    // Only the real chat line was forwarded; the switch-back marker never becomes a message.
    expect(sent).toHaveLength(1);
  });

  it("promoting a realm that is already on screen changes nothing", async () => {
    const manager = new RealmManager();
    const { driver } = registerPromotable(manager, "conv_twice");
    const service = new ComputerService({ manager });

    const first = await service.promoteRealm("realm_promote");
    expect(driver.promoteCalls).toHaveLength(1);

    // A second press — a double click, or the panel and the strip both asking — must not stack a
    // second overlay on the same desktop: the replaced overlay's teardown switches the screen back.
    const second = await service.promoteRealm("realm_promote");
    expect(driver.promoteCalls).toHaveLength(1);
    expect(second.promoted).toBe(true);
    expect(second.epoch).toBe(first.epoch);

    await service.demoteRealm("realm_promote", "Done");
    expect(driver.demoteCalls).toHaveLength(1);
  });

  it("closes a realm whose app died instead of showing an empty desktop", async () => {
    class DeadDriver extends FakePromotableDriver {
      override async promote(): Promise<{
        chatFile: string;
        statusFile: string;
      }> {
        throw new HiddenDesktopError(
          "desktop_closed",
          '"blender.exe" is no longer running on "eta_cu_x"; nothing to show, reopen the realm',
          "blender.exe",
        );
      }
    }
    const manager = new RealmManager();
    const driver = new DeadDriver();
    manager.register(driver, { id: "realm_dead", sessionId: "sess_dead" });
    const service = new ComputerService({ manager });

    await expect(service.promoteRealm("realm_dead")).rejects.toThrow(
      /no longer running/,
    );
    const view = manager.require("realm_dead").view();
    expect(view.controller).toBe("closed");
    expect(view.promoted).toBe(false);
  });

  it("refuses to promote a realm whose driver has no screen to switch", async () => {
    const manager = new RealmManager();
    const bareDriver: RealmDriver = {
      kind: "browser",
      tier: "cdp",
      title: () => "Example",
      target: () => "https://example.com",
      viewport: () => VIEWPORT,
      observe: async () => ({
        mimeType: "image/png",
        data: Buffer.from("frame").toString("base64"),
        viewport: VIEWPORT,
      }),
      step: async () => undefined,
      close: async () => {},
    };
    manager.register(bareDriver, { id: "realm_browser" });
    const service = new ComputerService({ manager });

    await expect(service.promoteRealm("realm_browser")).rejects.toThrow(
      /cannot be brought to the screen/,
    );
    expect(manager.require("realm_browser").view().controller).toBe("agent");
    // A demote nobody asked for is a no-op, not an error.
    await expect(service.demoteRealm("realm_browser")).resolves.toMatchObject({
      promoted: false,
    });
  });
});
