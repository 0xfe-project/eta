import type {
  AgentRuntimeAccount,
  AgentRuntimeInfo,
} from "@eta/client-contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setWire } from "@/lib/wire";
import { buildProductHost, machineView } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { RuntimesView } from "./runtimes-view";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    className,
  }: {
    to: string;
    search?: { section?: string };
    children?: React.ReactNode;
    className?: string;
  }) => (
    <a
      data-to={`${to}${search?.section === undefined ? "" : `?section=${search.section}`}`}
      className={className}
    >
      {children}
    </a>
  ),
}));

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

const settle = () => flush(20);

const TIMEOUT =
  "Failed to list opencode models: opencode models --verbose timeout after 30000 ms";

const PRIMARY = machineView({ id: "m-primary", name: "studio" });
const BOX = machineView({ id: "m-box", kind: "daemon", name: "box" });
const ATTIC = machineView({
  id: "m-attic",
  kind: "daemon",
  name: "attic",
  status: "offline",
});

const claude: AgentRuntimeInfo = {
  id: "claude",
  label: "Claude Code",
  status: "available",
  // As `claude --version` prints it.
  version: "2.1.0 (Claude Code)",
  models: [
    {
      id: "opus",
      name: "Opus",
      default: true,
      efforts: ["low", "medium", "high"],
    },
  ],
};
const opencode: AgentRuntimeInfo = {
  id: "opencode",
  label: "OpenCode",
  status: "error",
  detail: TIMEOUT,
  models: [],
};

const gemini: AgentRuntimeInfo = {
  id: "acp.gemini",
  label: "Gemini",
  status: "available",
  models: [],
};

const ACCOUNTS: Record<string, AgentRuntimeAccount> = {
  claude: {
    auth: { kind: "logged_in", email: "ada@example.com", plan: "max" },
    usage: {
      kind: "available",
      plan: "max",
      rateLimited: false,
      windows: [{ label: "5h", usedRatio: 0.25 }],
    },
  },
  // OpenCode has neither query in oar: the host answers with no parts.
  opencode: {},
};

/** A host with a primary, an online daemon and an offline one, each with its own runtimes. */
async function open() {
  const host = buildProductHost({ machines: [PRIMARY, BOX, ATTIC] }, ["usage"])
    .target("usage", {
      providers: [
        {
          provider: "claude",
          windows: {
            "5h": { total: 0 },
            "24h": { total: 0 },
            "7d": { total: 12_000 },
            "30d": { total: 12_000 },
          },
        },
      ],
    })
    .handle("agents.runtimes", (args) => {
      const { machineId } = args as { machineId?: string };
      return {
        runtimes:
          machineId === BOX.id
            ? [{ ...claude, version: "codex-cli 2.0.9" }]
            : [claude, opencode, gemini],
      };
    })
    .handle("agents.runtimeAccount", (args) => ({
      account: ACCOUNTS[(args as { runtime: string }).runtime],
    }));
  host.install();
  host.hello();
  await mount(<RuntimesView />);
  await settle();
  return host;
}

const group = (name: string) =>
  [...document.querySelectorAll("section[data-machine]")].find(
    (section) => section.querySelector("h3")?.textContent === name,
  )!;
const row = (machine: string, runtime: string) =>
  group(machine).querySelector<HTMLLIElement>(`[data-runtime="${runtime}"]`)!;
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};

describe("the runtimes page", () => {
  it("lists each machine's runtimes under the machine, and says when one cannot be asked", async () => {
    const host = await open();
    expect(
      [...document.querySelectorAll("section[data-machine] h3")].map(
        (h) => h.textContent,
      ),
    ).toEqual(["studio", "box", "attic"]);
    expect(row("studio", "claude").textContent).toContain("v2.1.0");
    expect(row("studio", "claude").textContent).not.toContain("(Claude Code)");
    expect(row("studio", "opencode")).not.toBeNull();
    expect(row("box", "claude").textContent).toContain("v2.0.9");
    expect(row("box", "opencode")).toBeNull();
    // The offline machine is not asked, and says why it lists nothing.
    expect(group("attic").querySelector("[data-runtime]")).toBeNull();
    expect(group("attic").textContent).toContain("attic 重新上线后");
    const asked = host.calls
      .filter((call) => call.action === "runtimes")
      .map((call) => call.args);
    expect(asked).toContainEqual({});
    expect(asked).toContainEqual({ machineId: BOX.id });
    expect(asked).not.toContainEqual({ machineId: ATTIC.id });
  });

  it("says a probe timed out in a few words, its own words only under diagnose", async () => {
    await open();
    const button = row("studio", "opencode").querySelector("button")!;
    expect(button.textContent).toContain("探测超时（30s）");
    expect(button.textContent).not.toContain(TIMEOUT);
    await click(button);
    const diagnose = row("studio", "opencode").querySelector("details")!;
    expect(diagnose.querySelector("summary")!.textContent).toBe("诊断");
    expect(diagnose.textContent).toContain(TIMEOUT);
  });

  it("shows week tokens from the usage table, and no cost", async () => {
    await open();
    const line = row("studio", "claude").querySelector("button")!.textContent;
    expect(line).toContain("内置");
    expect(line).toContain("7 天");
    expect(line).not.toMatch(/\$/);
    expect(row("studio", "opencode").textContent).toContain("7 天 0 tokens");
  });

  it("shows sign-in and plan usage only for a runtime that reports them", async () => {
    await open();
    await click(row("studio", "claude").querySelector("button")!);
    const claudeRow = row("studio", "claude");
    expect(
      claudeRow.querySelector('[data-block="auth"]')!.textContent,
    ).toContain("ada@example.com");
    expect(
      claudeRow.querySelector('[data-block="usage"]')!.textContent,
    ).toContain("25%");
    expect(claudeRow.textContent).toContain("Opus");
    expect(claudeRow.textContent).toContain("默认");
    expect(claudeRow.textContent).toContain("思考档：low / medium / high");

    await click(row("studio", "opencode").querySelector("button")!);
    const opencodeRow = row("studio", "opencode");
    expect(opencodeRow.querySelector('[data-block="auth"]')).toBeNull();
    expect(opencodeRow.querySelector('[data-block="usage"]')).toBeNull();
  });

  it("probes a machine again past the host's cache", async () => {
    const host = await open();
    const probe = [...group("box").querySelectorAll("button")].find(
      (button) => button.textContent === "重新探测",
    )!;
    await click(probe);
    expect(
      host.calls
        .filter((call) => call.action === "runtimes")
        .map((call) => call.args),
    ).toContainEqual({ fresh: true, machineId: BOX.id });
  });

  it("marks a custom runtime and leads to its settings, where it is configured", async () => {
    await open();
    const custom = row("studio", "acp.gemini");
    expect(custom.querySelector("button")!.textContent).toContain("自定义");
    const edit = custom.querySelector("a")!;
    expect(edit.textContent).toBe("编辑");
    expect(edit.getAttribute("data-to")).toBe("/settings?section=acp");
    expect(row("studio", "claude").querySelector("a")).toBeNull();
    const add = [...document.querySelectorAll("a")].find(
      (link) => link.textContent === "添加自定义运行时",
    )!;
    expect(add.getAttribute("data-to")).toBe("/settings?section=acp");
  });
});
