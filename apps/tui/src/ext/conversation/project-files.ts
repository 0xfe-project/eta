/** The files of a conversation's project, for the composer's `@` menu. */
import type { ProjectResults } from "@eta/client-contracts";
import type { WireClient } from "../../connection/types";

/** One list per conversation and wire, kept from the first answer that came. */
const asked = new WeakMap<WireClient, Map<string, Promise<string[]>>>();

/**
 * The project's files, asked of the host the first time for each conversation and kept after.
 * Rejects with the host's error when it cannot list them; a failure is not kept, so the next
 * call asks again.
 */
export function projectFiles(
  wire: WireClient,
  conversationId: string,
  projectId: string,
): Promise<string[]> {
  let byConversation = asked.get(wire);
  if (byConversation === undefined) {
    byConversation = new Map();
    asked.set(wire, byConversation);
  }
  let files = byConversation.get(conversationId);
  if (files === undefined) {
    const kept = byConversation;
    files = wire
      .call<ProjectResults["files"]>("projects", "files", { projectId })
      .then(
        (result) => result.files,
        (error: unknown) => {
          kept.delete(conversationId);
          throw error;
        },
      );
    byConversation.set(conversationId, files);
  }
  return files;
}
