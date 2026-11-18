import type { FlowMachine, PlaceRef } from "../src";
import { describe, expect, it } from "vitest";
import {
  back,
  buildSuggestions,
  chooseMachine,
  chooseMethod,
  chooseNewParent,
  chooseRepo,
  cloneUrlOf,
  compareMatchScores,
  currentPage,
  foldsCase,
  isOpenablePath,
  machineOptions,
  manualRepoChoices,
  methodOptions,
  moveActive,
  moveSelection,
  openBrowse,
  openFlow,
  repoName,
  scorePathMatch,
  setActive,
  setBusy,
  setError,
  setMachines,
  setQuery,
  setShowHidden,
} from "../src";

const primary: FlowMachine = {
  id: "m1",
  name: "studio",
  kind: "primary",
  status: "online",
};
const box: FlowMachine = {
  id: "m2",
  name: "gpu-box",
  kind: "daemon",
  status: "online",
};
const attic: FlowMachine = {
  id: "m3",
  name: "attic",
  kind: "daemon",
  status: "offline",
};
const nas: FlowMachine = {
  id: "m4",
  name: "nas",
  kind: "ssh",
  status: "online",
};
const ref = (path: string, display = path): PlaceRef => ({ path, display });

describe("the matcher", () => {
  it("ranks exact, whole word, prefix, word start, substring, then scattered", () => {
    const tiers = ["eta", "my eta", "etalon", "x-etab", "beta", "e-t-a"].map(
      (text) => scorePathMatch("eta", text)?.tier,
    );
    expect(tiers).toEqual([0, 1, 2, 3, 4, 5]);
    expect(scorePathMatch("zz", "eta")).toBeNull();
  });

  it("matches across separators when the text does not match as typed", () => {
    expect(
      scorePathMatch("eta web", "~/Developer/eta/apps/web"),
    ).not.toBeNull();
    expect(scorePathMatch("ETA", "~/Developer/eta")).toMatchObject({
      offset: 12,
    });
    const a = scorePathMatch("dev", "~/src/my-dev-box")!;
    const b = scorePathMatch("dev", "~/Developer")!;
    expect(compareMatchScores(a, b)).toBeLessThan(0);
  });
});

describe("what can be opened as typed", () => {
  it("goes by the machine's system, not the client's", () => {
    expect(isOpenablePath("/srv/x", "posix")).toBe(true);
    expect(isOpenablePath("~", "posix")).toBe(true);
    expect(isOpenablePath("~/x", "win32")).toBe(true);
    expect(isOpenablePath("~\\x", "win32")).toBe(true);
    expect(isOpenablePath("C:\\x", "win32")).toBe(true);
    expect(isOpenablePath("c:/x", "win32")).toBe(true);
    expect(isOpenablePath("\\\\nas\\share", "win32")).toBe(true);
    expect(isOpenablePath("C:\\x", "posix")).toBe(false);
    expect(isOpenablePath("\\\\nas\\share", "posix")).toBe(false);
    expect(isOpenablePath("/srv/x", "win32")).toBe(false);
    expect(isOpenablePath("eta", "posix")).toBe(false);
  });
});

