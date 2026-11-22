import type {
  PluginServerView,
  PluginTestResult,
  PluginView,
} from "@eta/client-contracts";
import { openUrl, signal, View } from "nsh";
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
  const at = signal<number | undefined>(undefined);
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
        at.set(Date.now());
      } finally {
        busy.set(false);
      }
    });
  }
  return { busy, result, at, run };
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

/** The sign-in the server needs, from the host's evidence or this panel's last test. */
const needsLogin = (server: PluginServerView, test: Test): boolean =>
  server.login === "needs_login" || test.result()?.status === "needs_login";

/** A state only when there is evidence for it; no evidence reads as "not checked", never as ready. */
function ServerBadge(props: { item: PluginView; server: PluginServerView; test: Test }) {
  const label = (): { text: string; tone: "ink" | "red" | "muted" } => {
    const test = props.test.result();
    const time = new Date(props.test.at() ?? 0).toLocaleTimeString();
    if (props.item.state === "needs_config" || props.server.problem)
      return { text: uiText("serverNeedsSetup"), tone: "ink" };
    if (props.server.login === "signed_in")
      return { text: uiText("serverSignedIn"), tone: "ink" };
    if (needsLogin(props.server, props.test))
      return { text: uiText("serverNeedsLogin"), tone: "ink" };
    if (test?.status === "ok")
      return { text: uiText("lastTestOk", { time }), tone: "ink" };
    if (test !== undefined && test.status !== "off")
      return { text: uiText("lastTestFailed", { time }), tone: "red" };
    return { text: uiText("serverNotChecked"), tone: "muted" };
  };
  return (
    <Label variant="small" tone={label().tone}>
      {label().text}
    </Label>
  );
}

/** Log in / out in the panel itself: the host starts the sign-in, the browser comes back to the host. */
function LoginButton(props: { item: PluginView; server: PluginServerView; test: Test }) {
  const host = useHost();
  const busy = signal(false);
  const call = (method: "loginServer" | "logoutServer") => {
    busy.set(true);
    void host.action(async () => {
      try {
        const out = await host.call<{ authorizationUrl?: string }>("plugins", method, {
          name: props.item.name,
          server: props.server.name,
          ...(method === "loginServer" ? { redirectOrigin: host.address()?.origin } : {}),
        });
        if (out?.authorizationUrl) await openUrl(out.authorizationUrl);
      } finally {
        busy.set(false);
      }
    });
  };
  return (
    <>
      <If when={props.item.enabled && props.server.login === "signed_in"}>
        <Button
          label={uiText("logoutButton")}
          tone="plain"
          labelVariant="body"
          size={28}
          disabled={busy()}
          onPress={() => call("logoutServer")}
        />
      </If>
      <If when={props.item.enabled && props.server.login !== "signed_in" && needsLogin(props.server, props.test)}>
        <Button
          label={uiText("loginButton")}
          tone="plain"
          labelVariant="body"
          size={28}
          disabled={busy()}
          onPress={() => call("loginServer")}
        />
      </If>
    </>
  );
}

const MAX_CHIPS = 12;
const LONG_TOOL_TEXT = 140;

/** One tool: its name, its description (long ones fold), and its parameter names as chips. */
function ToolCard(props: { tool: PluginTestResult["tools"][number] }) {
  const c = colors();
  const open = signal(false);
  const long = () => props.tool.description.length > LONG_TOOL_TEXT;
  const params = () => props.tool.params;
  return (
    <View
      testID={"tool-card:" + props.tool.name}
      style={{
        gap: 8,
        padding: 12,
        borderWidth: 1,
        borderColor: c().border,
      }}
    >
      <Label variant="body" weight={600} lines={1}>
        {props.tool.name}
      </Label>
      <If when={props.tool.description}>
        <Label variant="small" tone="muted" lines={open() || !long() ? undefined : 2}>
          {open() || !long()
            ? props.tool.description
            : props.tool.description.slice(0, LONG_TOOL_TEXT) + "…"}
        </Label>
        <If when={long()}>
          <Button
            label={open() ? uiText("toolCollapse") : uiText("toolExpand")}
            tone="plain"
            labelVariant="small"
            size={24}
            onPress={() => open.set(!open())}
          />
        </If>
      </If>
      <If when={params().length}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Each of={params().slice(0, MAX_CHIPS)} key={(name) => name}>
            {(name) => (
              <View
                testID={"tool-param:" + name()}
                style={{ paddingVertical: 2, paddingHorizontal: 8, borderWidth: 1, borderColor: c().border }}
              >
                <Label variant="small" tone="muted">{name()}</Label>
              </View>
            )}
          </Each>
          <If when={params().length > MAX_CHIPS}>
            <Label variant="small" tone="muted">{"+" + (params().length - MAX_CHIPS)}</Label>
          </If>
        </View>
      </If>
    </View>
  );
}

/** The listed tools as cards, in a region that scrolls when there are many. */
export function ToolCards(props: { tools: PluginTestResult["tools"]; total: number }) {
  return (
    <If when={props.tools.length}>
      <View style={{ gap: 8 }}>
        <Label variant="small" weight={600}>
          {uiText("toolsHeading", { count: String(props.total) })}
        </Label>
        <SmoothScroll style={{ maxHeight: 420 }} scrollbar={false}>
          <View style={{ gap: 8 }}>
            <Each of={props.tools} key={(tool) => tool.name}>
              {(tool) => <ToolCard tool={tool()} />}
            </Each>
          </View>
        </SmoothScroll>
      </View>
    </If>
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
            <ToolCards tools={result()!.tools} total={result()!.toolCount} />
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
              <ServerBadge item={props.item} server={server()} test={test} />
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
              <View testID={"login-slot:" + server().name} style={{ flexShrink: 0 }}>
                <LoginButton item={props.item} server={server()} test={test} />
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
