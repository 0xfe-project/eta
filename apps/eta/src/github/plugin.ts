/**
 * The `github` plugin: the wizard's view of the GitHub App and the calls that connect it, and the
 * pull requests tasks delivered with the calls that read and merge them.
 *
 * Two sections. `state` is the connection (what is stored, and what GitHub last said about the
 * installations; `refresh` asks GitHub again). `pulls` is the task ↔ pull request links.
 */
import type { Github } from "./service";
import { Args, productPlugin, publish } from "../wire";
import { GithubError } from "./error";
import { mergePull, readPull } from "./pulls";

export interface GithubPluginDeps {
  github: Github;
}

export function githubPlugin(deps: GithubPluginDeps, applied: () => void) {
  const { github } = deps;
  // The pull requests being merged, so a second click does not race the first.
  const merging = new Set<string>();
  return productPlugin(
    "github",
    ({ wire }) => {
      const offs = [
        publish(wire, "github", {
          state: () => github.snapshot(),
          pulls: () => github.store.pulls(),
        }),

        wire.handle("github", "refresh", async (call) => ({
          result: await github.status(
            new Args(call).optionalBoolean("fresh") ?? false,
          ),
        })),

        wire.handle("github", "createApp", (call) => {
          const args = new Args(call);
          return {
            result: github.startManifest(
              args.string("name"),
              args.optionalString("organization"),
              args.string("origin"),
            ),
          };
        }),

        wire.handle("github", "setOAuthClient", (call) => {
          const args = new Args(call);
          github.setOAuthClient(
            args.optionalString("clientId") ?? "",
            args.optionalString("clientSecret") ?? "",
          );
          return { result: {} };
        }),

        wire.handle("github", "authorize", (call) => ({
          result: {
            url: github.startAuthorization(new Args(call).string("origin")),
          },
        })),

        wire.handle("github", "unauthorize", async () => {
          await github.forgetUser();
          return { result: {} };
        }),

        wire.handle("github", "disconnect", async () => {
          await github.forget();
          return { result: {} };
        }),

        wire.handle("github", "pull", async (call) => ({
          result: await readPull(github, new Args(call).string("url")),
        })),

        wire.handle("github", "merge", async (call) => {
          const args = new Args(call);
          const url = args.string("url");
          if (merging.has(url))
            throw new GithubError(
              "MERGE_IN_PROGRESS",
              409,
              "This PR is being merged.",
            );
          merging.add(url);
          try {
            const pull = await mergePull(github, url, args.string("headSha"));
            return { result: pull };
          } finally {
            merging.delete(url);
          }
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
