/**
 * A host, a daemon dialed in and approved, and a project on the daemon's machine.
 *
 * The daemon has a data directory of its own that only it uses, and the project's directory is a
 * temp directory that the host itself never touches: what the agent's tools do there, the
 * daemon's side did.
 */
import type {
  AgentView,
  ConversationSummary,
  ProjectView,
} from "@eta/client-contracts";
import type { HostOptions } from "../../src/host";
import type { TestDaemon } from "./daemon";
import type { World } from "./world";
import { approve, startDaemon } from "./daemon";
import { tempDir } from "./host";
import { world } from "./world";

export interface RemoteWorld extends World {
  daemon: TestDaemon;
  /** Every text frame that crossed the link, each way, as the daemon saw it. */
  traffic: { in: string[]; out: string[] };
  /** The project on the daemon's machine. */
  remoteProject: ProjectView;
  /** The project's directory (on the daemon's machine). */
  dir: string;
  /** An agent, and a group conversation in the remote project. */
  agents: (
    ...names: string[]
  ) => Promise<{ agents: AgentView[]; group: ConversationSummary }>;
}

export async function remoteWorld(
  options: Partial<HostOptions> = {},
  daemonOptions: Parameters<typeof startDaemon>[2] = {},
): Promise<RemoteWorld> {
  const w = await world(options);
  const traffic = { in: [] as string[], out: [] as string[] };
  const daemon = await startDaemon(w.host, w.client, {
    ...daemonOptions,
    tap: (direction, text) => traffic[direction].push(text),
  });
  await approve(w.client, daemon);
  const dir = await tempDir("eta-remote-project-");
  const remoteProject = await w.project({
    path: dir,
    machineId: daemon.machineId,
  });
  return {
    ...w,
    daemon,
    traffic,
    remoteProject,
    dir,
    async agents(...names) {
      const agents: AgentView[] = [];
      for (const name of names) agents.push(await w.agent(name));
      const steward = agents[0]!;
      await w.client.call("projects", "setSteward", {
        projectId: remoteProject.id,
        agentId: steward.id,
      });
      const group = await w.group(
        remoteProject.id,
        agents.map((agent) => agent.id),
      );
      await w.watch(group.id);
      return { agents, group };
    },
  };
}

/** The session the first member of a conversation holds, once it has one. */
export function sessionOf(
  w: World,
  conversationId: string,
): string | undefined {
  return (
    w.client.section<{ sessionId: string | null }[]>(
      `conversations.${conversationId}`,
      "members",
    )?.[0]?.sessionId ?? undefined
  );
}