describe("suggestions", () => {
  const recent = [
    ref("/h/Developer/eta", "~/Developer/eta"),
    ref("/h/Developer/axp", "~/Developer/axp"),
  ];
  const found = [
    ref("/h/src/etaweb", "~/src/etaweb"),
    ref("/h/Developer/eta", "~/Developer/eta"),
  ];

  it("lists only the recent ones with nothing typed", () => {
    expect(
      buildSuggestions({ query: " ", flavor: "posix", recent, found }),
    ).toEqual([
      { kind: "recent", place: recent[0] },
      { kind: "recent", place: recent[1] },
    ]);
  });

  it("filters the recent ones with the same matcher, then the machine's in its order, each once", () => {
    expect(
      buildSuggestions({ query: "eta", flavor: "posix", recent, found }),
    ).toEqual([
      { kind: "recent", place: recent[0] },
      { kind: "found", place: found[0] },
    ]);
  });

  it("tells /home from /Home where the machine does, and only there", () => {
    // Linux: `/Home` is there, `/home` is not; typing `/home` keeps its own row.
    const found = [ref("/Home", "/Home")];
    const linux = buildSuggestions({
      query: "/home",
      flavor: "posix",
      os: "linux",
      recent: [],
      found,
    });
    expect(linux.map((s) => s.kind)).toEqual(["typed", "found"]);
    // macOS and Windows fold case by default: it is the place listed already.
    const mac = buildSuggestions({
      query: "/home",
      flavor: "posix",
      os: "darwin",
      recent: [],
      found,
    });
    expect(mac.map((s) => s.kind)).toEqual(["found"]);
    const win = buildSuggestions({
      query: "c:\\users",
      flavor: "win32",
      os: "win32",
      recent: [],
      found: [ref("C:\\Users", "C:\\Users")],
    });
    expect(win.map((s) => s.kind)).toEqual(["found"]);
    expect(foldsCase("linux", "posix")).toBe(false);
    expect(foldsCase(undefined, "win32")).toBe(true);
  });

  it("matches what a person sees, not the home's own name", () => {
    const home = [ref("/home/eta-user/notes", "~/notes")];
    expect(
      buildSuggestions({
        query: "eta",
        flavor: "posix",
        recent: home,
        found: [],
      }),
    ).toEqual([]);
    expect(
      buildSuggestions({
        query: "not",
        flavor: "posix",
        recent: home,
        found: [],
      }),
    ).toHaveLength(1);
  });

  it("puts a typed path first, unless it is listed already", () => {
    const typed = buildSuggestions({
      query: "~/Developer/new-thing",
      flavor: "posix",
      recent,
      found: [],
    });
    expect(typed[0]).toEqual({ kind: "typed", path: "~/Developer/new-thing" });
    const listed = buildSuggestions({
      query: "~/Developer/eta/",
      flavor: "posix",
      recent,
      found: [found[1]!],
    });
    expect(listed.map((s) => s.kind)).toEqual(["recent"]);
    const win = buildSuggestions({
      query: "D:\\work",
      flavor: "win32",
      recent: [],
      found: [],
    });
    expect(win).toEqual([{ kind: "typed", path: "D:\\work" }]);
    expect(
      buildSuggestions({
        query: "D:\\work",
        flavor: "posix",
        recent: [],
        found: [],
      }),
    ).toEqual([]);
  });
});

describe("repositories typed by hand", () => {
  it("offers a URL as it is, and owner/repo by HTTPS and by SSH", () => {
    expect(
      manualRepoChoices("https://github.com/octocat/Hello-World.git"),
    ).toEqual([
      {
        id: "manual:https://github.com/octocat/Hello-World.git",
        nameWithOwner: "octocat/Hello-World",
        cloneUrl: "https://github.com/octocat/Hello-World.git",
        description: null,
        updatedAt: null,
      },
    ]);
    expect(manualRepoChoices("git@gitlab.com:a/b.git")[0]?.nameWithOwner).toBe(
      "b",
    );
    expect(
      manualRepoChoices("octocat/Spoon-Knife").map((c) => [c.id, c.protocol]),
    ).toEqual([
      ["manual:https:octocat/Spoon-Knife", "https"],
      ["manual:ssh:octocat/Spoon-Knife", "ssh"],
    ]);
    expect(manualRepoChoices("just words")).toEqual([]);
    expect(cloneUrlOf("a/b", "ssh")).toBe("git@github.com:a/b.git");
    expect(cloneUrlOf("a/b", "https")).toBe("https://github.com/a/b.git");
    expect(repoName("https://github.com/a/Hello-World.git")).toBe(
      "Hello-World",
    );
  });
});

