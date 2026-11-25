import type {
  PluginServerView,
  PluginTestResult,
  PluginView,
} from "@eta/client-contracts";
import { CURSOR_AUTH_HEADER } from "@eta/client-contracts";
import { openUrl, signal, View } from "nsh";
import {
  Button,
  colors,
  dialogWidth,
  Label,
  Modal,
  row,
  SmoothScroll,
  textFaces,
} from "../../components";
import { hint } from "../../components/controls";
import { control, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import { EnvEditor } from "./env-editor";
import { HeadersEditor } from "./headers-editor";
import { pluginText as text } from "./labels";
import { MissingValues } from "./missing-values";
import { authStyle } from "./plugin-status";

/** Whether the host sends the fields the servers panel reads (an older host does not). */
const hostKnowsHeaders = (item: PluginView): boolean =>
  Array.isArray(item.headers) &&
  item.servers.every((server) => Array.isArray(server.headers));

/** Only a result that went to the server has a time worth showing. */
const REQUEST_MADE = new Set<PluginTestResult["status"]>([
  "ok",
  "needs_login",
  "failed",
]);

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
  /** Sign in to a Cursor account in the browser (unofficial); the host saves the credential, then test again. */
  const cursorId = signal<string | undefined>(undefined);
  const cursorNote = signal<string | undefined>(undefined);
  function cursorLogin(header: string) {
    void host.action(async () => {
      cursorNote.set(undefined);
      const started = await host.call<{ id: string; url: string }>(
        "plugins",
        "cursorLoginStart",
        { name: props.item.name, server: props.server, header },
      );
      cursorId.set(started.id);
      // The page opens on its own; the wait below does not depend on it.
      void openUrl(started.url).catch(() => undefined);
      void (async () => {
        while (cursorId() === started.id) {
          const status: {
            state: string;
            reason?: string;
            validForSeconds?: number;
          } = await host
            .call<{
              state: string;
              reason?: string;
              validForSeconds?: number;
            }>("plugins", "cursorLoginStatus", { id: started.id })
            .catch((error: unknown) => ({
              state: "failed",
              reason: problemText(error),
            }));
          if (cursorId() !== started.id) return;
          if (status.state !== "waiting") {
            cursorId.set(undefined);
            if (status.state === "done") {
              cursorNote.set(
                status.validForSeconds === undefined
                  ? uiText("cursorLoginDone")
                  : `${uiText("cursorLoginDone")} · ${uiText("cursorLoginValid", { days: String(Math.round(status.validForSeconds / 86400)) })}`,
              );
              run();
            } else if (status.state === "failed" || status.state === "expired")
              cursorNote.set(
                uiText("cursorLoginFailed", { reason: status.reason ?? "" }),
              );
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      })();
    });
  }
  function cursorCancel() {
    const id = cursorId();
    cursorId.set(undefined);
    if (id !== undefined)
      void host.action(async () => {
        await host.call("plugins", "cursorLoginCancel", { id });
      });
  }
  return {
    busy,
    result,
    at,
    run,
    cursorId,
    cursorNote,
    cursorLogin,
    cursorCancel,
  };
}

type Test = ReturnType<typeof createTest>;

/** The button, in the server's header row: a secondary (outlined, filled) one, so Save stays the primary. */
function TestButton(props: { test: Test }) {
  return (
    <Button
      label={uiText("testConnection")}
      tone="plain"
      labelVariant="body"
      size={control.md}
      busy={props.test.busy()}
      onPress={props.test.run}
    />
  );
}

/** The sign-in the server needs, from the host's evidence or this panel's last test. */
const needsLogin = (server: PluginServerView, test: Test): boolean =>
  server.login === "needs_login" ||
  server.login === "expired" ||
  test.result()?.status === "needs_login";

/** A state only when there is evidence for it; no evidence reads as "not checked", never as ready. */
function ServerBadge(props: {
  item: PluginView;
  server: PluginServerView;
  test: Test;
}) {
  const label = (): {
    text: string;
    tone: "ink" | "red" | "muted" | "green" | "warningInk";
  } => {
    const test = props.test.result();
    const time = new Date(props.test.at() ?? 0).toLocaleTimeString();
    if (props.item.state === "needs_config" || props.server.problem)
      return {
        text: uiText(authStyle("needs_setup").text),
        tone: authStyle("needs_setup").tone,
      };
    if (
      props.server.cursorServer === true &&
      props.server.cursorSignedIn !== true &&
      props.server.login !== "signed_in"
    )
      return { text: uiText("cursorNeedsLogin"), tone: "warningInk" };
    if (props.server.login === "expired")
      return {
        text: uiText(authStyle("expired").text),
        tone: authStyle("expired").tone,
      };
    if (
      props.server.login === "signed_in" &&
      test?.requiredHeader !== undefined
    )
      return {
        text: uiText("serverSavedNotAccepted", { header: test.requiredHeader }),
        tone: "warningInk",
      };
    if (props.server.login === "signed_in")
      return {
        text: uiText(authStyle("signed_in").text),
        tone: authStyle("signed_in").tone,
      };
    if (needsLogin(props.server, props.test))
      return {
        text: uiText(authStyle("needs_login").text),
        tone: authStyle("needs_login").tone,
      };
    if (test?.status === "ok")
      return { text: uiText("lastTestOk", { time }), tone: "ink" };
    if (test !== undefined && test.status !== "off")
      return { text: uiText("lastTestFailed", { time }), tone: "red" };
    return { text: uiText("serverNotChecked"), tone: "muted" };
  };
  return (
    <Label variant="small" tone={label().tone} lines={1}>
      {label().text}
    </Label>
  );
}

/** Log in / out in the panel itself: the host starts the sign-in, the browser comes back to the host. */
function LoginButton(props: {
  item: PluginView;
  server: PluginServerView;
  test: Test;
}) {
  const host = useHost();
  const busy = signal(false);
  const call = (method: "loginServer" | "logoutServer") => {
    busy.set(true);
    void host.action(async () => {
      try {
        const out = await host.call<{ authorizationUrl?: string }>(
          "plugins",
          method,
          {
            name: props.item.name,
            server: props.server.name,
            ...(method === "loginServer"
              ? { redirectOrigin: host.address()?.origin }
              : {}),
          },
        );
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
          size={control.md}
          disabled={busy()}
          onPress={() => call("logoutServer")}
        />
      </If>
      <If
        when={
          props.item.enabled &&
          props.server.login !== "signed_in" &&
          needsLogin(props.server, props.test)
        }
      >
        <Button
          label={uiText("loginButton")}
          tone="plain"
          labelVariant="body"
          size={control.md}
          disabled={busy()}
          onPress={() => call("loginServer")}
        />
      </If>
    </>
  );
}

/** "1 tool", "3 tools", "–" when the server did not say; the singular is its own string. */
const counted = (
  key: "countTool" | "countResource" | "countPrompt",
  n: number | null | undefined,
): string =>
  n == null
    ? "–"
    : n === 1
      ? uiText(`${key}1` as never, { n: "1" })
      : uiText(`${key}s` as never, { n: String(n) });

/** How tall a folded list of tools grows before it scrolls, and the servers dialog's body. */
const listHeight = 420;
const bodyHeight = 560;
const MAX_CHIPS = 12;
const LONG_TOOL_TEXT = 140;
/** A long list shows this many cards, and a link for the rest; the region still scrolls past it. */
const COLLAPSED_ITEMS = 5;

interface Listed {
  name: string;
  description: string;
  params: string[];
}

/** A small text link, not a bordered button: a list of cards must not become a list of buttons. */
function TextLink(props: {
  label: string;
  testID?: string;
  onPress: () => void;
}) {
  return (
    <View
      testID={props.testID}
      role="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={{ alignSelf: "flex-end", cursor: "pointer" }}
    >
      <Label
        variant="small"
        tone="mutedInk"
        style={{ textDecorationLine: "underline" }}
      >
        {props.label}
      </Label>
    </View>
  );
}

/** One tool, resource or prompt: its name, its description (a long one folds), its parameter names as chips. */
function ItemCard(props: {
  kind: "tool" | "resource" | "prompt";
  item: Listed;
}) {
  const c = colors();
  const open = signal(false);
  const long = () => props.item.description.length > LONG_TOOL_TEXT;
  const params = () => props.item.params;
  return (
    <View
      testID={`${props.kind}-card:${props.item.name}`}
      style={{
        gap: space[8],
        padding: space[12],
        borderWidth: 1,
        borderColor: c().border,
      }}
    >
      <Label variant="body" weight={weight.strong} lines={1}>
        {props.item.name}
      </Label>
      <If when={props.item.description}>
        <Label
          variant="small"
          tone="muted"
          lines={open() || !long() ? undefined : 2}
        >
          {open() || !long()
            ? props.item.description
            : `${props.item.description.slice(0, LONG_TOOL_TEXT)}…`}
        </Label>
        <If when={long()}>
          <TextLink
            label={open() ? uiText("toolCollapse") : uiText("toolExpand")}
            onPress={() => open.set(!open())}
          />
        </If>
      </If>
      <If when={params().length}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[4] }}>
          <Each of={params().slice(0, MAX_CHIPS)} key={(name) => name}>
            {(name) => (
              <View
                testID={`tool-param:${name()}`}
                style={{
                  paddingVertical: space[2],
                  paddingHorizontal: space[8],
                  borderWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Label variant="small" tone="muted">
                  {name()}
                </Label>
              </View>
            )}
          </Each>
          <If when={params().length > MAX_CHIPS}>
            <Label
              variant="small"
              tone="muted"
            >{`+${params().length - MAX_CHIPS}`}</Label>
          </If>
        </View>
      </If>
    </View>
  );
}

/**
 * A heading, the first few cards, and a link for the rest. Folded by default so a server with dozens
 * of tools does not make the result a wall; the region keeps its height cap and scrolls when open.
 */
function ItemList(props: {
  kind: "tool" | "resource" | "prompt";
  heading: string;
  items: Listed[];
}) {
  const all = signal(false);
  const shown = () =>
    all() ? props.items : props.items.slice(0, COLLAPSED_ITEMS);
  return (
    <If when={props.items.length}>
      <View testID={`list:${props.kind}`} style={{ gap: space[8] }}>
        <Label variant="small" weight={weight.strong}>
          {props.heading}
        </Label>
        <SmoothScroll style={{ maxHeight: listHeight }} scrollbar={false}>
          <View style={{ gap: space[8] }}>
            <Each of={shown()} key={(item) => item.name}>
              {(item) => <ItemCard kind={props.kind} item={item()} />}
            </Each>
          </View>
        </SmoothScroll>
        <If when={props.items.length > COLLAPSED_ITEMS}>
          <TextLink
            testID={`list-toggle:${props.kind}`}
            label={
              all()
                ? uiText("showFewerItems")
                : uiText("showAllItems", { count: String(props.items.length) })
            }
            onPress={() => all.set(!all())}
          />
        </If>
      </View>
    </If>
  );
}

const HASH = /[0-9a-f]{40}/g;

/** "name version" once: a version that starts with the name drops it, and a 40-digit hash keeps 7. */
function serverLabel(
  name: string | null,
  version: string | null,
): { text: string; full: string } {
  const full = [name, version].filter(Boolean).join(" ");
  let rest = version ?? "";
  if (name) {
    for (const lead of [`${name}/`, `${name} `, `${name}@`])
      if (rest.startsWith(lead)) rest = rest.slice(lead.length);
  }
  rest = rest.replace(HASH, (hash) => hash.slice(0, 7));
  return { text: [name, rest].filter(Boolean).join(" "), full };
}

/** The server's name and version on one line, and what it offers as small chips. */
function ResultInfo(props: { result: PluginTestResult }) {
  const c = colors();
  const label = () =>
    serverLabel(props.result.serverName, props.result.serverVersion);
  const chips = () =>
    [
      props.result.toolCount == null
        ? null
        : counted("countTool", props.result.toolCount),
      props.result.resourceCount == null
        ? null
        : counted("countResource", props.result.resourceCount),
      props.result.promptCount == null
        ? null
        : counted("countPrompt", props.result.promptCount),
    ].filter((text): text is string => text !== null);
  return (
    <View
      testID="result-info"
      style={{ ...row, flexWrap: "wrap", gap: space[8], alignItems: "center" }}
    >
      <If when={label().text}>
        <View
          tooltip={hint(label().full, c)}
          style={{ flexShrink: 1, minWidth: 0 }}
        >
          <Label variant="small" weight={weight.strong} lines={1}>
            {label().text}
          </Label>
        </View>
      </If>
      <Each of={chips()} key={(text) => text}>
        {(text) => (
          <View
            style={{
              paddingVertical: 1,
              paddingHorizontal: space[4],
              borderWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label variant="small" tone="muted">
              {text()}
            </Label>
          </View>
        )}
      </Each>
    </View>
  );
}

/**
 * The Cursor account sign-in of a Cursor-hosted server, on the server's own box: shown from what the
 * host knows (the address, and whether the credential header is saved), not from a test. Without a
 * saved credential it is offered at once; with one, again only after a test the server did not accept.
 * An older host does not send the two fields; a test result that names Cursor then stands in for them.
 */
function CursorLoginRow(props: {
  item: PluginView;
  server: PluginServerView;
  test: Test;
}) {
  const type = textFaces();
  const result = props.test.result;
  const isCursor = () =>
    props.server.cursorServer === true || result()?.cursorServer === true;
  const signedIn = () => props.server.cursorSignedIn === true;
  const rejected = () =>
    result()?.status === "needs_login" || result()?.status === "failed";
  const offered = () =>
    props.item.enabled &&
    isCursor() &&
    props.test.cursorId() === undefined &&
    (!signedIn() || rejected());
  return (
    <>
      <If when={offered()}>
        <View style={{ gap: space[8] }}>
          <Label
            variant="small"
            tone="muted"
            style={{ lineHeight: type("small").prose }}
          >
            {signedIn()
              ? uiText("cursorReloginNote")
              : uiText("cursorLoginNote")}
          </Label>
          <View style={{ ...row, gap: space[8] }}>
            <Button
              label={
                signedIn() ? uiText("cursorRelogin") : uiText("cursorLogin")
              }
              tone="plain"
              labelVariant="body"
              size={control.md}
              disabled={props.test.busy()}
              onPress={() =>
                props.test.cursorLogin(
                  result()?.requiredHeader ?? CURSOR_AUTH_HEADER,
                )
              }
            />
          </View>
        </View>
      </If>
      <If when={props.test.cursorId() !== undefined}>
        <View style={{ ...row, gap: space[8], flexWrap: "wrap" }}>
          <Label variant="small" tone="muted">
            {uiText("cursorLoginWaiting")}
          </Label>
          <Button
            label={uiText("cursorLoginCancel")}
            tone="plain"
            labelVariant="body"
            size={control.md}
            onPress={props.test.cursorCancel}
          />
        </View>
      </If>
      <If when={props.test.cursorNote()}>
        <Label variant="small" tone="muted">
          {props.test.cursorNote()}
        </Label>
      </If>
    </>
  );
}

function TestResultView(props: { test: Test; stdio: boolean }) {
  const result = props.test.result;
  return (
    <View style={{ gap: space[8] }}>
      <If when={props.stdio}>
        <Label variant="small" tone="muted">
          {uiText("testStdioHint")}
        </Label>
      </If>
      <If when={result()}>
        <View style={{ gap: space[8] }}>
          <Label variant="small" weight={weight.strong}>
            {testLabel(result()!) +
              (REQUEST_MADE.has(result()!.status)
                ? ` · ${result()!.ms} ms`
                : "")}
          </Label>
          <If when={result()!.message}>
            <Label variant="small" tone="muted">
              {result()!.message}
            </Label>
          </If>
          <If when={result()!.status === "ok"}>
            <ResultInfo result={result()!} />
            <ItemList
              kind="tool"
              heading={uiText("toolsHeading", {
                count: String(result()!.toolCount),
              })}
              items={result()!.tools}
            />
            <ItemList
              kind="resource"
              heading={uiText("resourcesHeading", {
                count: String(result()!.resourceCount ?? 0),
              })}
              items={result()!.resources ?? []}
            />
            <ItemList
              kind="prompt"
              heading={uiText("promptsHeading", {
                count: String(result()!.promptCount ?? 0),
              })}
              items={result()!.prompts ?? []}
            />
          </If>
        </View>
      </If>
    </View>
  );
}

const clip = (text: string): string =>
  text.length > 160 ? `${text.slice(0, 157)}…` : text;

/** The skills a plugin holds, read-only; the same list the card counts. Text is shown as plain text. */
export function SkillRows(props: { item: PluginView }) {
  const c = colors();
  return (
    <View style={{ gap: space[8] }}>
      <Label variant="subtitle" weight={weight.strong}>
        {uiText("pluginSkillsHeading")}
      </Label>
      <If when={!props.item.skills.length}>
        <Label variant="small" tone="muted">
          {uiText("pluginNoSkills")}
        </Label>
      </If>
      {/* One column when narrow; cards keep a readable basis and wrap into two when there is room. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[8] }}>
        <Each of={props.item.skills} key={(skill) => skill.name}>
          {(skill) => (
            <View
              testID={`skill-card:${skill().name}`}
              style={{
                flexGrow: 1,
                flexShrink: 1,
                flexBasis: 280,
                gap: space[4],
                padding: space[12],
                borderWidth: 1,
                borderColor: c().border,
              }}
            >
              <Label variant="subtitle" weight={weight.strong}>
                {skill().name}
              </Label>
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
    <View style={{ gap: space[12] }}>
      <If when={!hostKnowsHeaders(props.item)}>
        <Label variant="small" tone="muted">
          {uiText("hostNeedsUpdate")}
        </Label>
      </If>
      <MissingValues item={props.item} />
      <Each of={props.item.servers} key={(server) => server.name}>
        {(server) => {
          const test = createTest({ item: props.item, server: server().name });
          return (
            <View
              style={{
                gap: space[12],
                padding: space[16],
                borderWidth: 1,
                borderColor: c().border,
              }}
            >
              <View
                testID={`server-head:${server().name}`}
                style={{
                  ...row,
                  gap: space[8],
                  alignItems: "center",
                  flexWrap: props.phone ? "wrap" : "nowrap",
                }}
              >
                {/* What may give way is the left cluster; the buttons are never squeezed. A phone has
                    no room for both on one line: the cluster takes its own, the buttons go under it. */}
                <View
                  style={{
                    ...row,
                    flexShrink: 1,
                    minWidth: 0,
                    ...(props.phone ? { width: "100%" } : {}),
                    gap: space[8],
                    alignItems: "center",
                  }}
                >
                  <View
                    style={{ flexShrink: 1, minWidth: 0 }}
                    tooltip={hint(server().name, c)}
                  >
                    <Label variant="subtitle" weight={weight.strong} lines={1}>
                      {server().name}
                    </Label>
                  </View>
                  <Label
                    variant="small"
                    tone={props.phone ? "ink" : "mutedInk"}
                    lines={1}
                    style={{
                      flexShrink: 0,
                      paddingHorizontal: space[4],
                      borderWidth: 1,
                      borderColor: c().strong,
                    }}
                  >
                    {server().transport}
                  </Label>
                  <View style={{ flexShrink: 1, minWidth: 0 }}>
                    <ServerBadge
                      item={props.item}
                      server={server()}
                      test={test}
                    />
                  </View>
                </View>
                <View style={{ flex: 1 }} />
                <View
                  testID={`test-slot:${server().name}`}
                  style={{ flexShrink: 0 }}
                >
                  <TestButton test={test} />
                </View>
                <View
                  testID={`login-slot:${server().name}`}
                  style={{ flexShrink: 0 }}
                >
                  <LoginButton
                    item={props.item}
                    server={server()}
                    test={test}
                  />
                </View>
              </View>
              <If
                when={
                  (server().env ?? []).length || (server().headers ?? []).length
                }
              >
                <View
                  style={{
                    ...row,
                    flexWrap: "wrap",
                    columnGap: space[12],
                    rowGap: space[4],
                  }}
                >
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
                </View>
              </If>
              <CursorLoginRow item={props.item} server={server()} test={test} />
              <TestResultView
                test={test}
                stdio={server().transport === "stdio"}
              />
              <If
                when={
                  server().transport === "stdio" && props.item.env !== undefined
                }
              >
                <EnvEditor item={props.item} server={server().name} />
              </If>
              <If
                when={
                  server().transport !== "stdio" && hostKnowsHeaders(props.item)
                }
              >
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
  return (
    <Modal
      title={uiText("serversTitle", { name: props.item.name })}
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      compact={!props.phone}
      titleWeight={weight.regular}
      width={dialogWidth.xl}
      overPhoneNavigation={props.phone}
      onClose={props.onClose}
    >
      <SmoothScroll style={{ maxHeight: bodyHeight }} scrollbar={false}>
        <View style={{ padding: space[20], gap: space[12] }}>
          <Label variant="subtitle" weight={weight.strong}>
            {uiText("serversHeading")}
          </Label>
          <ServerRows item={props.item} phone={props.phone} />
          <SkillRows item={props.item} />
        </View>
      </SmoothScroll>
    </Modal>
  );
}
