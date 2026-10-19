import type { Computers } from "@/api/control-plane.gen";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ComputerSettings } from "./computer-settings";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Two devices asked to pair under the laptop's label.
const computers = {
  relay_configured: true,
  relay_url: "https://eta.test/remote/relay",
  relay_error: null,
  computers: [
    {
      id: "c1",
      name: "laptop",
      enrolled: true,
      online: false,
      hostname: "laptop",
      os: "linux",
      arch: "amd64",
      active_runs: 0,
      max_active_runs: 3,
      queued_runs: 0,
      enroll_expires_at: null,
      created_at: "2026-10-09T09:00:00Z",
      runtimes: [
        {
          kind: "paseo",
          providers: ["claude"],
          state: "pairing",
          fingerprints: ["SHA256:aaaa", "SHA256:bbbb"],
        },
      ],
    },
  ],
} as unknown as Computers;

// The app mounts these providers at its root (AppProviders).
async function renderSettings() {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () =>
    createRoot(container).render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ComputerSettings />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const buttons = (name: string) =>
  [...document.querySelectorAll("button")].filter((b) =>
    b.textContent?.startsWith(name),
  );

describe("approving a computer's runtime", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    rstest.restoreAllMocks();
  });

  it("lists every pairing request and approves the one clicked", async () => {
    const approvals: unknown[] = [];
    rstest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request;
      if (request.method === "POST") {
        approvals.push(await request.json());
        return new Response(null, { status: 204 });
      }
      return Response.json(computers);
    });
    await renderSettings();
    await act(settle);
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[aria-label="laptop 的离线说明"]')
        ?.click();
      await settle();
    });
    expect(document.body.textContent).toContain("选“更新 connector”");
    await act(async () => {
      buttons("批准 Paseo")[0].click();
      await settle();
    });
    expect(document.body.textContent).toContain("收到 2 个配对请求");
    expect(document.body.textContent).toContain("SHA256:aaaa");
    expect(document.body.textContent).toContain("SHA256:bbbb");
    const approve = buttons("批准").filter((b) => b.textContent === "批准");
    expect(approve).toHaveLength(2);
    await act(async () => {
      approve[1].click();
      await settle();
    });
    expect(approvals).toEqual([{ fingerprint: "SHA256:bbbb" }]);
  });
});

// The laptop's Paseo connector runs agenvo 0.1.0; eta serves 0.2.0.
const outdated = {
  ...computers,
  connector_version: "0.2.0",
  computers: [
    {
      ...computers.computers[0],
      online: true,
      runtimes: [
        {
          kind: "paseo",
          providers: ["claude"],
          state: "online",
          fingerprints: [],
          connector_version: "0.1.0",
          needs_update: true,
        },
      ],
    },
  ],
} as unknown as Computers;

describe("updating a computer's connector", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    rstest.restoreAllMocks();
  });

  it("marks it and shows the update command with the steps", async () => {
    const posted: string[] = [];
    rstest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request;
      if (request.method === "POST") {
        posted.push(new URL(request.url).pathname);
        return Response.json({
          computer: outdated.computers[0],
          command:
            "curl -fsSL https://eta.test/remote/install.sh | sh -s -- etae_new",
        });
      }
      return Response.json(outdated);
    });
    await renderSettings();
    await act(settle);
    expect(document.body.textContent).toContain("connector 0.1.0，需要更新");
    expect(document.body.textContent).toContain("Eta 提供的版本 0.2.0");
    await act(async () => {
      buttons("更新")[0].click();
      await settle();
    });
    expect(posted).toEqual(["/api/v1/computers/c1/install"]);
    expect(document.body.textContent).toContain("etae_new");
    expect(document.body.textContent).toContain("（0.2.0）");
    expect(document.body.textContent).toContain("不需要重新配对");
    expect(document.body.textContent).toContain("connector 0.1.0，需要更新");
  });
});

// The laptop works on 3 runs, its limit; 2 more wait.
const busy = {
  ...outdated,
  computers: [
    {
      ...outdated.computers[0],
      active_runs: 3,
      max_active_runs: 3,
      queued_runs: 2,
    },
  ],
} as unknown as Computers;

const type = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("a computer's limit on runs at once", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    rstest.restoreAllMocks();
  });

  it("shows the load and queue, and saves only a whole number in range", async () => {
    const saved: unknown[] = [];
    rstest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request;
      if (request.method === "PUT") {
        saved.push([new URL(request.url).pathname, await request.json()]);
        return new Response(null, { status: 204 });
      }
      return Response.json(busy);
    });
    await renderSettings();
    await act(settle);
    expect(document.body.textContent).toContain("并发执行 3/3 · 排队 2");
    expect(document.body.textContent).toContain("已满，新的运行排队等名额");
    await act(async () => {
      buttons("调整上限")[0].click();
      await settle();
    });
    expect(document.body.textContent).toContain("协助和审查各算一个");
    const input = document.querySelector<HTMLInputElement>("#limit-c1")!;
    expect(input.value).toBe("3");
    const save = () => buttons("保存")[0];
    for (const bad of ["0", "21", "1.5", ""]) {
      await act(async () => type(input, bad));
      expect(save().disabled).toBe(true);
      expect(document.body.textContent).toContain("1 到 20 之间的整数");
    }
    await act(async () => type(input, "5"));
    expect(save().disabled).toBe(false);
    await act(async () => {
      save().click();
      await settle();
    });
    expect(saved).toEqual([
      ["/api/v1/computers/c1/limit", { max_active_runs: 5 }],
    ]);
  });
});
