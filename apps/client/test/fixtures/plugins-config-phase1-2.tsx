import type { PluginToolkitView, PluginView } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Button, Label } from "../../src/components";
import { useComposioPlugins } from "../../src/pages/plugins/composio-plugins";
import { Plugins } from "../../src/pages/plugins/plugins";
import { createHost, Host } from "../../src/services/host";

const stdioNeedsEnv: PluginView = {
  name: "env-only-plugin",
  version: "1.0.0",
  description: "stdio server with blank env var",
  source: { kind: "local", path: "/p/env-only-plugin" },
  enabled: true,
  state: "needs_config",
  problem: null,
  reports: [],
  skills: [],
  servers: [
    {
      name: "local",
      transport: "stdio",
      command: ["node", "server.js"],
      env: [],
      lockedEnv: ["NODE_ENV"],
      missingEnv: ["DB_TOKEN"],
      headers: [],
      plainHttp: false,
      problem: null,
    },
  ],
  requires: [],
  machines: [],
  fields: [],
  headers: [],
  env: [],
  agents: [],
};

const configEdgesPlugin: PluginView = {
  name: "config-edges-plugin",
  version: "1.0.0",
  description: "fields covering secret, select, boolean, and validation issues",
  source: { kind: "local", path: "/p/config-edges-plugin" },
  enabled: true,
  state: "needs_config",
  problem: null,
  reports: [],
  skills: [],
  servers: [
    {
      name: "worker",
      transport: "stdio",
      command: ["node", "worker.js"],
      env: [],
      missingEnv: ["WORKER_SECRET"],
      headers: [],
      plainHttp: false,
      problem: null,
    },
  ],
  requires: [],
  machines: [],
  fields: [
    {
      name: "api_key",
      type: "string",
      title: "API Key",
      description: "",
      required: false,
      secret: true,
      agent: "none",
      set: true,
      value: null,
      level: "none",
      levels: ["none"],
      issue: null,
    },
    {
      name: "region",
      type: "select",
      title: "Region",
      description: "",
      required: false,
      secret: false,
      agent: "read",
      options: [
        { value: "us", label: "US" },
        { value: "eu", label: "EU" },
      ],
      multiple: false,
      set: true,
      value: "us",
      level: "read",
      levels: ["none", "read"],
      issue: null,
    },
    {
      name: "strict",
      type: "boolean",
      title: "Strict mode",
      description: "",
      required: true,
      secret: false,
      agent: "read",
      set: false,
      value: null,
      level: "read",
      levels: ["none", "read"],
      issue: null,
    },
    {
      name: "code",
      type: "string",
      title: "Access Code",
      description: "",
      required: false,
      secret: false,
      agent: "read",
      minLength: 6,
      set: true,
      value: "abc",
      level: "read",
      levels: ["none", "read"],
      issue: { field: "code", code: "minLength", limit: 6 },
    },
  ],
  headers: [],
  env: [],
  agents: [],
};

function LiveComposioProbe() {
  const composio = useComposioPlugins();
  return (
    <Label>
      {`live:${composio
        .list()
        .map((item) => `${item.name}:${item.state}`)
        .join(",")}`}
    </Label>
  );
}

function Fixture() {
  const host = createHost();
  const log = signal<string[]>([]);
  const composioLive: PluginToolkitView[] = [
    {
      name: "@composio/slack",
      slug: "slack",
      state: "ready",
      enabled: true,
      provider: "composio",
    },
  ];
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      plugins: {
        version: 1,
        revisions: {},
        sections: {
          list: [stdioNeedsEnv, configEdgesPlugin],
          audit: [],
          toolkits: composioLive,
        },
      },
    },
  }));
  const stub = Object.assign(host, {
    call: async (_target: string, method: string, args: unknown) => {
      log.update((all) => [...all, `${method}:${JSON.stringify(args)}`]);
      if (method === "composioPlugins") {
        return {
          plugins: [
            {
              name: "@composio/slack",
              slug: "slack",
              state: "ready",
              enabled: true,
            },
          ],
        };
      }
      if (method === "configure") {
        return {
          name: (args as { name: string }).name,
          state: "needs_config",
          issues: [],
        };
      }
      if (method === "setEnv") {
        const { name, server } = args as { name: string; server: string };
        return { name, server };
      }
      return {};
    },
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  function pushToolkit() {
    host.state.update((state) => ({
      ...state,
      targets: {
        ...state.targets,
        plugins: {
          ...state.targets.plugins!,
          sections: {
            ...state.targets.plugins!.sections,
            toolkits: [
              ...composioLive,
              {
                name: "@composio/linear",
                slug: "linear",
                state: "ready",
                enabled: true,
                provider: "composio",
              },
            ],
          },
        },
      },
    }));
  }
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <LiveComposioProbe />
        <Button label="Push toolkit" onPress={pushToolkit} />
        <Label>{log().join(" | ")}</Label>
        <Plugins layout="desktop" />
      </View>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
