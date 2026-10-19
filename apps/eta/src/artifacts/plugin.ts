import type { TaskBoard } from "../tasks/board";
/**
 * The `artifacts` plugin: the list of artifacts, and what a client can do with one.
 *
 * Publishing is the `publish_artifact` tool, not an action. A client shares a version, takes the
 * share back, deletes an artifact, or asks for an address to preview a version from. The pages
 * themselves are served over HTTP (`routes.ts`).
 */
import type { ArtifactService } from "./service";
import { Args, productPlugin, publish } from "../wire";

export interface ArtifactsDeps {
  artifacts: ArtifactService;
  board: TaskBoard;
}

export function artifactsPlugin(deps: ArtifactsDeps, applied: () => void) {
  const { artifacts, board } = deps;

  return productPlugin(
    "artifacts",
    (ctx) => {
      const { wire } = ctx;
      const offs = [
        publish(wire, "artifacts", { list: () => artifacts.list() }),

        wire.handle("artifacts", "share", (call) => {
          const args = new Args(call);
          const number = args.integer("version");
          const artifact = artifacts.share(args.string("artifactId"), number);
          const url = artifact.versions.find((v) => v.number === number)!
            .shareUrl!;
          return { result: { artifact, url } };
        }),

        wire.handle("artifacts", "unshare", (call) => {
          const args = new Args(call);
          const artifact = artifacts.unshare(
            args.string("artifactId"),
            args.integer("version"),
          );
          return { result: { artifact } };
        }),

        wire.handle("artifacts", "delete", async (call) => {
          const artifactId = new Args(call).string("artifactId");
          const taskId = await artifacts.remove(artifactId);
          // The task's cards listed it.
          if (taskId !== null) board.artifactsChanged(taskId);
          return { result: { artifactId } };
        }),

        wire.handle("artifacts", "preview", (call) => {
          const args = new Args(call);
          return {
            result: artifacts.preview(
              args.string("artifactId"),
              args.integer("version"),
            ),
          };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
