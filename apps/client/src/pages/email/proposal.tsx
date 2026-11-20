import type { EmailProposalView } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { signal, View } from "nsh";
import { Button, colors, Field, Icon, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** An email an agent proposed, waiting for the user: open by default, it
 * folds to a one-line note. */
export function EmailProposal(props: { item: EmailProposalView }) {
  const host = useHost();
  const c = colors();
  const subject = signal(props.item.subject);
  const body = signal(props.item.markdown);
  const to = signal(props.item.to);
  const busy = signal(false);
  const open = signal(true);
  const failed = () => props.item.status === "failed";
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
    fontSize: 12,
    lineHeight: 16,
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
        <Label size={14} line={18} weight={600} style={{ flex: 1 }}>
          {props.item.kind === "reply" ? uiText("reply") : uiText("newEmail")}
        </Label>
        <View style={{ ...row, gap: 6 }}>
          <View
            style={{
              width: 6,
              height: 6,
              backgroundColor: failed() ? c().red : c().warning,
            }}
          />
          <Label size={12} line={16} tone="muted">
            {failed() ? uiText("sendFailed") : uiText("needsConfirmation")}
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
            <Label size={12} line={16} tone="muted" style={{ flex: 1 }}>
              {uiText("proposalNotSentHint")}
            </Label>
            <Label size={12} line={16} tone="muted">
              {uiText("expand")}
            </Label>
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
                lineHeight: 18,
              }}
            />
          </ProposalRow>
        </View>
        <If when={props.item.error}>
          <Label size={12} line={16} tone="red">
            {props.item.error}
          </Label>
        </If>
        <View style={{ ...row, gap: 8, justifyContent: "flex-end" }}>
          <Button
            label={uiText("discard")}
            icon="trash"
            iconSize={12}
            tone="ghost"
            style={{ gap: 6 }}
            disabled={busy()}
            onPress={() => void decide(false)}
          />
          <Button
            label={uiText("confirmAndSend")}
            tone="primary"
            disabled={busy() || !to().trim()}
            onPress={() => void decide(true)}
          />
        </View>
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
        size={12}
        line={16}
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
