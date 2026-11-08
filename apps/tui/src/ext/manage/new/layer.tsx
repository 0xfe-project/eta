import type {
  ConversationSummary,
  ProjectResults,
  ProjectView,
} from "@eta/client-contracts";
import type { WireState } from "../../../connection/types";
import type { LayerHandle } from "../../../extensions/types";
import type { Translate as TranslateOf } from "../../../i18n/messages";
import type { Row } from "../../../ui/components/row-list";
import type { MemberPick } from "../member-pick";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { WireError } from "../../../connection/wire";
import {
  agentsOf,
  machinesOf,
  projectsOf,
} from "../../../extensions/eager-lists";
import { hostHas } from "../../../extensions/host-ops";
import { useInputActive, useShell, useTheme } from "../../../extensions/react";
import { useMessages } from "../../../i18n/react";
import { LayerFrame } from "../../../ui/components/layer-frame";
import { gateAllows, useActionGate } from "../../../ui/components/layer-space";
import { LineInput } from "../../../ui/components/line-input";
import { useListHeight } from "../../../ui/components/row-cursor";
import { RowList } from "../../../ui/components/row-list";
import { inkColor } from "../../../ui/theme";
import { CONVERSATION_VIEW } from "../../conversation/kind";
import { primaryMachine, startableProjects } from "../facts";
import { chooseSteward, initialPick, toggleMember } from "../member-pick";
import { manageMessages } from "../messages";
import { childPath } from "../paths";
import { projectRow } from "./rows";

type Listing = ProjectResults["directories"];
type Translate = TranslateOf<keyof (typeof manageMessages)["en"]>;

/** Where the conversation goes: a project the host has, or a directory to make one of. */
type Place =
  | { kind: "project"; projectId: string; stewardId: string | null }
  | { kind: "directory"; path: string };

type WhereView = "projects" | "type" | "browse";

const COMMAND = "new";

/**
 * The keys of the fixed lines of the first step. A project's line has the project's id and a
 * directory's line the directory's name: neither can look like these.
 */
const TYPE_LINE = "\0type";
const BROWSE_LINE = "\0browse";
const USE_LINE = "\0use";

/**
 * The project a conversation can start in at exactly `path` on the primary machine. An archived
 * project or an agent's workspace there is none: the start goes through `projects.create`, which
 * brings an archived one back.
 */
function startableAt(state: WireState, path: string): ProjectView | undefined {
  const primary = primaryMachine(state)?.id;
  return startableProjects(state).find(
    (project) =>
      project.path === path &&
      (primary === undefined || project.machineId === primary),
  );
}

/**
 * The project a conversation can start in at `path`, from the project list or from what a
 * listing said is there.
 */
function projectAt(
  state: WireState,
  known: ReadonlyMap<string, string>,
  path: string,
): ProjectView | undefined {
  const listed = startableAt(state, path);
  if (listed !== undefined) return listed;
  const id = known.get(path);
  return id === undefined
    ? undefined
    : startableProjects(state).find((project) => project.id === id);
}

function placeOf(project: ProjectView): Place {
  return {
    kind: "project",
    projectId: project.id,
    stewardId: project.stewardId,
  };
}

/**
 * Whether the project list has a project at `path` on the primary machine that is not a project a
 * conversation starts in (an agent's own workspace), archived or not.
 */
function workspaceAt(state: WireState, path: string): boolean {
  const primary = primaryMachine(state)?.id;
  return projectsOf(state).some(
    (project) =>
      project.path === path &&
      project.kind !== "project" &&
      (primary === undefined || project.machineId === primary),
  );
}

/** A directory that is an agent's own workspace, which a group conversation cannot start in. */
class NotStartable extends Error {}

