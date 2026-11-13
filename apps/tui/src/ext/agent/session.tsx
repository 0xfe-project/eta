/**
 * One edit of an agent: its file out to the editor, back as fields, and what changed to the
 * host, until it is applied, has nothing to apply, or the user gives up.
 */
import type { AgentView } from "@eta/client-contracts";
import type { LayerHandle, ShellContext } from "../../extensions/types";
import type { AgentFields } from "./agent-file";
import type { ProblemsAnswer } from "./problems-layer";
import type { ShellWatch } from "./shell-watch";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translatorFor } from "../../i18n/messages";
import { callErrorText } from "../kit/errors";
import {
  agentFields,
  changedFields,
  readAgentFile,
  writeAgentFile,
} from "./agent-file";
import { readChoices } from "./choices";
import { agentFileGuide } from "./guide";
import { reportKept } from "./kept-notice";
import { readLive } from "./live";
import { agentMessages } from "./messages";
import { fileProblemText } from "./problem-text";
import { ProblemsLayer } from "./problems-layer";

/**
 * Applied or left as it was: the edit is over. Otherwise what to show before editing again; a
 * conflict carries the agent as the host has it now and the text the user had written.
 */
type Outcome =
  | "done"
  | { kind: "problems"; title: string; problems: string[] }
  | {
      kind: "conflict";
      title: string;
      problems: string[];
      latest: AgentView;
      userText: string;
      /** Where the user's text goes if they edit again. */
      keptAt: string;
    };

async function freshAgent(
  ctx: ShellContext,
  agentId: string,
): Promise<AgentView | undefined> {
  const sections = await readLive(ctx.wire, "agents", {
    ready: (s) => Array.isArray(s.list),
    failure: translatorFor(agentMessages, ctx.locale)("noState", {
      target: "agents",
    }),
  });
  return (sections.list as AgentView[]).find((agent) => agent.id === agentId);
}

/**
 * A new file name in the system's temporary directory for this agent, with a random part; `kind`
 * tells the user's kept copies from the file being edited.
 */
function tempFileFor(agentId: string, kind?: "yours" | "unsent"): string {
  const safeId = agentId.replace(/[^\w-]/g, "_");
  const suffix = kind === undefined ? "" : `-${kind}`;
  return join(
    tmpdir(),
    `eta-agent-${safeId}-${randomBytes(6).toString("hex")}${suffix}.yaml`,
  );
}

/**
 * Keeps everything the user wrote in this edit once its shell has ended: the file being edited is
 * copied to a new file, and the earlier versions kept after conflicts stay. Says so in the status
 * line, and has the paths listed in full by a later shell.
 */
async function keepUnsent(
  ctx: ShellContext,
  file: string,
  agent: AgentView,
  earlierVersions: readonly string[],
): Promise<void> {
  const kept = tempFileFor(agent.id, "unsent");
  await copyFile(file, kept, constants.COPYFILE_EXCL);
  ctx.notify(
    translatorFor(agentMessages, ctx.locale)("shellGone", { name: agent.name }),
    "warning",
  );
  reportKept(ctx, [kept, ...earlierVersions]);
}

function askAfterProblems(
  ctx: ShellContext,
  outcome: Exclude<Outcome, "done">,
): Promise<ProblemsAnswer> {
  return new Promise((resolve) => {
    let handle: LayerHandle | undefined;
    let answered = false;
    const answer = (value: ProblemsAnswer) => {
      if (answered) return;
      answered = true;
      handle?.close();
      resolve(value);
    };
    handle = ctx.openLayer(() => (
      <ProblemsLayer
        title={outcome.title}
        problems={outcome.problems}
        onAnswer={answer}
      />
    ));
  });
}

