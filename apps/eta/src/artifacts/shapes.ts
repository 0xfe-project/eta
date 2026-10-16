/**
 * Artifacts' wire shapes (REFACTOR.md §9, P3.2).
 *
 * AXP's, because the web's artifact dialog reads them: an artifact with its versions, and each
 * version's preview address (a one-hour capability) and public link (while it is shared). The
 * translator is where our rows differ from these fields — a publisher is an agent id here and a
 * name there, a version's size is the ZIP's and its bytes are the files'.
 */
import type { ArtifactRecord, VersionRecord } from "./service";

export interface AxpArtifactShare {
  /** The public page's path, on this host's address. */
  url: string;
  created_at: string;
}

export interface AxpArtifactVersion {
  number: number;
  files: number;
  /** The files' total size. */
  bytes: number;
  /** The ZIP's size. */
  size: number;
  created_at: string;
  /** A sandboxed preview, valid for an hour; `index.html` is the page. */
  preview_url: string;
  /** Its public link, while it is shared. */
  share?: AxpArtifactShare | undefined;
}

export interface AxpArtifact {
  group_id: string | null;
  id: string;
  title: string;
  agent_id: string | null;
  agent_name: string | null;
  computer_name: string | null;
  task_id: string | null;
  task_number: number | null;
  created_at: string;
  updated_at: string;
  versions: AxpArtifactVersion[];
}

export interface ArtifactShapeInput {
  /** The agent that published it, by name. */
  agentName: (agentId: string) => string | undefined;
  /** The task's number, for a link that reads. */
  taskNumber: (taskId: string) => number | undefined;
  /** The preview capability for a version; the route mints one per read. */
  capability: (version: VersionRecord) => Promise<string>;
  /** The live share of a version, when there is one. */
  shareOf: (
    version: VersionRecord,
  ) => { token: string; createdAt: string } | undefined;
}

export async function toArtifact(
  artifact: ArtifactRecord,
  versions: readonly VersionRecord[],
  input: ArtifactShapeInput,
): Promise<AxpArtifact> {
  const agentId = artifact.publisherAgent;
  const taskNumber =
    artifact.taskId === undefined
      ? undefined
      : input.taskNumber(artifact.taskId);
  return {
    group_id: artifact.groupId ?? null,
    id: artifact.id,
    title: artifact.title,
    agent_id: agentId ?? null,
    agent_name:
      agentId === undefined ? null : (input.agentName(agentId) ?? null),
    // Remote computers publish too, in P4; nothing here has one yet.
    computer_name: null,
    task_id: artifact.taskId ?? null,
    task_number: taskNumber ?? null,
    created_at: artifact.createdAt,
    updated_at: artifact.updatedAt,
    versions: await Promise.all(
      versions.map(async (version) => {
        const share = input.shareOf(version);
        const capability = await input.capability(version);
        return {
          number: version.number,
          files: version.files,
          bytes: version.bytes,
          size: version.bytes,
          created_at: version.createdAt,
          preview_url: `/preview/artifacts/${capability}/files/index.html`,
          ...(share === undefined
            ? {}
            : {
                share: {
                  url: `/share/artifacts/${share.token}/`,
                  created_at: share.createdAt,
                },
              }),
        };
      }),
    ),
  };
}
