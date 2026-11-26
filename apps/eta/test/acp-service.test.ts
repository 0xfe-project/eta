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

function setup() {
  const calls: Pending[] = [];
  const link = {
    daemon: (method: string, params: unknown) =>
      new Promise((resolve) => calls.push({ method, params, resolve })),
  };
  let online = true;
  const box = {
    id: "m-box",
    kind: "daemon" as const,
    name: "box",
    status: "online" as const,
  };
  const service = new AcpService({
    local: undefined,
    machines: {
      get: (id) => (id === box.id ? box : undefined),
      primary: () => undefined,
    },
    link: () => (online ? (link as never) : undefined),
    agents: () => [],
    changed: () => undefined,
  });
  /** The oldest call still waiting with this method (and `settled`, for a list). */
  const take = (method: string, settled?: boolean): Pending => {
    const at = calls.findIndex(
      (call) =>
        call.method === method &&
        (settled === undefined ||
          ((call.params as { settled?: boolean }).settled === true) ===
            settled),
    );
    if (at < 0) throw new Error(`no pending ${method} (settled=${settled})`);
    return calls.splice(at, 1)[0]!;
  };
  const shown = (): AcpMachineList | undefined => service.lists()[box.id];
  return {
    service,
    box,
    take,
    shown,
    goOffline: () => {
      online = false;
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
});
