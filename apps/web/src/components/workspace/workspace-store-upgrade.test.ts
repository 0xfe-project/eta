import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { applyCustomFont, watchCustomFont } from "@/lib/custom-font";
import { storageKey, useWorkspaceStore } from "./workspace-store";

/**
 * `eta.workspace.v1` across the upgrade: what a v0.3.0 build left in a browser, read by this one.
 *
 * The persisted state is the browser's, not the host's, so it only changes when a page starts
 * keeping something new. What has to hold then, and holds now, is that a state written before a
 * field existed still loads, keeps every value it had, and comes back the same after the page has
 * written once — and that a field this build has no schema for costs only itself.
 *
 * #607's two font fields are known fields in this tree, so they are covered from their own side:
 * the state a v0.3.0 build wrote, plus the fonts — two fields that build never wrote.
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

/**
 * The same save, once #607 was in a build: two names the v0.3.0 one never wrote. They go beside
 * `WRITTEN_BY_0_3_0` rather than in it — that shape is what 0.3.0 actually left in a browser.
 */
const WRITTEN_BY_0_3_0_WITH_FONTS = {
  ...WRITTEN_BY_0_3_0,
  customFont: "Inter",
  customMonoFont: "JetBrains Mono",
};

const KEPT_WITH_FONTS = {
  ...KEPT,
  customFont: "Inter",
  customMonoFont: "JetBrains Mono",
};

const written = (): unknown => JSON.parse(localStorage.getItem(storageKey)!);

const root = (): HTMLElement => document.documentElement;

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
    // The state is per browser and outlives any one build, so a newer build — or a hand edit —
    // may have left a field this one has no schema for. The schema drops what it does not know;
    // what it drops has to cost only itself. Named as nothing real on purpose: a field this build
    // *does* know gets kept, which is the fonts' own story below.
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...WRITTEN_BY_0_3_0,
        someFieldOnlyAFutureBuildKeeps: "anything",
      }),
    );
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspace).toEqual(KEPT);
  });

  describe("a known field that fails its own schema costs only itself", () => {
    // A hand edit, or a build that wrote a field badly: the field goes, its siblings stay.
    const cases: [string, Record<string, unknown>][] = [
      ["customFont that is not a string", { customFont: 42 }],
      ["customFont over 64 characters", { customFont: "a".repeat(65) }],
      ["customMonoFont that is not a string", { customMonoFont: 42 }],
      ["customMonoFont over 64 characters", { customMonoFont: "a".repeat(65) }],
      ["chatWidth outside its choices", { chatWidth: "wide" }],
      ["recentDirectories that is a list", { recentDirectories: ["/code"] }],
      ["selectedGroupId that is a number", { selectedGroupId: 5 }],
    ];
    for (const [name, bad] of cases) {
      it(name, async () => {
        localStorage.setItem(
          storageKey,
          JSON.stringify({ ...WRITTEN_BY_0_3_0_WITH_FONTS, ...bad }),
        );
        await useWorkspaceStore.persist.rehydrate();
        const workspace = useWorkspaceStore.getState().workspace;
        const [field] = Object.keys(bad);
        const rest = Object.fromEntries(
          Object.entries(KEPT_WITH_FONTS).filter(([key]) => key !== field),
        );
        expect(workspace).toEqual(rest);
        expect(field! in workspace).toBe(false);
        if (field !== "selectedGroupId") {
          expect(workspace.selectedGroupId).toBe("grp-eta");
        }
      });
    }

    it("several bad fields each cost only themselves", async () => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          ...WRITTEN_BY_0_3_0_WITH_FONTS,
          customFont: 42,
          customMonoFont: "a".repeat(65),
          chatWidth: "wide",
        }),
      );
      await useWorkspaceStore.persist.rehydrate();
      const rest = Object.fromEntries(
        Object.entries(KEPT_WITH_FONTS).filter(
          ([key]) =>
            !["customFont", "customMonoFont", "chatWidth"].includes(key),
        ),
      );
      expect(useWorkspaceStore.getState().workspace).toEqual(rest);
      expect(useWorkspaceStore.getState().workspace.selectedGroupId).toBe(
        "grp-eta",
      );
    });
  });

  it("ignores what a crashed tab left instead of clearing the state", async () => {
    // A browser writes a value it was in the middle of four times a session; the half of one that
    // reached storage must not take the good state with it.
    for (const broken of ['{"chatWidth":', "", "null", "[]", '"x"', "42"]) {
      localStorage.setItem(storageKey, broken);
      useWorkspaceStore.setState({ workspace: KEPT });
      await useWorkspaceStore.persist.rehydrate();
      expect(useWorkspaceStore.getState().workspace).toEqual(KEPT);
    }
  });

  describe("the fonts #607 added, read from a save that predates them", () => {
    let stop: (() => void) | undefined;

    beforeEach(() => {
      // A bare document, so "was it applied?" below is about this test's state alone.
      applyCustomFont({});
    });

    afterEach(() => {
      stop?.();
      stop = undefined;
    });

    it("loads both fonts and keeps every old value", async () => {
      localStorage.setItem(
        storageKey,
        JSON.stringify(WRITTEN_BY_0_3_0_WITH_FONTS),
      );
      await useWorkspaceStore.persist.rehydrate();
      expect(useWorkspaceStore.getState().workspace).toEqual(KEPT_WITH_FONTS);
    });

    it("still has both fonts after the page writes once", async () => {
      localStorage.setItem(
        storageKey,
        JSON.stringify(WRITTEN_BY_0_3_0_WITH_FONTS),
      );
      await useWorkspaceStore.persist.rehydrate();
      useWorkspaceStore.getState().setWorkspace((state) => ({
        ...state,
        chatWidth: "full",
      }));
      expect(written()).toEqual({ ...KEPT_WITH_FONTS, chatWidth: "full" });
    });

    it("keeps a name it would never apply, and costs no other value", async () => {
      // A string the schema takes — it is a string, and under 64 — that the font's own allowlist
      // refuses: nothing here may end up on the document, and the rest of the state is untouched.
      const impostor = "Inter; background: red";
      localStorage.setItem(
        storageKey,
        JSON.stringify({ ...WRITTEN_BY_0_3_0, customFont: impostor }),
      );
      await useWorkspaceStore.persist.rehydrate();
      expect(useWorkspaceStore.getState().workspace).toMatchObject(KEPT);

      stop = watchCustomFont();
      expect(root().style.getPropertyValue("--font-sans")).toBe("");
      expect(root().dataset.customFont).toBeUndefined();
    });
  });
});
