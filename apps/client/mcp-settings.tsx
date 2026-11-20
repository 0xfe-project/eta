import type { McpResults, McpServerView } from "@eta/client-contracts";
import type { Layout } from "./ui";
import { Clipboard, openUrl, Scroll, signal, View } from "nsh";
import { useHost } from "./host";
import { uiText, useText } from "./locale";
import {
  Button,
  colors,
  Empty,
  Field,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
} from "./ui";

const stateLabels = {
  connected: "mcpConnected",
  cached: "mcpCached",
  "not-connected": "mcpNotConnected",
  failed: "failed",
  "needs-auth": "mcpNeedsSignIn",
  disabled: "mcpDisabled",
} as const;
const lifecycleLabels = {
  lazy: "mcpLazy",
  "keep-alive": "mcpKeepAlive",
  "lazy-keep-alive": "mcpLazyKeepAlive",
} as const;
const transports = { stdio: "stdio", http: "HTTP", sse: "SSE" } as const;

function key(item: McpServerView) {
  return JSON.stringify([item.agentId, item.source, item.server]);
}

function serverStatus(item: McpServerView) {
  return uiText(
    item.auth === "needs_login" ? "mcpNeedsSignIn" : stateLabels[item.state],
  );
}

function transportDescription(item: McpServerView) {
  return `${transports[item.transport]} · ${uiText(lifecycleLabels[item.lifecycle])}`;
}

function toolsDescription(count: number) {
  return uiText(count === 1 ? "mcpOneTool" : "mcpToolCount", { count });
}

function statusTone(item: McpServerView) {
  if (item.state === "failed") return "red";
  if (item.auth === "needs_login") return "amber";
  return item.state === "connected" ? "green" : "muted";
}

