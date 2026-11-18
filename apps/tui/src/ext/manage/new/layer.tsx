import type {
  ConversationSummary,
  PlaceFailure,
  PlaceResolved,
  ProjectView,
} from "@eta/client-contracts";
import type { WireState } from "../../../connection/types";
import type { LayerHandle } from "../../../extensions/types";
import type { Translate as TranslateOf } from "../../../i18n/messages";
import type { Row } from "../../../ui/components/row-list";
import type { MemberPick } from "../member-pick";
import type { TuiPlaceFlow } from "./place-flow";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
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
import { ordinaryAgents } from "../../kit/captain";
import { primaryMachine, startableProjects } from "../facts";
import { chooseSteward, initialPick, toggleMember } from "../member-pick";
import { manageMessages } from "../messages";
import { failureOf, PROBLEM_KEYS, usePlaceFlow } from "./place-flow";

type Translate = TranslateOf<keyof (typeof manageMessages)["en"]>;

/** Where the conversation goes: a project the host has, or a directory on a machine to make one of. */
type Place =
  | { kind: "project"; projectId: string }
  | { kind: "directory"; machineId: string; path: string };

const COMMAND = "new";

/** The key of the second step's last line, no steward: an agent id cannot look like it. */
const NO_STEWARD_LINE = "\0none";

/** The project a conversation can start in at exactly `path` on `machineId`. */
function startableAt(
  state: WireState,
  machineId: string,
  path: string,
): ProjectView | undefined {
  return startableProjects(state).find(
    (project) => project.path === path && project.machineId === machineId,
  );
}

function placeOf(project: ProjectView): Place {
  return { kind: "project", projectId: project.id };
}

/**
 * Whether the project list has a project at `path` on the machine that is not a project a
 * conversation starts in (an agent's own workspace), archived or not.
 */
function workspaceAt(
  state: WireState,
  machineId: string,
  path: string,
): boolean {
  return projectsOf(state).some(
    (project) =>
      project.path === path &&
      project.kind !== "project" &&
      project.machineId === machineId,
  );
}

