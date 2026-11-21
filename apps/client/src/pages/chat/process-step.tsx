import type { EmailProposalView, RunBlock } from "@eta/client-contracts";
import { commandOf } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Caption, colors, Icon, Label, Markdown, row } from "../../components";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { EmailProposal } from "../email/proposal";

export function ProcessStep(props: { value: RunBlock }) {
  const host = useHost();
  const c = colors();
  const tool = () => (props.value.type === "tool" ? props.value : undefined);
  // A list recycles a step's view for another step: what was opened is kept
  // for the step it was opened on.
  const opened = signal<string | undefined>(undefined);
  const expanded = () => opened() === props.value.id;
  const toggle = () => opened.set(expanded() ? undefined : props.value.id);
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
            <If
              when={props.value.type === "steer"}
              else={
                <TextStep
                  id={props.value.id}
                  kind={props.value.type === "thinking" ? "thinking" : "note"}
                  text={
                    props.value.type === "thinking" ||
                    props.value.type === "text"
                      ? props.value.text
                      : ""
                  }
                />
              }
            >
              {/* Where the run took words inserted into it: a trace, not the words again. */}
              <View
                style={{
                  paddingVertical: 3,
                  paddingHorizontal: 10,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                  alignItems: "center",
                }}
              >
                <Label size={10} line={14} tone="faint">
                  {uiText("insertReceived")}
                </Label>
              </View>
            </If>
          }
        >
          {(step) => (
            <View>
              <View
                role={step().output ? "button" : undefined}
                onPress={step().output ? toggle : undefined}
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

/**
 * A thought or something the agent said on the way: a small title that opens
 * to it. A thought starts folded, words start open, in small type.
 */
function TextStep(props: {
  id: string;
  kind: "thinking" | "note";
  text: string;
}) {
  const c = colors();
  // Toggled away from how it starts, for the step it was toggled on.
  const toggled = signal<string | undefined>(undefined);
  const open = () => (props.kind === "note") !== (toggled() === props.id);
  const label = () =>
    uiText(props.kind === "thinking" ? "runThinking" : "processNote");
  return (
    <View style={{ borderBottomWidth: 1, borderColor: c().border }}>
      <View
        role="button"
        accessibilityLabel={label()}
        accessibilityState={{ expanded: open() }}
        onPress={() =>
          toggled.set(toggled() === props.id ? undefined : props.id)
        }
        style={{
          ...row,
          gap: 6,
          paddingVertical: 4,
          paddingHorizontal: 10,
          cursor: "pointer",
        }}
      >
        <Icon name={open() ? "down" : "right"} size={8} tone="faint" />
        <Caption text={label()} style={{ color: c().faint }} />
      </View>
      <If when={open()}>
        <View style={{ paddingHorizontal: 10, paddingBottom: 6 }}>
          <If
            when={props.kind === "note"}
            else={
              <Label size={12} line={18} tone="muted">
                {props.text}
              </Label>
            }
          >
            <Markdown
              value={props.text}
              size={12}
              line={18}
              dense
              heading={{ size: 12, line: 18, weight: 600, space: 4, after: 2 }}
              streaming
            />
          </If>
        </View>
      </If>
    </View>
  );
}