async function applyFile(
  ctx: ShellContext,
  file: string,
  agent: AgentView,
  baseline: AgentFields,
): Promise<Outcome> {
  const t = translatorFor(agentMessages, ctx.locale);
  const userText = await readFile(file, "utf8");
  const read = readAgentFile(userText, baseline);
  if ("problems" in read)
    return {
      kind: "problems",
      title: t("fileProblemsTitle", { name: agent.name }),
      problems: read.problems.map((p) => fileProblemText(p, ctx.locale)),
    };
  const changed = changedFields(read.fields, baseline);
  if (Object.keys(changed).length === 0) {
    ctx.notify(t("noChange", { name: agent.name }));
    return "done";
  }
  // `agents.update` takes no version to refuse a stale write with, so a change made on the host
  // since the export is looked for here. An agent that is gone is left to the host to say so.
  let latest: AgentView | undefined;
  try {
    latest = await freshAgent(ctx, agent.id);
  } catch (error) {
    return {
      kind: "problems",
      title: t("uncheckedTitle", { name: agent.name }),
      problems: [t("hostWords", { message: callErrorText(error, ctx.locale) })],
    };
  }
  if (latest !== undefined && latest.updatedAt !== agent.updatedAt) {
    const keptAt = tempFileFor(agent.id, "yours");
    return {
      kind: "conflict",
      title: t("conflictTitle", { name: agent.name }),
      problems: [t("conflictLine", { path: keptAt })],
      latest,
      userText,
      keptAt,
    };
  }
  try {
    const result = await ctx.wire.call<{ agent: AgentView }>(
      "agents",
      "update",
      { agentId: agent.id, ...changed },
    );
    ctx.notify(t("updated", { name: result.agent.name }));
    return "done";
  } catch (error) {
    return {
      kind: "problems",
      title: t("hostRefusedTitle", { name: agent.name }),
      problems: [t("hostWords", { message: callErrorText(error, ctx.locale) })],
    };
  }
}

/**
 * Edits the agent with this id in the user's editor and applies what changed, talking only to
 * the host of `shell`. Every outcome is told in the status area or a layer. The temporary file
 * is removed however the edit ends. When `shell` ends before the export, no editor opens; when
 * it ends while the editor is open, nothing is sent, and every version the user wrote is kept in
 * a file that a later shell lists.
 */
export async function editAgent(
  shell: ShellWatch,
  agentId: string,
): Promise<void> {
  const { ctx } = shell;
  const t = translatorFor(agentMessages, ctx.locale);
  const agent = await freshAgent(ctx, agentId);
  if (agent === undefined) {
    ctx.notify(t("gone", { id: agentId }), "error");
    return;
  }
  const choices = await readChoices(ctx, agent);
  if (shell.ended()) {
    ctx.notify(t("shellGoneBefore", { name: agent.name }), "warning");
    return;
  }
  const file = tempFileFor(agent.id);
  const keptCopies: string[] = [];
  const exportAgent = async (view: AgentView, saved?: string) =>
    writeFile(
      file,
      writeAgentFile(
        agentFields(view),
        agentFileGuide({
          agentName: view.name,
          choices,
          locale: ctx.locale,
          ...(saved === undefined ? {} : { savedEdit: saved }),
        }),
      ),
      { flag: saved === undefined ? "wx" : "w", mode: 0o600 },
    );
  let current = agent;
  // Set once the edit ends with its shell: the user's earlier versions then stay.
  let keepCopies = false;
  const keepAll = async () => {
    keepCopies = true;
    await keepUnsent(ctx, file, current, keptCopies);
  };
  try {
    await exportAgent(current);
    for (;;) {
      const { exitCode } = await ctx.editFile(file);
      // Null: the editor did not start (already reported) or was killed; the file is not trusted.
      if (exitCode === null) return;
      // Another shell may be on another host, and this context opens no layers there.
      if (shell.ended()) return await keepAll();
      const outcome = await applyFile(ctx, file, current, agentFields(current));
      if (outcome === "done") return;
      const answer = shell.ended()
        ? "discard"
        : await askAfterProblems(ctx, outcome);
      if (shell.ended()) return await keepAll();
      if (answer === "discard") {
        ctx.notify(t("noChange", { name: current.name }));
        return;
      }
      if (outcome.kind === "conflict") {
        await writeFile(outcome.keptAt, outcome.userText, {
          flag: "wx",
          mode: 0o600,
        });
        keptCopies.push(outcome.keptAt);
        current = outcome.latest;
        await exportAgent(current, outcome.keptAt);
      }
    }
  } finally {
    await rm(file, { force: true });
    if (!keepCopies)
      for (const kept of keptCopies) await rm(kept, { force: true });
  }
}
