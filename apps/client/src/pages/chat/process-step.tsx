import type { EmailProposalView, RunBlock } from "@eta/client-contracts";
import { commandOf } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Caption, colors, Label, Markdown, row } from "../../components";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { EmailProposal } from "../email/proposal";

export function ProcessStep(props: { value: RunBlock }) {
  const host = useHost();
  const c = colors();
  const tool = () => (props.value.type === "tool" ? props.value : undefined);
  const expanded = signal(false);
  const emailProposalId = () => {
    const step = tool();
    const details = step?.details;
    return step &&
      ["send_email", "reply"].includes(step.name) &&
      details &&
      typeof details === "object" &&
      "emailProposalId" in details &&
      typeof details.emailProposalId === "string"
      ? details.emailProposalId
      : undefined;
  };
  follow(() => (emailProposalId() ? "email" : undefined));
  const emailProposal = () => {
    const id = emailProposalId();
    if (!id) return undefined;
    return host
      .list<EmailProposalView>("email", "proposals")
      .find(
        (item) =>
          item.id === id &&
          (item.status === "pending" || item.status === "failed"),
      );
  };
  const title = () => {
    const step = tool();
    if (!step) return "";
    const input = step.input;
    const path =
      input &&
      typeof input === "object" &&
      "path" in input &&
      typeof input.path === "string"
        ? input.path
        : undefined;
    const detail = commandOf(input) ?? path;
    return step.name + (detail ? ` · ${detail}` : "");
  };
  return (
    <If
      when={emailProposal()}
      else={
        <If
          when={tool()}
          else={
            <View
              style={{
                padding: 8,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <If
                when={props.value.type === "text"}
                else={
                  <Label size={12} tone="muted">
                    {props.value.type === "thinking"
                      ? props.value.text
                      : uiText("messageJoinedThisRun")}
                  </Label>
                }
              >
                <Markdown
                  value={props.value.type === "text" ? props.value.text : ""}
                  line={22}
                  streaming
                />
              </If>
            </View>
          }
        >
          {(step) => (
            <View>
              <View
                role={step().output ? "button" : undefined}
                onPress={
                  step().output ? () => expanded.set(!expanded()) : undefined
                }
                style={{
                  ...row,
                  minHeight: 33,
                  paddingHorizontal: 10,
                  gap: 8,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Label size={12} lines={1} style={{ flex: 1 }}>
                  {title()}
                </Label>
                <Caption
                  text={
                    step().status === "running"
                      ? uiText("inProgress")
                      : step().status === "completed"
                        ? uiText("done")
                        : uiText("failed")
                  }
                  style={
                    step().status === "running"
                      ? {
                          backgroundColor: c().button,
                          color: c().buttonInk,
                          paddingHorizontal: 8,
                          paddingVertical: 2,
                          lineHeight: 12,
                          letterSpacing: 1,
                          fontWeight: 600,
                        }
                      : { lineHeight: 12, letterSpacing: 1, color: c().faint }
                  }
                />
              </View>
              <If when={expanded() && step().output}>
                <View style={{ padding: 8, backgroundColor: c().surface }}>
                  <Label size={12} tone="muted">
                    {step().output}
                  </Label>
                </View>
              </If>
            </View>
          )}
        </If>
      }
    >
      {(proposal) => <EmailProposal item={proposal()} />}
    </If>
  );
}
