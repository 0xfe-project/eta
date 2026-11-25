import type { McpResults, McpServerView } from "@eta/client-contracts";
import type { Layout } from "../../../components";
import { openUrl, signal, View } from "nsh";
import {
  Button,
  colors,
  Field,
  grow,
  Header,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../../components";
import { StatusDot } from "../../../components/status-dot";
import { control, space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { problemText } from "../../../services/problem-text";

import { CopyButton } from "../../../ui";
import {
  McpPhoneHeader,
  serverStatus,
  statusTone,
  toolsDescription,
  transportDescription,
} from "./server-presentation";

/** A fact's value beside its label, and the sign-out confirmation's sheet. */
const valueWidth = "70%";
const signOutHeight = 188;
function McpFact(props: { label: string; value: string }) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        minHeight: control.touch,
        gap: space[12],
        paddingHorizontal: space[16],
        paddingVertical: space[8],
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Label style={{ flex: 1 }}>{props.label}</Label>
      <Label
        variant="small"
        tone="muted"
        style={{ maxWidth: valueWidth, textAlign: "right" }}
      >
        {props.value}
      </Label>
    </View>
  );
}

export function McpDetail(props: {
  item: () => McpServerView;
  layout: Layout;
  onBack: () => void;
}) {
  const host = useHost();
  const c = colors();
  const login = signal<McpResults["login"]>();
  const callback = signal("");
  const confirm = signal(false);
  const busyAction = signal<"" | "login" | "complete" | "logout" | "reconnect">(
    "",
  );
  const busy = () => !!busyAction();
  const feedback = signal("");
  const phone = () => props.layout === "phone";
  const server = props.item;
  const signInNeeded = () => server().auth === "needs_login";
  const signedIn = () => server().auth === "signed_in";
  const ref = () => ({ agentId: server().agentId, server: server().server });
  const operating = () =>
    !server().overriddenBy && server().state !== "disabled";
  async function run(
    actionName: "login" | "complete" | "logout" | "reconnect",
    action: () => Promise<void>,
  ) {
    if (busy()) return;
    busyAction.set(actionName);
    feedback.set("");
    try {
      await host.action(action);
    } finally {
      busyAction.set("");
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
            inset={space[16]}
            onBack={props.onBack}
          />
        }
      >
        <McpPhoneHeader title={server().server} onBack={props.onBack} />
      </If>
      <SmoothScroll style={grow} scrollbar={false}>
        <View
          style={{
            ...row,
            minHeight: control.touch,
            gap: space[4],
            paddingHorizontal: space[16],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <StatusDot color={c()[statusTone(server())]} />
          <Label variant="small" tone="mutedInk">
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
            variant="small"
            tone="muted"
            style={{
              paddingHorizontal: space[16],
              paddingVertical: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            {uiText("mcpSignInHint")}
          </Label>
        </If>
        <If when={feedback() || server().error}>
          <Label variant="small" tone="red" style={{ padding: space[16] }}>
            {feedback() || problemText(server().error ?? "")}
          </Label>
        </If>
        <If when={login() && signInNeeded() ? login() : undefined}>
          {(flow) => (
            <View style={{ padding: space[16], gap: space[8] }}>
              <Label variant="small" tone="muted">
                {uiText("mcpReturnHint")}
              </Label>
              <View style={{ ...row, gap: space[8], flexWrap: "wrap" }}>
                <Button
                  label={uiText("openSignInPage")}
                  onPress={() => void openUrl(flow().authorizationUrl)}
                />
                <CopyButton
                  label={uiText("copyLink")}
                  value={() => flow().authorizationUrl}
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
                disabled={
                  !callback().trim() || (busy() && busyAction() !== "complete")
                }
                busy={busyAction() === "complete"}
                onPress={() =>
                  void run("complete", async () => {
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
      </SmoothScroll>
      <If when={operating()}>
        <View
          style={{
            ...(phone() ? {} : { ...row, justifyContent: "flex-end" }),
            gap: space[8],
            paddingHorizontal: space[16],
            paddingVertical: space[12],
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <If when={signInNeeded() && host.can("mcp.login")}>
            <Button
              label={uiText("signIn")}
              tone="primary"
              size={phone() ? control.lg : control.sm}
              disabled={busy() && busyAction() !== "login"}
              busy={busyAction() === "login"}
              onPress={() =>
                void run("login", async () => {
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
              size={phone() ? control.lg : control.sm}
              disabled={busy()}
              onPress={() => confirm.set(true)}
            />
          </If>
          <If when={host.can("mcp.reconnect")}>
            <Button
              label={uiText("mcpReload")}
              icon="refresh"
              spinIcon
              size={phone() ? control.lg : control.sm}
              disabled={busy() && busyAction() !== "reconnect"}
              busy={busyAction() === "reconnect"}
              onPress={() =>
                void run("reconnect", async () => {
                  const result = await host.call<McpResults["reconnect"]>(
                    "mcp",
                    "reconnect",
                    ref(),
                  );
                  if (!result.ok)
                    feedback.set(
                      result.message
                        ? problemText(result.message)
                        : uiText("mcpReloadFailed"),
                    );
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
          height={signOutHeight}
          onClose={() => confirm.set(false)}
        >
          <View style={{ padding: space[16], gap: space[12] }}>
            <Label variant="small" tone="muted">
              {uiText("mcpSignOutHint")}
            </Label>
            <View style={{ ...row, justifyContent: "flex-end", gap: space[8] }}>
              <Button
                label={uiText("cancel")}
                onPress={() => confirm.set(false)}
              />
              <Button
                label={uiText("signOut")}
                disabled={busy() && busyAction() !== "logout"}
                busy={busyAction() === "logout"}
                onPress={() =>
                  void run("logout", async () => {
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
