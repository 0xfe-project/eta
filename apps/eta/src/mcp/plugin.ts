/**
 * The `mcp` plugin: the settings page's view of every agent's MCP servers, and the calls that
 * connect them and sign in to them.
 *
 * One section, `list`. `login` returns the provider's address for the browser to open; the browser
 * comes back to the host's callback route (`service.route`), or, when the host cannot be reached
 * from the browser the user is in front of, the user pastes the redirect URL into `completeLogin`.
 */
import type { McpService } from "./service";
import { Args, productPlugin, publish } from "../wire";

export interface McpPluginDeps {
  service: McpService;
}

export function mcpPlugin(deps: McpPluginDeps, applied: () => void) {
  const { service } = deps;
  return productPlugin(
    "mcp",
    ({ wire }) => {
      const offs = [
        publish(wire, "mcp", { list: () => service.list() }),

        wire.handle("mcp", "connect", async (call) => {
          const args = new Args(call);
          return {
            result: await service.connect(
              args.string("agentId"),
              args.string("server"),
              false,
            ),
          };
        }),

        wire.handle("mcp", "reconnect", async (call) => {
          const args = new Args(call);
          return {
            result: await service.connect(
              args.string("agentId"),
              args.string("server"),
              true,
            ),
          };
        }),

        wire.handle("mcp", "login", async (call) => {
          const args = new Args(call);
          return {
            result: await service.login(
              args.string("agentId"),
              args.string("server"),
              args.optionalString("redirectOrigin"),
            ),
          };
        }),

        wire.handle("mcp", "completeLogin", async (call) => {
          const args = new Args(call);
          await service.completeLogin(
            args.string("pendingId"),
            args.string("callbackUrl"),
          );
          return { result: { ok: true } };
        }),

        wire.handle("mcp", "logout", async (call) => {
          const args = new Args(call);
          await service.logout(args.string("agentId"), args.string("server"));
          return { result: {} };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
