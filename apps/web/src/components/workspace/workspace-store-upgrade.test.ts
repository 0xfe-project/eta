import { beforeEach, describe, expect, it } from "@rstest/core";
import { storageKey, useWorkspaceStore } from "./workspace-store";

/**
 * `eta.workspace.v1` across the upgrade: what a v0.3.0 build left in a browser, read by this one.
 *
 * The persisted state is the browser's, not the host's, so it only changes when a page starts
 * keeping something new — #607 adds a custom body and mono font. What has to hold then, and holds
 * now, is that a state written before a field existed still loads, keeps every value it had, and
 * comes back the same after the page has written once.
 *
 * #607 is not in this tree (`git grep customFont -- apps/web/src` finds nothing), so the font
 * fields are covered as an *unknown* field here — the same property, stated from the other side:
 * a field this build does not know must not cost the rest of the state. Their own assertions
 * belong here once the fields exist.
 */

/** Exactly what a v0.3.0 build wrote: every field it kept, and two it has dropped since. */
const WRITTEN_BY_0_3_0 = {
  selectedGroupId: "grp-eta",
  selectedAgentId: "agent-ada",
  lastModel: "claude-sonnet-4-5",
  reactGrab: false,
  transcriptRail: true,
  chatWidth: "narrow",
  agentsCollapsed: true,
  recentDirectories: {
    "machine-1": ["/home/eric/code/eta", "/tmp/scratch"],
  },
  stickyTargets: { "grp-eta": ["agent-ada"], "grp-ops": "everyone" },
  // Kept by that build, dropped since: the list/board switch it replaced with the board, and the
  // theme codex kept in its own storage.
  taskLayout: "board",
  sessionTheme: "codex",
};

/** The fields this build keeps, with the values above: what has to survive. */
const KEPT = {
  selectedGroupId: "grp-eta",
  selectedAgentId: "agent-ada",
  lastModel: "claude-sonnet-4-5",
  reactGrab: false,
  transcriptRail: true,
  chatWidth: "narrow" as const,
  agentsCollapsed: true,
  recentDirectories: { "machine-1": ["/home/eric/code/eta", "/tmp/scratch"] },
  stickyTargets: { "grp-eta": ["agent-ada"], "grp-ops": "everyone" as const },
};

const written = (): unknown => JSON.parse(localStorage.getItem(storageKey)!);

describe("the workspace a v0.3.0 browser saved, read by this one", () => {
  beforeEach(async () => {
    localStorage.clear();
    useWorkspaceStore.setState({ workspace: {} });
  });

  it("loads without losing a value", async () => {
    localStorage.setItem(storageKey, JSON.stringify(WRITTEN_BY_0_3_0));
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toEqual(KEPT);
  });

  it("still has every old value after the page writes once", async () => {
    localStorage.setItem(storageKey, JSON.stringify(WRITTEN_BY_0_3_0));
    await useWorkspaceStore.persist.rehydrate();
    // A page writing the way every setting does: one field, through the store.
    useWorkspaceStore.getState().setWorkspace((state) => ({
      ...state,
      chatWidth: "full",
    }));
    expect(written()).toEqual({ ...KEPT, chatWidth: "full" });
  });

  it("does not let a field it does not know cost the rest of the state", async () => {
    // The shape #607 puts in the same key, read by a build that predates it, and the reverse of
    // it: either way the fields both builds know have to come through.
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...WRITTEN_BY_0_3_0,
        customFont: "Inter, sans-serif",
        customMonoFont: "JetBrains Mono, monospace",
      }),
    );
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toEqual(KEPT);
  });

  it("ignores what a crashed tab left instead of clearing the state", async () => {
    // A browser writes a value it was in the middle of four times a session; the half of one that
    // reached storage must not take the good state with it.
    for (const broken of ['{"chatWidth":', "", "null", "[]"]) {
      localStorage.setItem(storageKey, broken);
      useWorkspaceStore.setState({ workspace: KEPT });
      await useWorkspaceStore.persist.rehydrate();
      expect(useWorkspaceStore.getState().workspace).toEqual(KEPT);
    }
  });
});
