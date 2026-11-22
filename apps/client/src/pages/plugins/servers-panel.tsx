import type { PluginTestResult, PluginView } from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { HeadersEditor } from "./headers-editor";
import { pluginText as text } from "./labels";

/** Whether the host sends the fields the servers panel reads (an older host does not). */
export const hostKnowsHeaders = (item: PluginView): boolean =>
  Array.isArray(item.headers) &&
  item.servers.every((server) => Array.isArray(server.headers));

const testLabel = (result: PluginTestResult): string =>
  result.status === "ok"
    ? uiText("testOk")
    : result.status === "needs_login"
      ? uiText("testNeedsLogin")
      : result.status === "needs_setup"
        ? uiText("serverNeedsSetup")
        : result.status === "off"
          ? uiText("testOff")
          : uiText("testFailed");

/** One click connects to the server, lists what it offers, and closes; it never runs by itself. */
function createTest(props: { item: PluginView; server: string }) {
  const host = useHost();
  const busy = signal(false);
  const result = signal<PluginTestResult | undefined>(undefined);
  function run() {
    busy.set(true);
    void host.action(async () => {
      try {
        result.set(
          await host.call<PluginTestResult>("plugins", "testServer", {
            name: props.item.name,
            server: props.server,
          }),
        );
      } finally {
        busy.set(false);
      }
    });
  }
  return { busy, result, run };
}

type Test = ReturnType<typeof createTest>;

/** The button, in the server's header row: a secondary (outlined, filled) one, so Save stays the primary. */
function TestButton(props: { test: Test }) {
  return (
    <Button
      label={props.test.busy() ? uiText("testing") : uiText("testConnection")}
      tone="plain"
      labelVariant="body"
      size={28}
      disabled={props.test.busy()}
      onPress={props.test.run}
    />
  );
}

function TestResultView(props: { test: Test; stdio: boolean }) {
  const result = props.test.result;
  return (
    <View style={{ gap: 8 }}>
      <If when={props.stdio}>
        <Label variant="small" tone="muted">
          {uiText("testStdioHint")}
        </Label>
      </If>
      <If when={result()}>
        <View style={{ gap: 4 }}>
          <Label variant="small" weight={600}>
            {testLabel(result()!) + ` · ${result()!.ms} ms`}
          </Label>
          <If when={result()!.message}>
            <Label variant="small" tone="muted">
              {result()!.message}
            </Label>
          </If>
          <If when={result()!.status === "ok"}>
            <Label variant="small" tone="muted">
              {[
                result()!.serverName
                  ? `${result()!.serverName} ${result()!.serverVersion ?? ""}`.trim()
                  : "",
                uiText("testCounts", {
                  tools: String(result()!.toolCount),
                  resources: String(result()!.resourceCount ?? "–"),
                  prompts: String(result()!.promptCount ?? "–"),
                }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </Label>
            <Each of={result()!.tools} key={(tool) => tool.name}>
              {(tool) => (
                <Label variant="small" tone="muted">
                  {tool().params.length
                    ? `${tool().name}(${tool().params.join(", ")})`
                    : tool().name}
                </Label>
              )}
            </Each>
          </If>
        </View>
      </If>
    </View>
  );
}

const clip = (text: string): string =>
  text.length > 160 ? text.slice(0, 157) + "…" : text;

/** The skills a plugin holds, read-only; the same list the card counts. Text is shown as plain text. */
export function SkillRows(props: { item: PluginView }) {
  const c = colors();
  return (
    <View style={{ gap: 8 }}>
      <Label variant="subtitle" weight={600}>
        {uiText("pluginSkillsHeading")}
      </Label>
      <If when={!props.item.skills.length}>
        <Label variant="small" tone="muted">
          {uiText("pluginNoSkills")}
        </Label>
      </If>
      {/* One column when narrow; cards keep a readable basis and wrap into two when there is room. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Each of={props.item.skills} key={(skill) => skill.name}>
          {(skill) => (
            <View
              testID={"skill-card:" + skill().name}
              style={{
                flexGrow: 1,
                flexShrink: 1,
                flexBasis: 280,
                gap: 4,
                padding: 12,
                borderWidth: 1,
                borderColor: c().border,
              }}
            >
              <Label variant="subtitle" weight={600}>{skill().name}</Label>
              <If when={skill().description}>
                <Label variant="small" tone="muted">
                  {clip(skill().description)}
                </Label>
              </If>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

/** A plugin's MCP servers: what each is, its state, and for a remote one its request headers. */
export function ServerRows(props: { item: PluginView; phone?: boolean }) {
  const c = colors();
  return (
    <View style={{ gap: 12 }}>
      <If when={!hostKnowsHeaders(props.item)}>
        <Label variant="small" tone="muted">
          {uiText("hostNeedsUpdate")}
        </Label>
      </If>
      <Each of={props.item.servers} key={(server) => server.name}>
        {(server) => {
          const test = createTest({ item: props.item, server: server().name });
          return (
          <View
            style={{
              gap: 12,
              padding: 16,
              borderWidth: 1,
              borderColor: c().border,
            }}
          >
            <View
              style={{
                ...row,
                flexWrap: "wrap",
                gap: props.phone ? 8 : 10,
              }}
            >
                <Label variant="subtitle" weight={600}>{server().name}</Label>
              <Label
                variant="small"
                tone={props.phone ? "ink" : "mutedInk"}
                style={{
                  paddingHorizontal: 5,
                  borderWidth: 1,
                  borderColor: c().strong,
                }}
              >
                {server().transport}
              </Label>
              <Label variant="small" tone="muted">
                {props.item.state === "needs_config" || server().problem
                  ? uiText("serverNeedsSetup")
                  : uiText("serverReady")}
              </Label>
              <View style={{ flex: 1 }} />
              <If when={(server().env ?? []).length}>
                <Label
                  variant="small"
                  tone="muted"
                >{`${text(props.phone ? "envShort" : "env")}: ${(server().env ?? []).join(", ")}`}</Label>
              </If>
              <If when={(server().headers ?? []).length}>
                <Label
                  variant="small"
                  tone="muted"
                >{`${text("headers")}: ${(server().headers ?? []).join(", ")}`}</Label>
              </If>
              <View testID={"test-slot:" + server().name} style={{ flexShrink: 0 }}>
                <TestButton test={test} />
              </View>
            </View>
            <TestResultView test={test} stdio={server().transport === "stdio"} />
            <If when={server().transport !== "stdio" && hostKnowsHeaders(props.item)}>
              <HeadersEditor
                item={props.item}
                server={server().name}
                plainHttp={server().plainHttp}
                phone={props.phone}
              />
            </If>
          </View>
          );
        }}
      </Each>
    </View>
  );
}

/** The panel a plugin card opens: its servers with their headers, over the list, not a page. */
export function ServersDialog(props: {
  item: PluginView;
  phone: boolean;
  onClose: () => void;
}) {
  const c = colors();
  return (
    <Modal
      title={uiText("serversTitle", { name: props.item.name })}
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      compact={!props.phone}
      titleWeight={500}
      width={640}
      overPhoneNavigation={props.phone}
      onClose={props.onClose}
    >
      <SmoothScroll style={{ maxHeight: 560 }} scrollbar={false}>
        <View style={{ padding: 20, gap: 12 }}>
          <Label variant="subtitle" weight={600}>
            {uiText("serversHeading")}
          </Label>
          <ServerRows item={props.item} phone={props.phone} />
          <SkillRows item={props.item} />
        </View>
      </SmoothScroll>
    </Modal>
  );
}