/** A directory that is an agent's own workspace, which a group conversation cannot start in. */
class NotStartable extends Error {}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `/new`: where (a directory on a machine, found by the shared places flow: searched, browsed,
 * cloned from GitHub or made), then who (the members and the steward), then start. `startPath`
 * is checked on the primary the way the machine reads it, so `~/x` is its home's. Nothing is
 * written to the host before starting, beyond what the flow itself makes (a clone, a new
 * directory); a start that fails keeps the layer, with the error, and a retry reuses a project
 * already made.
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
  const height = useListHeight(4);
  const gate = useActionGate();

  useEffect(() => {
    const releases = ["projects", "machines"].map((target) =>
      wire.subscribe(target),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [wire]);
  const agents = useStore(wire.store, (state) =>
    ordinaryAgents(agentsOf(state)),
  );

  const [step, setStep] = useState<"where" | "who">("where");
  const [cursor, setCursor] = useState(0);
  const [place, setPlace] = useState<Place | undefined>();
  const [pick, setPick] = useState<MemberPick>({
    checked: [],
    steward: null,
  });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | undefined>();
  const madeProjectRef = useRef<
    { machineId: string; path: string; id: string } | undefined
  >(undefined);

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
      // A directory may be a project the list brought in after it was chosen.
      const listed =
        chosen.kind === "directory"
          ? startableAt(wire.store.getState(), chosen.machineId, chosen.path)
          : undefined;
      if (chosen.kind === "project") projectId = chosen.projectId;
      else if (listed !== undefined) projectId = listed.id;
      else if (
        madeProjectRef.current?.path === chosen.path &&
        madeProjectRef.current.machineId === chosen.machineId
      )
        projectId = madeProjectRef.current.id;
      else {
        // Asking the host would bring an archived workspace back before refusing it.
        if (workspaceAt(wire.store.getState(), chosen.machineId, chosen.path))
          throw new NotStartable();
        if (!hostHas(ctx, "projects.create", COMMAND)) return false;
        const { project } = await wire.call<{ project: ProjectView }>(
          "projects",
          "create",
          {
            path: chosen.path,
            machineId: chosen.machineId,
          },
        );
        // An agent's workspace answers for its path: it is that agent's own, not a project.
        if (project.kind !== "project") throw new NotStartable();
        madeProjectRef.current = {
          machineId: chosen.machineId,
          path: chosen.path,
          id: project.id,
        };
        projectId = project.id;
      }
      if (!hostHas(ctx, "conversations.create", COMMAND)) return false;
      const { conversation } = await wire.call<{
        conversation: ConversationSummary;
      }>("conversations", "create", {
        projectId,
        agentIds: members.checked,
        stewardId: members.steward,
      });
      if (chosen.kind === "directory" && wire.can("places.remember"))
        void wire
          .call("places", "remember", {
            machineId: chosen.machineId,
            path: chosen.path,
          })
          .catch(() => undefined);
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
      workspaceAt(wire.store.getState(), chosen.machineId, chosen.path)
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
    setPick(initialPick(agentIds));
    setStartError(undefined);
    setStep("who");
    setCursor(0);
  };

  /** A directory the flow ended on: the project there, or the directory to make one of. */
  const chooseDirectory = (machineId: string, path: string) => {
    const project = startableAt(wire.store.getState(), machineId, path);
    choose(
      project === undefined
        ? { kind: "directory", machineId, path }
        : placeOf(project),
    );
  };

  const flow = usePlaceFlow({
    wire,
    t,
    onChoose: (choice) => chooseDirectory(choice.machineId, choice.path),
  });

  // `/new <path>`: checked on the primary by its own rules (`~` is its home), then chosen.
  const chooseDirectoryRef = useRef(chooseDirectory);
  chooseDirectoryRef.current = chooseDirectory;
  useEffect(() => {
    const typed = startPath?.trim();
    if (typed === undefined || typed === "") return;
    if (!hostHas(ctx, "places.resolve", COMMAND)) return;
    const primary = primaryMachine(wire.store.getState())?.id;
    wire
      .call<PlaceResolved>("places", "resolve", {
        path: typed,
        ...(primary === undefined ? {} : { machineId: primary }),
      })
      .then(
        (found) => {
          if (!found.exists)
            setStartError(problemText(t, { code: "not_found" }));
          else if (!found.directory)
            setStartError(problemText(t, { code: "not_directory" }));
          else
            chooseDirectoryRef.current(
              primary ?? machinesOf(wire.store.getState())[0]?.id ?? "",
              found.path,
            );
        },
        (error: unknown) => setStartError(problemText(t, failureOf(error))),
      );
  }, [startPath, ctx, wire, t]);

  const whoRows: Row[] = [
    ...agents.map((agent) => ({
      key: agent.id,
      label: `${pick.checked.includes(agent.id) ? "[x]" : "[ ]"} ${agent.name}`,
      ...(pick.steward === agent.id ? { note: t("stewardTag") } : {}),
    })),
    {
      key: NO_STEWARD_LINE,
      label: `${t("noSteward")}${pick.steward === null ? t("current") : ""}`,
    },
  ];

  useInput(
    (input, key) => {
      if (inFlightRef.current) return;
      if (step === "where") {
        // The box takes Enter, Esc, Tab and the typing; the arrows are the list's.
        if (key.upArrow) flow.key("up");
        else if (key.downArrow) flow.key("down");
        else if (key.leftArrow) flow.key("left");
        return;
      }
      const at = Math.min(cursor, Math.max(0, whoRows.length - 1));
      if (key.upArrow) setCursor(Math.max(0, at - 1));
      else if (key.downArrow)
        setCursor(Math.min(Math.max(0, whoRows.length - 1), at + 1));
      else {
        const agent = agents[at];
        if (key.escape) {
          setStep("where");
          setStartError(undefined);
        } else if ((input === " " || input === "s") && agent === undefined) {
          // The last line: no steward.
          if (input === "s" || gateAllows(gate))
            setPick(chooseSteward(pick, null));
        } else if (input === " ") {
          if (gateAllows(gate)) setPick(toggleMember(pick, agentIds, agent.id));
        } else if (input === "s") setPick(chooseSteward(pick, agent.id));
        else if (key.return && place !== undefined) {
          if (!gateAllows(gate)) return;
          if (pick.checked.length === 0) setStartError(t("needMember"));
          else start(place, pick);
        }
      }
    },
    { isActive: active },
  );

  const errorLine = (text: string | undefined) =>
    text === undefined ? null : (
      <Text color={inkColor(theme.error)} wrap="truncate-end">
        {text}
      </Text>
    );

  if (step === "who") {
    return (
      <LayerFrame title={t("newTitle")} footer={t("whoFooter")}>
        <Text bold>{t("whoHeading")}</Text>
        <Box flexDirection="column">
          <RowList
            rows={whoRows}
            cursor={Math.min(cursor, Math.max(0, whoRows.length - 1))}
            height={height}
            gate={gate}
          />
        </Box>
        {starting ? (
          <Text color={inkColor(theme.muted)}>{t("starting")}</Text>
        ) : (
          errorLine(startError)
        )}
      </LayerFrame>
    );
  }

  const { page } = flow;
  const rows: Row[] = flow.rows.map((row) => ({
    key: row.key,
    label: row.label,
    ...(row.note === undefined ? {} : { note: row.note }),
  }));
  return (
    <LayerFrame
      title={t("newTitle")}
      footer={t(page.kind === "browse" ? "browseFlowFooter" : "flowFooter")}
    >
      <Text bold wrap="truncate-end">
        {trail(flow, t)}
      </Text>
      {flow.listing === undefined ? null : (
        <Text color={inkColor(theme.muted)} wrap="truncate-start">
          {flow.listing.crumbs
            .map((crumb) => crumb.name)
            .join(flow.flavor === "win32" ? "\\" : "/")
            .replace(/^\/\//, "/")}
          {page.kind === "browse" && page.showHidden
            ? `  (${t("hiddenShown")})`
            : ""}
        </Text>
      )}
      <Text>
        {"› "}
        <LineInput
          value={page.query}
          onChange={flow.type}
          onSubmit={() => {
            if (gateAllows(gate)) flow.key("enter");
          }}
          onEscape={() => {
            if (!flow.key("escape")) handle.close();
          }}
          onTab={() => flow.key("tab")}
          focused={!starting && !page.busy}
        />
      </Text>
      {rows.length === 0 ? (
        <Text color={inkColor(theme.muted)}>
          {flow.loading ? t("loading") : t(emptyKey(flow))}
        </Text>
      ) : (
        <Box flexDirection="column">
          <RowList
            rows={rows}
            cursor={flow.active}
            height={height}
            gate={gate}
          />
        </Box>
      )}
      {flow.clone === undefined ? null : (
        <Text color={inkColor(theme.muted)} wrap="truncate-end">
          {t("cloning", {
            path: flow.clone.target.display,
            progress:
              flow.clone.progress === null
                ? ""
                : `${flow.clone.progress.phase} ${flow.clone.progress.percent ?? ""}%`,
          })}
        </Text>
      )}
      {errorLine(
        flow.problem === null ? undefined : problemText(t, flow.problem),
      )}
      {starting ? (
        <Text color={inkColor(theme.muted)}>{t("starting")}</Text>
      ) : (
        errorLine(startError)
      )}
    </LayerFrame>
  );
}

function problemText(t: Translate, failure: PlaceFailure): string {
  return t(PROBLEM_KEYS[failure.code], { detail: failure.detail ?? "" });
}

function emptyKey(flow: TuiPlaceFlow) {
  const { page } = flow;
  if (page.kind === "github") return "emptyGithub" as const;
  if (page.kind === "new-name") return "emptyNewName" as const;
  if (page.kind === "browse") return "emptyBrowse" as const;
  if (page.query.trim() !== "") return "emptyNoMatch" as const;
  return "emptySearch" as const;
}

/** Where the flow is, and what the box asks: `gpu-box › Search by name, or type a path`. */
function trail(flow: TuiPlaceFlow, t: Translate): string {
  const { page, machine } = flow;
  const prompt = (() => {
    switch (page.kind) {
      case "machine":
        return t("promptMachine");
      case "method":
        return t("promptMethod");
      case "search":
        return t("promptSearch");
      case "browse":
        return t("promptBrowse");
      case "github":
        return t("promptGithub");
      case "clone-location":
        return t("promptCloneLocation", { repo: page.repo.nameWithOwner });
      case "new-parent":
        return t("promptNewParent");
      case "new-name":
        return t("promptNewName", { path: page.parent.display });
    }
  })();
  return page.kind === "machine" || machine === undefined
    ? prompt
    : `${machine.name} › ${prompt}`;
}
