/**
 * `AcpService`'s cache of a daemon's list, against a link whose answers this test releases by
 * hand: an answer that left before a change, or before a newer fetch, never overwrites what came
 * after it, however late it arrives.
 */
import type { AcpAgentView, AcpMachineList } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { AcpService } from "../src/acp/service";

interface Pending {
  method: string;
  params: unknown;
  resolve: (value: unknown) => void;
}

const view = (id: string, extra: Partial<AcpAgentView> = {}): AcpAgentView => ({
  id,
  label: id,
  command: "x",
  args: [],
  env: {},
  runtime: `acp.${id}`,
  status: "available",
  ...extra,
});

const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup(
  options: {
    agents?: {
      id: string;
      name: string;
      runtime: string;
      machineId: string | null;
      systemRole?: "captain" | null;
    }[];
    rejectDelete?: boolean;
    onDeleteAgent?: (agentId: string, reason: string) => void;
  } = {},
) {
  const calls: Pending[] = [];
  const link = {
    daemon: (method: string, params: unknown) =>
      new Promise((resolve, reject) =>
        calls.push({ method, params, resolve, reject } as Pending & {
          reject: (e: unknown) => void;
        }),
      ),
  };
  let online = true;
  const box = {
    id: "m-box",
    kind: "daemon" as const,
    name: "box",
    status: "online" as const,
  };
  const deletedList: string[] = [];
  const service = new AcpService({
    local: undefined,
    machines: {
      get: (id) => (id === box.id ? box : undefined),
      primary: () => undefined,
    },
    link: () => (online ? (link as never) : undefined),
    agents: () =>
      (options.agents ?? []).filter((a) => !deletedList.includes(a.id)),
    groupCountOf: () => 2,
    isAgentBusy: (id) => id === "a-busy",
    deleteAgent: (agentId, reason) => {
      deletedList.push(agentId);
      options.onDeleteAgent?.(agentId, reason);
    },
    changed: () => undefined,
  });
  /** The oldest call still waiting with this method (and `settled`, for a list). */
  const take = (
    method: string,
    settled?: boolean,
  ): Pending & { reject: (e: unknown) => void } => {
    const at = calls.findIndex(
      (call) =>
        call.method === method &&
        (settled === undefined ||
          ((call.params as { settled?: boolean }).settled === true) ===
            settled),
    );
    if (at < 0) throw new Error(`no pending ${method} (settled=${settled})`);
    return calls.splice(at, 1)[0] as Pending & { reject: (e: unknown) => void };
  };
  const shown = (): AcpMachineList | undefined => service.lists()[box.id];
  return {
    service,
    box,
    take,
    shown,
    goOffline: () => {
      online = false;
      box.status = "offline" as never;
    },
  };
}

describe("a daemon's list in the host's cache", () => {
  it("is not put back to before a save by a look that answers late", async () => {
    const { service, box, take, shown } = setup();
    // Opening the page: the list now, and a look that is slow to answer.
    const refreshed = service.refresh(box.id);
    await tick();
    take("acpList", false).resolve({ agents: [] });
    expect(await refreshed).toEqual({ agents: [] });
    await tick();
    const oldLook = take("acpList", true);

    // The user saves; the list after it arrives.
    const saved = service.save(box.id, { id: "fake", command: "x" });
    await tick();
    take("acpSave").resolve(view("fake"));
    await saved;
    await tick();
    take("acpList", false).resolve({ agents: [view("fake")] });
    await tick();
    expect(shown()).toEqual({ agents: [view("fake")] });

    // Only now does the old look answer, with the list from before the save.
    oldLook.resolve({ agents: [] });
    await tick();
    expect(shown()).toEqual({ agents: [view("fake")] });

    // The new look still lands.
    take("acpList", true).resolve({
      agents: [view("fake", { version: "0.0.1" })],
    });
    await tick();
    expect(shown()).toEqual({ agents: [view("fake", { version: "0.0.1" })] });
  });

  it("is not put back by a look that left before a delete", async () => {
    const { service, box, take, shown } = setup();
    const refreshed = service.refresh(box.id);
    await tick();
    take("acpList", false).resolve({ agents: [view("fake")] });
    await refreshed;
    await tick();
    const oldLook = take("acpList", true);
    const deleted = service.delete(box.id, "fake");
    await tick();
    take("acpDelete").resolve({});
    await deleted;
    await tick();
    take("acpList", false).resolve({ agents: [] });
    await tick();
    oldLook.resolve({ agents: [view("fake")] });
    await tick();
    expect(shown()).toEqual({ agents: [] });
  });

  it("takes nothing from before the machine went offline", async () => {
    const { service, box, take, shown, goOffline } = setup();
    const refreshed = service.refresh(box.id);
    await tick();
    take("acpList", false).resolve({ agents: [view("fake")] });
    await refreshed;
    await tick();
    const oldLook = take("acpList", true);
    goOffline();
    expect(shown()).toBeUndefined();
    oldLook.resolve({ agents: [view("fake")] });
    await tick();
    expect(shown()).toBeUndefined();
  });

  it("previews dependent agents and deletes acp.json before cascade-deleting agents", async () => {
    const events: string[] = [];
    const { service, box, take } = setup({
      agents: [
        { id: "a-busy", name: "Ace", runtime: "acp.fake", machineId: "m-box" },
        {
          id: "a-other",
          name: "Other",
          runtime: "acp.other",
          machineId: "m-box",
        },
      ],
      onDeleteAgent: (id) => events.push(`deleteAgent:${id}`),
    });
    expect(service.deletePreview(box.id, "fake")).toEqual({
      id: "fake",
      machineId: box.id,
      agents: [
        {
          id: "a-busy",
          name: "Ace",
          runtime: "acp.fake",
          groupCount: 2,
          busy: true,
        },
      ],
    });
    // Without deleteAgents, deletion is refused before touching daemon.
    await expect(service.delete(box.id, "fake")).rejects.toThrow(
      /Cannot delete fake/,
    );
    expect(events).toEqual([]);

    // With deleteAgents: acpDelete runs first; agents are deleted only after it resolves.
    const deleting = service.delete(box.id, "fake", { deleteAgents: true });
    await tick();
    expect(events).toEqual([]);
    const call = take("acpDelete");
    call.resolve({});
    expect(await deleting).toEqual({ deletedAgents: ["a-busy"] });
    expect(events).toEqual(["deleteAgent:a-busy"]);
  });

  it("never deletes dependent agents when daemon acpDelete fails or machine is offline", async () => {
    const events: string[] = [];
    const { service, box, take, goOffline } = setup({
      agents: [
        { id: "a-1", name: "Ace", runtime: "acp.fake", machineId: "m-box" },
      ],
      onDeleteAgent: (id) => events.push(id),
    });
    const failing = service.delete(box.id, "fake", { deleteAgents: true });
    await tick();
    take("acpDelete").reject(new Error("write failed"));
    await expect(failing).rejects.toThrow(/write failed/);
    expect(events).toEqual([]);

    goOffline();
    await expect(
      service.delete(box.id, "fake", { deleteAgents: true }),
    ).rejects.toThrow(/offline/);
    expect(events).toEqual([]);
  });
});