describe("the flow", () => {
  it("skips the machine page when there is one machine, or the caller names one", () => {
    const one = openFlow({ machines: [primary] });
    expect(currentPage(one)).toMatchObject({ kind: "method", machineId: "m1" });
    expect(back(one)).toBeNull();
    const named = openFlow({ machines: [primary, box], machineId: "m2" });
    expect(currentPage(named)).toMatchObject({
      kind: "method",
      machineId: "m2",
    });
    expect(named.pages).toHaveLength(1);
    const many = openFlow({ machines: [primary, box] });
    expect(currentPage(many)).toMatchObject({ kind: "machine" });
    // The list arriving late leaves one: the machine page goes.
    const late = setMachines(openFlow({ machines: [] }), [primary]);
    expect(currentPage(late)).toMatchObject({
      kind: "method",
      machineId: "m1",
    });
  });

  it("greys out machines it cannot reach and says why, usable ones first", () => {
    expect(
      machineOptions([attic, nas, primary, box], "").map((o) => [
        o.machine.name,
        o.closed,
      ]),
    ).toEqual([
      ["studio", undefined],
      ["gpu-box", undefined],
      ["attic", "offline"],
      ["nas", "ssh"],
    ]);
    expect(
      machineOptions([primary, box], "gpu").map((o) => o.machine.id),
    ).toEqual(["m2"]);
  });

  it("goes machine → way → page, and Escape walks back the way it came", () => {
    let state = openFlow({ machines: [primary, box] });
    state = chooseMachine(state, "m2");
    state = chooseMethod(state, "m2", "search");
    expect(state.pages.map((p) => p.kind)).toEqual([
      "machine",
      "method",
      "search",
    ]);
    state = back(state)!;
    expect(currentPage(state).kind).toBe("method");
    state = back(state)!;
    expect(currentPage(state).kind).toBe("machine");
    expect(back(state)).toBeNull();
  });

  it("keeps what was typed on a page when going back and coming in again", () => {
    let state = openFlow({ machines: [primary, box] });
    state = setQuery(state, "gpu");
    state = setActive(state, 1);
    state = chooseMachine(state, "m2");
    state = chooseMethod(state, "m2", "search");
    state = setQuery(state, "eta web");
    state = back(state)!;
    state = chooseMethod(state, "m2", "search");
    expect(currentPage(state)).toMatchObject({
      kind: "search",
      query: "eta web",
    });
    state = back(state)!;
    state = back(state)!;
    expect(currentPage(state)).toMatchObject({
      kind: "machine",
      query: "gpu",
      activeIndex: 1,
    });
  });

  it("keeps a clone location per repository and a new name per parent", () => {
    let state = openFlow({ machines: [primary] });
    state = chooseMethod(state, "m1", "github");
    const [https] = manualRepoChoices("octocat/Hello-World");
    state = chooseRepo(state, https!);
    expect(currentPage(state)).toMatchObject({
      kind: "clone-location",
      repo: { id: https!.id },
      query: "",
    });
    state = setQuery(state, "~/src");
    state = back(state)!;
    state = chooseRepo(state, https!);
    expect(currentPage(state)).toMatchObject({ query: "~/src" });
    state = back(state)!;
    state = back(state)!;
    state = chooseMethod(state, "m1", "new");
    state = chooseNewParent(state, ref("/h/dev", "~/dev"));
    state = setQuery(state, "command-center");
    state = back(state)!;
    state = chooseNewParent(state, ref("/h/src", "~/src"));
    expect(currentPage(state)).toMatchObject({ kind: "new-name", query: "" });
    state = back(state)!;
    state = chooseNewParent(state, ref("/h/dev", "~/dev"));
    expect(currentPage(state)).toMatchObject({
      kind: "new-name",
      query: "command-center",
    });
  });

  it("walks a browse page in place, keeping whether hidden ones show", () => {
    let state = openFlow({ machines: [primary] });
    state = chooseMethod(state, "m1", "browse");
    expect(currentPage(state)).toMatchObject({
      kind: "browse",
      path: null,
      showHidden: false,
    });
    state = setShowHidden(state, true);
    state = openBrowse(state, "m1", "/h/dev");
    expect(state.pages.map((p) => p.kind)).toEqual(["method", "browse"]);
    expect(currentPage(state)).toMatchObject({
      path: "/h/dev",
      showHidden: true,
    });
    expect(currentPage(back(state)!).kind).toBe("method");
  });

  it("moves round the ends, over the rows that cannot be taken", () => {
    expect(moveSelection(2, [true, true, true], "next")).toBe(0);
    expect(moveSelection(0, [true, true, true], "previous")).toBe(2);
    expect(moveSelection(0, [true, false, true], "next")).toBe(2);
    expect(moveSelection(0, [false, false], "next")).toBe(0);
    let state = openFlow({ machines: [primary] });
    state = moveActive(state, [true, false, true, true], "next");
    expect(currentPage(state).activeIndex).toBe(2);
  });

  it("holds a page's busy state and its error until the next keystroke", () => {
    let state = openFlow({ machines: [primary] });
    state = chooseMethod(state, "m1", "search");
    state = setBusy(state, true);
    expect(currentPage(state)).toMatchObject({ busy: true, error: null });
    state = setError(state, { code: "not_found" });
    expect(currentPage(state)).toMatchObject({
      busy: false,
      error: { code: "not_found" },
    });
    state = setQuery(state, "x");
    expect(currentPage(state).error).toBeNull();
  });
});

describe("the ways", () => {
  it("are greyed out with a reason when the machine cannot", () => {
    expect(
      methodOptions(undefined).map((o) => [o.id, o.disabled, o.note]),
    ).toEqual([
      ["search", false, undefined],
      ["browse", false, undefined],
      ["github", true, "checking"],
      ["new", true, "checking"],
    ]);
    expect(
      methodOptions({ git: false, gh: "missing", mkdir: true }).find(
        (o) => o.id === "github",
      ),
    ).toEqual({ id: "github", disabled: true, note: "no_git" });
    expect(
      methodOptions({ git: true, gh: "signed_out", mkdir: true }).find(
        (o) => o.id === "github",
      ),
    ).toEqual({ id: "github", disabled: false, note: "paste_only" });
    expect(
      methodOptions(
        { git: true, gh: "ready", mkdir: false },
        { nativeBrowse: true },
      ).map((o) => o.note),
    ).toEqual([undefined, "native", undefined, "update"]);
  });
});
