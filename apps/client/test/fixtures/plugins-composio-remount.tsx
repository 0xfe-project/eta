import type { ComposioToolkit } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Button, Label } from "../../src/components";
import { ComposioConnected } from "../../src/pages/plugins/composio-connected";
import { createHost, Host } from "../../src/services/host";

const toolkit = (
  slug: string,
  name: string,
  auth: ComposioToolkit["auth"],
): ComposioToolkit => ({
  kind: "composio",
  slug,
  name,
  description: name + " toolkit",
  auth,
  authSchemes: [],
  managed: true,
  categories: [],
  logo: null,
  appUrl: null,
  toolsCount: 3,
  source: "composio",
  sourceName: "Composio",
});

const kept = [
  toolkit("gmail", "Gmail", "oauth"),
  toolkit("hackernews", "Hacker News", "none"),
];

type Mode = "ok" | "held" | "needs key" | "fails";

/**
 * The connected group alone, over one host that lives as long as the page: the group can be taken
 * away and brought back (as the page does when the tab changes or the window crosses a width), and
 * what the host answers can be changed between: all, nothing at all (held), no key, or an error.
 * Gmail is connected and Hacker News was added.
 */
mount(() => {
  const host = createHost();
  host.state.update((state) => ({ ...state, status: "open" }));
  const mode = signal<Mode>("ok");
  const visible = signal(true);
  const connectedAnswers = signal(0);
  const toolkitAnswers = signal(0);
  let added = ["hackernews"];
  const stub = Object.assign(host, {
    call: async (_target: string, method: string, args: unknown) => {
      const held = mode() === "held";
      if (
        held &&
        (method === "composioConnected" || method === "composioPlugins")
      )
        return await new Promise(() => {});
      if (method === "composioConnected") {
        connectedAnswers.update((n) => n + 1);
        if (mode() === "fails") throw new Error("Composio is down");
        return mode() === "needs key"
          ? { status: "needs_key", slugs: [] }
          : { status: "ready", slugs: ["gmail"] };
      }
      if (method === "composioAdded") return { slugs: added };
      if (method === "composioRemove") {
        const { slug } = args as { slug: string };
        added = added.filter((one) => one !== slug);
        return { removed: true };
      }
      if (method === "composioStatus") return { hasKey: true, enabled: true };
      if (method === "composioPlugins")
        return {
          plugins: [
            {
              name: "@composio/gmail",
              slug: "gmail",
              state: "ready",
              enabled: true,
            },
          ],
        };
      if (method === "composioToolkits") {
        const { slugs } = args as { slugs: string[] };
        toolkitAnswers.update((n) => n + 1);
        return { toolkits: kept.filter((one) => slugs.includes(one.slug)) };
      }
      return undefined;
    },
    action: async <T,>(run: () => Promise<T>) => await run(),
  });
  return (
    <Host.Provider value={stub}>
      <View style={{ flex: 1 }}>
        <Label>{"answers:" + connectedAnswers()}</Label>
        <Label>{"toolkits:" + toolkitAnswers()}</Label>
        <View style={{ flexDirection: "row" }}>
          <Button label="hide group" onPress={() => visible.set(false)} />
          <Button label="show group" onPress={() => visible.set(true)} />
          <Button label="mode ok" onPress={() => mode.set("ok")} />
          <Button label="mode held" onPress={() => mode.set("held")} />
          <Button
            label="mode needs key"
            onPress={() => mode.set("needs key")}
          />
          <Button label="mode fails" onPress={() => mode.set("fails")} />
        </View>
        <If when={visible()}>
          <ComposioConnected layout="desktop" />
        </If>
      </View>
    </Host.Provider>
  );
});
