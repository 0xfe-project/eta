import type { EmailProposalView } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Button, Caption, colors, Field, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

export function EmailProposal(props: { item: EmailProposalView }) {
  const host = useHost();
  const c = colors();
  const subject = signal(props.item.subject);
  const body = signal(props.item.markdown);
  const to = signal(props.item.to);
  const busy = signal(false);
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
  return (
    <View
      style={{ padding: 12, borderWidth: 1, borderColor: c().border, gap: 6 }}
    >
      <Caption text={uiText("proposedEmail")} />
      <If when={props.item.error}>
        <Label size={12} tone="red">
          {props.item.error}
        </Label>
      </If>
      <Field label={uiText("to2")} value={to()} onChange={to.set} />
      <Field
        label={uiText("subject")}
        value={subject()}
        onChange={subject.set}
      />
      <Field
        label={uiText("emailBody")}
        value={body()}
        onChange={body.set}
        multiline
        style={{ height: 100 }}
      />
      <View style={{ ...row, gap: 6, justifyContent: "flex-end" }}>
        <Button
          label={uiText("discard")}
          disabled={busy()}
          onPress={() => void decide(false)}
        />
        <Button
          label={uiText("sendEmail")}
          tone="primary"
          disabled={busy() || !to().trim()}
          onPress={() => void decide(true)}
        />
      </View>
    </View>
  );
}
