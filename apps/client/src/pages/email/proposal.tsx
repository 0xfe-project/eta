import type { EmailProposalView } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  Field,
  Icon,
  Label,
  row,
  textFaces,
  textStyle,
} from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** An email an agent proposed. One still waiting for the user is open by
 * default; a sent or sending one folds to a one-line note and opens read-only. */
export function EmailProposal(props: { item: EmailProposalView }) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const subject = signal(props.item.subject);
  const body = signal(props.item.markdown);
  const to = signal(props.item.to);
  const busy = signal(false);
  const closed = () =>
    props.item.status === "accepted" || props.item.status === "sending";
  const open = signal(!closed());
  const failed = () => props.item.status === "failed";
  const status = () =>
    props.item.status === "accepted"
      ? uiText("proposalSent")
      : props.item.status === "sending"
        ? uiText("proposalSending")
        : failed()
          ? uiText("sendFailed")
          : uiText("needsConfirmation");
  async function decide(send: boolean) {
    if (busy()) return;
    busy.set(true);
    await host.action(() =>
      send
        ? host.call("email", "confirmProposal", {
            proposalId: props.item.id,
            subject: subject(),
            markdown: body(),
            to: to(),
          })
        : host.call("email", "discardProposal", { proposalId: props.item.id }),
    );
    busy.set(false);
  }
  const fieldStyle = {
    flex: 1,
    height: 28,
    paddingHorizontal: 10,
    ...textStyle(type("small")),
    borderColor: c().strong,
  };
  return (
    <View
      style={{ padding: 12, gap: 12, borderWidth: 1, borderColor: c().strong }}
    >
      <View
        role="button"
        accessibilityLabel={uiText("proposedEmail")}
        accessibilityState={{ expanded: open() }}
        onPress={() => open.set(!open())}
        style={{ ...row, gap: 8, cursor: "pointer" }}
      >
        <Icon name="send" size={14} />
        <Label weight={600} style={{ flex: 1 }}>
          {props.item.kind === "reply" ? uiText("reply") : uiText("newEmail")}
        </Label>
        <View style={{ ...row, gap: 6 }}>
          <If when={!closed()}>
            <View
              style={{
                width: 6,
                height: 6,
                backgroundColor: failed() ? c().red : c().warning,
              }}
            />
          </If>
          <Label variant="small" tone="muted">
            {status()}
          </Label>
        </View>
        <View
          style={{ transform: open() ? [{ rotate: "180deg" }] : undefined }}
        >
          <Icon name="down" size={14} tone="muted" />
        </View>
      </View>
      <If
        when={open()}
        else={
          <View
            role="button"
            accessibilityLabel={uiText("expand")}
            onPress={() => open.set(true)}
            style={{
              ...row,
              gap: 12,
              paddingVertical: 8,
              paddingHorizontal: 12,
              borderWidth: 1,
              borderColor: c().border,
              cursor: "pointer",
            }}
          >
            <Label variant="small" tone="muted" style={{ flex: 1 }}>
              {props.item.status === "accepted"
                ? uiText("proposalSentHint")
                : props.item.status === "sending"
                  ? uiText("proposalSendingHint")
                  : uiText("proposalNotSentHint")}
            </Label>
            <Label variant="small" tone="muted">
              {uiText("expand")}
            </Label>
          </View>
        }
      >
        <If
          when={!closed()}
          else={
            <View style={{ gap: 8 }}>
              <ProposalRow label={uiText("to2")}>
                <ProposalValue value={props.item.to} />
              </ProposalRow>
              <ProposalRow label={uiText("subject")}>
                <ProposalValue value={props.item.subject} />
              </ProposalRow>
              <ProposalRow label={uiText("body")} top>
                <ProposalValue value={props.item.markdown} body />
              </ProposalRow>
            </View>
          }
        >
          <View style={{ gap: 8 }}>
            <ProposalRow label={uiText("to2")}>
              <Field
                label={uiText("to2")}
                value={to()}
                onChange={to.set}
                style={fieldStyle}
              />
            </ProposalRow>
            <ProposalRow label={uiText("subject")}>
              <Field
                label={uiText("subject")}
                value={subject()}
                onChange={subject.set}
                style={fieldStyle}
              />
            </ProposalRow>
            <ProposalRow label={uiText("body")} top>
              <Field
                label={uiText("emailBody")}
                value={body()}
                onChange={body.set}
                multiline
                style={{
                  ...fieldStyle,
                  height: undefined,
                  minHeight: 48,
                  paddingVertical: 6,
                  lineHeight: type("small").prose,
                }}
              />
            </ProposalRow>
          </View>
          <If when={props.item.error}>
            <Label variant="small" tone="red">
              {props.item.error}
            </Label>
          </If>
          <View style={{ ...row, gap: 8, justifyContent: "flex-end" }}>
            <Button
              label={uiText("discard")}
              icon="trash"
              iconSize={12}
              tone="ghost"
              size={24}
              style={{ gap: 6 }}
              disabled={busy()}
              onPress={() => void decide(false)}
            />
            <Button
              label={uiText("confirmAndSend")}
              tone="primary"
              size={24}
              disabled={busy() || !to().trim()}
              onPress={() => void decide(true)}
            />
          </View>
        </If>
      </If>
    </View>
  );
}

/** A 56pt right-aligned label beside its field. */
function ProposalRow(props: {
  label: string;
  top?: boolean;
  children: JSX.Element;
}) {
  return (
    <View
      style={{
        ...row,
        gap: 8,
        alignItems: props.top ? "flex-start" : "center",
      }}
    >
      <Label
        variant="small"
        tone="mutedInk"
        style={{
          width: 56,
          flexShrink: 0,
          textAlign: "right",
          paddingTop: props.top ? 6 : 0,
        }}
      >
        {props.label}
      </Label>
      {props.children}
    </View>
  );
}

/** A sent proposal's field, shown as text in the field's box. */
function ProposalValue(props: { value: string; body?: boolean }) {
  const c = colors();
  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        justifyContent: "center",
        minHeight: props.body ? 48 : 28,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: c().strong,
      }}
    >
      <Label variant="small">{props.value}</Label>
    </View>
  );
}