function McpPhoneHeader(props: { title: string; onBack: () => void }) {
  const c = colors();
  const text = useText();
  return (
    <View
      style={{
        ...row,
        height: 48,
        flexShrink: 0,
        paddingHorizontal: 8,
        gap: 4,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Button
        label={text("back")}
        icon="back"
        iconOnly
        tone="ghost"
        size={40}
        onPress={props.onBack}
      />
      <Label size={14} line={20} weight={600}>
        {props.title}
      </Label>
    </View>
  );
}

export function McpSettings(props: { layout: Layout; onBack: () => void }) {
  const host = useHost();
  const c = colors();
  const text = useText();
  const selected = signal("");
  const list = () => host.list<McpServerView>("mcp");
  const server = () => list().find((item) => key(item) === selected());
  const groups = () => {
    const sources = new Map<string, McpServerView[]>();
    for (const item of list()) {
      const key = JSON.stringify([item.agentId, item.source]);
      const items = sources.get(key) ?? [];
      items.push(item);
      sources.set(key, items);
    }
    return [...sources.entries()];
  };
  const phone = () => props.layout === "phone";
  return (
    <If
      when={server()}
      else={
        <>
          <If
            when={phone()}
            else={<Header title={text("mcpServers")} layout={props.layout} />}
          >
            <McpPhoneHeader title={text("settings")} onBack={props.onBack} />
          </If>
          <If
            when={list().length}
            else={<Empty title={uiText("noMcpServersConfigured")} />}
          >
            <Scroll style={grow} scrollbar={false}>
              <View
                style={{
                  padding: 16,
                  gap: 4,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <If when={phone()}>
                  <Label weight={600}>{text("mcpServers")}</Label>
                </If>
                <Label size={12} line={16} tone="muted">
                  {uiText("mcpServersHint")}
                </Label>
              </View>
              <Each of={groups()} key={([key]) => key}>
                {(group) => (
                  <View>
                    <View
                      style={{
                        ...row,
                        gap: 8,
                        paddingHorizontal: 16,
                        height: 39,
                        borderBottomWidth: 1,
                        borderColor: c().border,
                      }}
                    >
                      <Label weight={600}>
                        {group()[1][0]?.source === "~/.eta/mcp.json"
                          ? uiText("mcpYourServers")
                          : group()[1][0]?.agentName}
                      </Label>
                      <Label size={12} tone="muted">
                        {group()[1][0]?.source}
                      </Label>
                    </View>
                    <Each of={group()[1]} key={key}>
                      {(item) => (
                        <View
                          role="button"
                          accessibilityLabel={item().server}
                          hoverStyle={{ backgroundColor: c().selected }}
                          style={{
                            ...row,
                            minHeight: 72,
                            gap: 10,
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderBottomWidth: 1,
                            borderColor: c().border,
                            cursor: "pointer",
                          }}
                          onPress={() => selected.set(key(item()))}
                        >
                          <View style={{ flex: 1, gap: 2 }}>
                            <Label line={20} weight={500}>
                              {item().server}
                            </Label>
                            <View style={{ ...row, gap: 6 }}>
                              <View
                                style={{
                                  width: 6,
                                  height: 6,
                                  backgroundColor: c()[statusTone(item())],
                                }}
                              />
                              <Label size={12} line={16} tone="muted">
                                {serverStatus(item())}
                              </Label>
                            </View>
                            <Label size={12} line={16} tone="muted">
                              {[
                                transportDescription(item()),
                                item().auth !== "needs_login"
                                  ? toolsDescription(item().toolCount)
                                  : "",
                                item().auth === "signed_in"
                                  ? uiText("mcpSignedIn")
                                  : "",
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </Label>
                          </View>
                          <Icon name="right" tone="muted" size={10} />
                        </View>
                      )}
                    </Each>
                  </View>
                )}
              </Each>
            </Scroll>
          </If>
        </>
      }
    >
      {(item) => (
        <McpDetail
          item={item}
          layout={props.layout}
          onBack={() => selected.set("")}
        />
      )}
    </If>
  );
}

function McpFact(props: { label: string; value: string }) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        minHeight: 44,
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Label style={{ flex: 1 }}>{props.label}</Label>
      <Label
        size={12}
        line={16}
        tone="muted"
        style={{ maxWidth: "70%", textAlign: "right" }}
      >
        {props.value}
      </Label>
    </View>
  );
}

function McpDetail(props: {
  item: () => McpServerView;
  layout: Layout;
  onBack: () => void;
}) {
  const host = useHost();
  const c = colors();
  const login = signal<McpResults["login"]>();
  const callback = signal("");
  const confirm = signal(false);
  const busy = signal(false);
  const feedback = signal("");
  const phone = () => props.layout === "phone";
  const server = props.item;
  const signInNeeded = () => server().auth === "needs_login";
  const signedIn = () => server().auth === "signed_in";
  const ref = () => ({ agentId: server().agentId, server: server().server });
  const operating = () =>
    !server().overriddenBy && server().state !== "disabled";
  async function run(action: () => Promise<void>) {
    if (busy()) return;
    busy.set(true);
    feedback.set("");
    try {
      await host.action(action);
    } finally {
      busy.set(false);
    }
  }

  return (
    <View style={{ ...grow, backgroundColor: c().canvas }}>
      <If
        when={phone()}
        else={
          <Header
            title={server().server}
            layout={props.layout}
            inset={16}
            onBack={props.onBack}
          />
        }
      >
        <McpPhoneHeader title={server().server} onBack={props.onBack} />
      </If>
      <Scroll style={grow} scrollbar={false}>
        <View
          style={{
            ...row,
            minHeight: 44,
            gap: 6,
            paddingHorizontal: 16,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View
            style={{
              width: 6,
              height: 6,
              backgroundColor: c()[statusTone(server())],
            }}
          />
          <Label size={12} line={16} tone="mutedInk">
            {serverStatus(server())}
          </Label>
        </View>
        <McpFact
          label={uiText("mcpTransport")}
          value={transportDescription(server())}
        />
        <McpFact label={uiText("mcpDefinedIn")} value={server().source} />
        <McpFact
          label={uiText("mcpTools")}
          value={
            signInNeeded()
              ? uiText("externalAgentUnauthenticated")
              : toolsDescription(server().toolCount)
          }
        />
        <If when={server().overriddenBy || server().overrides}>
          <McpFact
            label={uiText(
              server().overriddenBy ? "mcpOverriddenBy" : "mcpOverrides",
            )}
            value={server().overriddenBy?.source ?? server().overrides ?? ""}
          />
        </If>
        <If when={signInNeeded() && operating()}>
          <Label
            size={12}
            line={16}
            tone="muted"
            style={{
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            {uiText("mcpSignInHint")}
          </Label>
        </If>
        <If when={feedback() || server().error}>
          <Label size={12} tone="red" style={{ padding: 16 }}>
            {feedback() || server().error}
          </Label>
        </If>
        <If when={login() && signInNeeded() ? login() : undefined}>
          {(flow) => (
            <View style={{ padding: 16, gap: 8 }}>
              <Label size={12} tone="muted">
                {uiText("mcpReturnHint")}
              </Label>
              <View style={{ ...row, gap: 8, flexWrap: "wrap" }}>
                <Button
                  label={uiText("openSignInPage")}
                  onPress={() => void openUrl(flow().authorizationUrl)}
                />
                <Button
                  label={uiText("copyLink")}
                  onPress={() =>
                    void host.action(() =>
                      Clipboard.writeText(flow().authorizationUrl),
                    )
                  }
                />
              </View>
              <Field
                label={uiText("callbackUrl")}
                placeholder={uiText("pasteTheRedirectedUrl")}
                value={callback()}
                onChange={callback.set}
              />
              <Button
                label={uiText("finishSignIn")}
                disabled={!callback().trim() || busy()}
                onPress={() =>
                  void run(async () => {
                    await host.call("mcp", "completeLogin", {
                      pendingId: flow().pendingId,
                      callbackUrl: callback().trim(),
                    });
                    login.set(undefined);
                    callback.set("");
                  })
                }
              />
            </View>
          )}
        </If>
      </Scroll>
      <If when={operating()}>
        <View
          style={{
            ...(phone() ? {} : { ...row, justifyContent: "flex-end" }),
            gap: 8,
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <If when={signInNeeded() && host.can("mcp.login")}>
            <Button
              label={uiText("signIn")}
              tone="primary"
              size={phone() ? 32 : 24}
              disabled={busy()}
              onPress={() =>
                void run(async () => {
                  const result = await host.call<McpResults["login"]>(
                    "mcp",
                    "login",
                    {
                      ...ref(),
                      redirectOrigin: host.address()?.origin,
                    },
                  );
                  login.set(result);
                  await openUrl(result.authorizationUrl);
                })
              }
            />
          </If>
          <If when={signedIn() && host.can("mcp.logout")}>
            <Button
              label={uiText("signOut")}
              tone="danger"
              size={phone() ? 32 : 24}
              disabled={busy()}
              onPress={() => confirm.set(true)}
            />
          </If>
          <If when={host.can("mcp.reconnect")}>
            <Button
              label={uiText("mcpReload")}
              icon="refresh"
              size={phone() ? 32 : 24}
              disabled={busy()}
              onPress={() =>
                void run(async () => {
                  const result = await host.call<McpResults["reconnect"]>(
                    "mcp",
                    "reconnect",
                    ref(),
                  );
                  if (!result.ok)
                    feedback.set(result.message ?? uiText("mcpReloadFailed"));
                })
              }
            />
          </If>
        </View>
      </If>
      <If when={confirm()}>
        <Modal
          title={uiText("mcpConfirmSignOut", { server: server().server })}
          phone={phone()}
          sheet={phone()}
          height={186}
          onClose={() => confirm.set(false)}
        >
          <View style={{ padding: 16, gap: 12 }}>
            <Label size={13} tone="muted">
              {uiText("mcpSignOutHint")}
            </Label>
            <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
              <Button
                label={uiText("cancel")}
                onPress={() => confirm.set(false)}
              />
              <Button
                label={uiText("signOut")}
                tone="danger"
                disabled={busy()}
                onPress={() =>
                  void run(async () => {
                    await host.call("mcp", "logout", ref());
                    confirm.set(false);
                  })
                }
              />
            </View>
          </View>
        </Modal>
      </If>
    </View>
  );
}