/** A listing failure in the user's words: the host's problem code when it has one. */
function listingError(error: unknown, path: string, t: Translate): string {
  const code = error instanceof WireError ? error.problem?.code : undefined;
  if (code === "not_found") return t("notFound", { path });
  if (code === "denied") return t("denied", { path });
  if (code === "offline") return t("offline");
  return error instanceof Error ? error.message : String(error);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `/new`: where (a project, or a directory on the primary machine, typed or browsed to), then who
 * (the members and the steward), then start. `startPath` is taken as typed. Nothing is written to
 * the host before starting; a start that fails keeps the layer, with the error, and a retry reuses
 * a project already made.
 */
export function NewConversationLayer({
  startPath,
  handle,
}: {
  startPath: string | undefined;
  handle: LayerHandle;
}) {
  const ctx = useShell();
  const { wire } = ctx;
  const t = useMessages(manageMessages);
  const theme = useTheme();
  const active = useInputActive();
  const height = useListHeight(3);
  const gate = useActionGate();

  useEffect(() => {
    const releases = ["projects", "machines"].map((target) =>
      wire.subscribe(target),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [wire]);
  const agents = useStore(wire.store, agentsOf);
  const projects = useStore(wire.store, (state) => state.targets.projects);
  const machines = useStore(wire.store, (state) => state.targets.machines);
  const state = wire.store.getState();
  const startable = projects === undefined ? [] : startableProjects(state);
  const primaryId =
    machines === undefined ? undefined : primaryMachine(state)?.id;

  const [step, setStep] = useState<"where" | "who">("where");
  const [view, setView] = useState<WhereView>(
    startPath === undefined ? "projects" : "type",
  );
  const [typed, setTyped] = useState(startPath ?? "");
  // The second step's cursor is a line number; the first step's is the line's key, so a line
  // that comes in above it (a project pushed to the list) does not move it to another line.
  const [cursor, setCursor] = useState(0);
  const [whereKey, setWhereKey] = useState<string | undefined>();
  const [listing, setListing] = useState<Listing | undefined>();
  const [browseError, setBrowseError] = useState<string | undefined>();
  const knownProjectsRef = useRef(new Map<string, string>());
  const askedRef = useRef(0);

  const [place, setPlace] = useState<Place | undefined>();
  const [pick, setPick] = useState<MemberPick>({
    checked: [],
    steward: undefined,
  });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | undefined>();
  const madeProjectRef = useRef<{ path: string; id: string } | undefined>(
    undefined,
  );

  /** Lists `path`, or home when undefined. */
  const browse = (path: string | undefined) => {
    if (!hostHas(ctx, "projects.directories", COMMAND)) return;
    const request = ++askedRef.current;
    ctx.reportFailure(
      wire
        .call<Listing>(
          "projects",
          "directories",
          path === undefined ? {} : { path },
        )
        .then(
          (result) => {
            if (request !== askedRef.current) return;
            for (const entry of result.entries)
              if (entry.projectId !== null)
                knownProjectsRef.current.set(
                  childPath(result.path, entry.name),
                  entry.projectId,
                );
            setListing(result);
            setWhereKey(undefined);
            setBrowseError(undefined);
          },
          (error: unknown) => {
            if (request !== askedRef.current) return;
            setBrowseError(listingError(error, path ?? "~", t));
          },
        ),
    );
  };

  const agentIds = agents.map((agent) => agent.id);

  // A ref as well as the state: a second Enter can come before the state re-renders.
  const inFlightRef = useRef(false);
  const start = (chosen: Place, members: MemberPick) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setStarting(true);
    setStartError(undefined);
    const run = async () => {
      let projectId: string;
      // A typed path may name a project the list brought in after it was chosen.
      const listed =
        chosen.kind === "directory"
          ? startableAt(wire.store.getState(), chosen.path)
          : undefined;
      if (chosen.kind === "project") projectId = chosen.projectId;
      else if (listed !== undefined) projectId = listed.id;
      else if (madeProjectRef.current?.path === chosen.path)
        projectId = madeProjectRef.current.id;
      else {
        // Asking the host would bring an archived workspace back before refusing it.
        if (workspaceAt(wire.store.getState(), chosen.path))
          throw new NotStartable();
        if (!hostHas(ctx, "projects.create", COMMAND)) return false;
        const { project } = await wire.call<{ project: ProjectView }>(
          "projects",
          "create",
          {
            path: chosen.path,
            ...(primaryId === undefined ? {} : { machineId: primaryId }),
            ...(members.steward === undefined
              ? {}
              : { stewardId: members.steward }),
          },
        );
        // An agent's workspace answers for its path: it is that agent's own, not a project.
        if (project.kind !== "project") throw new NotStartable();
        madeProjectRef.current = { path: chosen.path, id: project.id };
        projectId = project.id;
      }
      if (!hostHas(ctx, "conversations.create", COMMAND)) return false;
      const { conversation } = await wire.call<{
        conversation: ConversationSummary;
      }>("conversations", "create", {
        projectId,
        agentIds: members.checked,
        ...(members.steward === undefined
          ? {}
          : { stewardId: members.steward }),
      });
      handle.close();
      ctx.openTab({ kind: CONVERSATION_VIEW, id: conversation.id });
      ctx.notify(t("created", { name: conversation.name }), "info");
      return true;
    };
    run().then(
      (done) => {
        if (done) return;
        inFlightRef.current = false;
        setStarting(false);
      },
      (error: unknown) => {
        inFlightRef.current = false;
        setStarting(false);
        setStartError(
          error instanceof NotStartable
            ? t("agentWorkspace")
            : errorText(error),
        );
      },
    );
  };

  /** A place is chosen: ask who, or start at once with the only agent. */
  const choose = (chosen: Place) => {
    if (
      chosen.kind === "directory" &&
      workspaceAt(wire.store.getState(), chosen.path)
    ) {
      setStartError(t("agentWorkspace"));
      return;
    }
    const only = agentIds.length === 1 ? agentIds[0] : undefined;
    if (only !== undefined) {
      setPlace(chosen);
      start(chosen, { checked: [only], steward: only });
      return;
    }
    setPlace(chosen);
    setPick(
      initialPick(
        agentIds,
        chosen.kind === "project" ? chosen.stewardId : undefined,
      ),
    );
    setStartError(undefined);
    setStep("who");
    setCursor(0);
  };

  /** A typed path: the project the list has there, or the directory to make one of. */
  const chooseTyped = (text: string) => {
    const path = text.trim();
    if (path === "") return;
    const project = startableAt(wire.store.getState(), path);
    choose(
      project === undefined ? { kind: "directory", path } : placeOf(project),
    );
  };

  // The latest `chooseTyped`, for the one choice of the path `/new` was given.
  const chooseTypedRef = useRef(chooseTyped);
  chooseTypedRef.current = chooseTyped;
  useEffect(() => {
    if (startPath !== undefined) chooseTypedRef.current(startPath);
  }, [startPath]);

  const visibleEntries = (listing?.entries ?? []).filter(
    (entry) => !entry.hidden,
  );

  const whereRows: Row[] =
    view === "type"
      ? []
      : view === "projects"
        ? [
            ...startable.map((project) =>
              projectRow(project, machinesOf(state), primaryId),
            ),
            { key: TYPE_LINE, label: t("typePath") },
            { key: BROWSE_LINE, label: t("browse") },
          ]
        : listing === undefined
          ? []
          : [
              { key: USE_LINE, label: t("useDirectory") },
              ...visibleEntries.map((entry) => {
                const notes = [
                  ...(entry.git ? [t("tagGit")] : []),
                  ...(entry.projectId !== null ? [t("tagProject")] : []),
                ];
                return {
                  key: entry.name,
                  label: entry.name,
                  ...(notes.length === 0 ? {} : { note: notes.join("  ") }),
                };
              }),
            ];

  const whoRows: Row[] = agents.map((agent) => ({
    key: agent.id,
    label: `${pick.checked.includes(agent.id) ? "[x]" : "[ ]"} ${agent.name}`,
    ...(pick.steward === agent.id ? { note: t("stewardTag") } : {}),
  }));

  const rows = step === "who" ? whoRows : whereRows;
  const at =
    step === "who"
      ? Math.min(cursor, Math.max(0, rows.length - 1))
      : Math.max(
          0,
          whereRows.findIndex((row) => row.key === whereKey),
        );
  const moveTo = (index: number) => {
    if (step === "who") setCursor(index);
    else setWhereKey(rows[index]?.key);
  };

  const onWhereEnter = () => {
    const key = rows[at]?.key;
    if (view === "projects") {
      const project = startable.find((p) => p.id === key);
      if (project !== undefined) {
        choose(placeOf(project));
        return;
      }
      if (key === TYPE_LINE) {
        setView("type");
        setStartError(undefined);
        return;
      }
      setView("browse");
      setListing(undefined);
      setBrowseError(undefined);
      setWhereKey(undefined);
      browse(undefined);
      return;
    }
    if (listing === undefined) return;
    if (key === USE_LINE) {
      const project = projectAt(state, knownProjectsRef.current, listing.path);
      choose(
        project === undefined
          ? { kind: "directory", path: listing.path }
          : placeOf(project),
      );
      return;
    }
    const entry = visibleEntries.find((e) => e.name === key);
    if (entry !== undefined) browse(childPath(listing.path, entry.name));
  };

  useInput(
    (input, key) => {
      if (inFlightRef.current) return;
      // The text field takes the keys of its own view.
      if (step === "where" && view === "type") return;
      if (key.upArrow) moveTo(Math.max(0, at - 1));
      else if (key.downArrow)
        moveTo(Math.min(Math.max(0, rows.length - 1), at + 1));
      else if (step === "who") {
        const agent = agents[at];
        if (key.escape) {
          setStep("where");
          setStartError(undefined);
          setWhereKey(undefined);
        } else if (input === " " && agent !== undefined) {
          if (gateAllows(gate)) setPick(toggleMember(pick, agentIds, agent.id));
        } else if (input === "s" && agent !== undefined)
          setPick(chooseSteward(pick, agent.id));
        else if (key.return && place !== undefined) {
          if (!gateAllows(gate)) return;
          if (pick.checked.length === 0) setStartError(t("needMember"));
          else start(place, pick);
        }
      } else if (key.escape) {
        if (view === "browse") {
          setView("projects");
          setBrowseError(undefined);
          setStartError(undefined);
          setWhereKey(undefined);
        } else handle.close();
      } else if (key.return) {
        if (gateAllows(gate)) onWhereEnter();
      } else if (
        view === "browse" &&
        (key.leftArrow || key.backspace || key.delete) &&
        listing?.parent != null
      )
        browse(listing.parent);
    },
    { isActive: active },
  );

  const footer =
    step === "who"
      ? t("whoFooter")
      : view === "browse"
        ? t("browseFooter")
        : view === "type"
          ? t("typeFooter")
          : t("whereFooter");
  const errorLine = (text: string | undefined) =>
    text === undefined ? null : (
      <Text color={inkColor(theme.error)} wrap="truncate-end">
        {text}
      </Text>
    );

  return (
    <LayerFrame title={t("newTitle")} footer={footer}>
      <Text bold>{step === "who" ? t("whoHeading") : t("whereHeading")}</Text>
      {step === "where" && view === "browse" && (
        <Text color={inkColor(theme.muted)} wrap="truncate-start">
          {listing?.path ?? t("loading")}
        </Text>
      )}
      {step === "where" && view === "type" ? (
        <Text>
          {"› "}
          <LineInput
            value={typed}
            onChange={setTyped}
            onSubmit={chooseTyped}
            onEscape={() => {
              setView("projects");
              setStartError(undefined);
              setWhereKey(TYPE_LINE);
            }}
            focused={!starting}
          />
        </Text>
      ) : (
        <Box flexDirection="column">
          <RowList rows={rows} cursor={at} height={height} gate={gate} />
        </Box>
      )}
      {step === "where" && view === "browse" && listing?.truncated === true && (
        <Text color={inkColor(theme.muted)}>{t("truncated")}</Text>
      )}
      {step === "where" &&
        view === "browse" &&
        errorLine(
          browseError === undefined
            ? undefined
            : `${browseError}  ${t("typeInstead")}`,
        )}
      {starting ? (
        <Text color={inkColor(theme.muted)}>{t("starting")}</Text>
      ) : (
        errorLine(startError)
      )}
    </LayerFrame>
  );
}
