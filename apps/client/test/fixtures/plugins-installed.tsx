import type { PluginView } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Plugins } from "../../src/pages/plugins/plugins";
import { createHost, Host } from "../../src/services/host";

const remote = {
  name: "fc",
  transport: "streamable-http" as const,
  url: "https://example.com/mcp",
  env: [],
  headers: [],
  plainHttp: false,
  problem: null,
};

const plugin = (name: string, enabled: boolean): PluginView => ({
  name,
  version: "1.0.0",
  description: "d",
  source: { kind: "local", path: "/p/" + name },
  enabled,
  state: "ready",
  problem: null,
  reports: [],
  skills: [],
  servers: [],
  requires: [],
  machines: [],
  fields: [],
  headers: [],
  agents: [],
});

(globalThis as { __calls?: unknown[] }).__calls = [];
/** What the host would remember after a Cursor sign-in: the format, or null while nothing is set. */
let tokenHeaderSet: string | null = null;

function Fixture() {
  const host = createHost();
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      plugins: {
        version: 1,
        revisions: {},
        sections: {
          list: [
            plugin("on-plugin", true),
            plugin("off-plugin", false),
            {
              ...plugin("remote-plugin", true),
              servers: [remote],
              skills: [
                { name: "only-skill", description: "<b>x</b> does one thing" },
              ],
            },
            {
              ...plugin("signed-plugin", true),
              servers: [{ ...remote, login: "signed_in" as const }],
            },
            // Signed in, but the server wants a header eta cannot fill by itself (until the user sets it).
            {
              ...plugin("header-plugin", true),
              servers: [{ ...remote, login: "signed_in" as const }],
            },
            {
              ...plugin("fresh-plugin", true),
              servers: [{ ...remote, login: "needs_login" as const }],
            },
            // A Cursor-hosted server: the host says so from the address and the saved header.
            {
              ...plugin("cursor-new-plugin", true),
              servers: [
                {
                  ...remote,
                  name: "drive",
                  url: "https://api.cursor.com/rest-mcp/google-drive/mcp",
                  login: "needs_login" as const,
                  cursorServer: true,
                  cursorSignedIn: false,
                },
              ],
            },
            {
              ...plugin("cursor-in-plugin", true),
              servers: [
                {
                  ...remote,
                  name: "drive",
                  url: "https://api.cursor.com/rest-mcp/google-drive/mcp",
                  login: "needs_login" as const,
                  cursorServer: true,
                  cursorSignedIn: true,
                },
              ],
            },
            {
              ...plugin("acme-plugin", true),
              servers: [{ ...remote, login: "needs_login" as const }],
            },
            {
              ...plugin("login-plugin", true),
              servers: [{ ...remote, login: "needs_login" as const }],
            },
            {
              ...plugin("expired-plugin", true),
              servers: [{ ...remote, login: "expired" as const }],
            },
            {
              ...plugin("setup-plugin", true),
              state: "needs_config" as const,
              servers: [remote],
            },
            // A server that lists many tools, a few resources and one prompt, with a hash in its version.
            {
              ...plugin("rich-plugin", true),
              servers: [{ ...remote, name: "rich" }],
            },
            // A server whose Authorization header is bound to a required field nobody has filled in.
            {
              ...plugin("github-plugin", true),
              state: "needs_config" as const,
              servers: [{ ...remote, name: "gh", headers: ["Authorization"] }],
              fields: [
                {
                  name: "GITHUB_PERSONAL_ACCESS_TOKEN",
                  type: "string",
                  title: "GITHUB_PERSONAL_ACCESS_TOKEN",
                  required: true,
                  secret: true,
                  set: false,
                  value: null,
                  level: "none",
                  levels: ["none"],
                  issue: null,
                },
              ],
            } as unknown as PluginView,
            // An older host sends neither `headers` on the plugin nor on its servers.
            {
              ...plugin("old-host-plugin", true),
              skills: ["alpha", "beta", "gamma"].map((name) => ({
                name,
                description: name + " skill",
              })),
              headers: undefined,
              servers: [
                { ...remote, headers: undefined, plainHttp: undefined },
              ],
            } as unknown as PluginView,
          ],
          audit: [],
        },
      },
    },
  }));
  const stub = Object.assign(host, {
    call: async (_target: string, method: string, args: unknown) => {
      (globalThis as { __calls?: unknown[] }).__calls?.push([method, args]);
      if (method === "cursorLoginStart")
        return { id: "c1", url: "https://cursor.com/loginDeepControl?x=1" };
      if (method === "cursorLoginStatus") {
        // The browser confirmed: the host saved the credential as a header.
        tokenHeaderSet = "bearer";
        return { state: "done", validForSeconds: 60 * 86400 };
      }
      if (
        method === "testServer" &&
        (args as { name?: string }).name === "header-plugin" &&
        tokenHeaderSet === null
      ) {
        return {
          status: "failed",
          message:
            "the sign-in is saved, but the server requires the x-cursor-auth header",
          ms: 5,
          tools: [],
          toolCount: 0,
          requiredHeader: "x-cursor-auth",
          cursorServer: true,
        };
      }
      // Nothing signed in yet: a Cursor-hosted server wants its header first.
      if (
        method === "testServer" &&
        (args as { name?: string }).name === "fresh-plugin"
      ) {
        return {
          status: "needs_login",
          message: "the server requires the x-cursor-auth header",
          ms: 5,
          tools: [],
          toolCount: 0,
          requiredHeader: "x-cursor-auth",
          cursorServer: true,
        };
      }
      // A header that is not Cursor's: no Cursor sign-in is offered.
      if (
        method === "testServer" &&
        (args as { name?: string }).name === "acme-plugin"
      ) {
        return {
          status: "needs_login",
          message: "the server requires the x-acme-session header",
          ms: 5,
          tools: [],
          toolCount: 0,
          requiredHeader: "x-acme-session",
        };
      }
      if (
        method === "testServer" &&
        (args as { name?: string }).name === "github-plugin"
      ) {
        return {
          status: "needs_setup",
          message: "required values are missing",
          ms: 0,
          tools: [],
          toolCount: 0,
        };
      }
      if (
        method === "testServer" &&
        (args as { name?: string }).name === "rich-plugin"
      ) {
        return {
          status: "ok",
          message: "",
          ms: 30,
          serverName: "github-mcp-server",
          serverVersion:
            "github-mcp-server/remote-15f22585c741f51171c729338572905dfaae65d4",
          tools: Array.from({ length: 12 }, (_, i) => ({
            name: "tool_" + i,
            description: i === 0 ? "long ".repeat(60) : "short " + i,
            params: ["a", "b"],
          })),
          toolCount: 12,
          resourceCount: 4,
          promptCount: 1,
          resources: [0, 1, 2, 3].map((i) => ({
            name: "res_" + i,
            description: "resource " + i,
            params: [],
          })),
          prompts: [
            { name: "prompt_0", description: "a prompt", params: ["topic"] },
          ],
        };
      }
      // The credential is saved but the server still does not take the sign-in.
      if (
        method === "testServer" &&
        (args as { name?: string }).name === "cursor-in-plugin"
      ) {
        return {
          status: "needs_login",
          message: "the server did not accept the stored sign-in",
          ms: 7,
          tools: [],
          toolCount: 0,
          cursorServer: true,
        };
      }
      if (method === "testServer") {
        // A variant fixture sets this before importing this one, to ask for many tools.
        const count = (globalThis as { __toolCount?: number }).__toolCount ?? 3;
        return {
          status: "ok",
          message: "",
          ms: 12,
          serverName: "fake",
          serverVersion: "1.0",
          tools: Array.from({ length: count }, (_, i) => ({
            name: "tool_" + i,
            description: i === 0 ? "long ".repeat(60) : "short " + i,
            params:
              i === 0 ? Array.from({ length: 15 }, (_, k) => "p" + k) : ["a"],
          })),
          toolCount: count,
          resourceCount: 2,
          promptCount: 1,
        };
      }
      return undefined;
    },
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <Plugins onSettings={() => {}} layout="desktop" />
      </View>
    </Host.Provider>
  );
}
mount(() => <Fixture />);
