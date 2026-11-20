import type {
  CaptainOperationView,
  InboxResponse,
  InteractionView,
} from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  Field,
  grow,
  Label,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";

export function Question(props: {
  item: InteractionView;
  onDone?: () => void;
  onConversation?: () => void;
  sheet?: boolean;
}) {
  const host = useHost();
  const c = colors();
  const selected = signal<string[]>([]);
  const reply = signal("");
  const busy = signal(false);
  const conversation = () =>
    host.conversations().find((item) => item.id === props.item.conversationId);
  async function answer(response: InboxResponse) {
    if (busy()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call("inbox", "answer", { id: props.item.id, response }),
    );
    busy.set(false);
    if (result) props.onDone?.();
  }
  function toggle(option: string) {
    selected.update((items) =>
      items.includes(option)
        ? items.filter((item) => item !== option)
        : props.item.multi
          ? [...items, option]
          : [option],
    );
  }
  function submit() {
    return answer(
      selected().length
        ? {
            kind: "selection",
            selections: selected(),
            comment: reply().trim() || undefined,
          }
        : { kind: "freeform", text: reply().trim() },
    );
  }
  return (
    <View
      style={{
        ...(props.sheet ? grow : {}),
        borderWidth: props.sheet ? 0 : 1,
        borderColor: c().border,
        backgroundColor: c().canvas,
      }}
    >
      <Scroll style={props.sheet ? grow : undefined} scrollbar={false}>
        <View style={{ padding: props.sheet ? 16 : 12, gap: 8 }}>
          <If when={props.sheet} else={<Caption text={uiText("question")} />}>
            <Label size={11} tone="muted">
              {[conversation()?.name, relativeTime(props.item.createdAt)]
                .filter(Boolean)
                .join(" · ")}
            </Label>
          </If>
          <Label size={props.sheet ? 16 : 14}>{props.item.prompt}</Label>
          <View
            style={
              props.sheet ? { gap: 8 } : { ...row, flexWrap: "wrap", gap: 6 }
            }
          >
            <Each of={props.item.options}>
              {(option) => (
                <Button
                  label={option()}
                  selected={selected().includes(option())}
                  tone={
                    props.sheet && selected().includes(option())
                      ? "primary"
                      : "plain"
                  }
                  end={
                    props.sheet && selected().includes(option())
                      ? "check"
                      : undefined
                  }
                  size={props.sheet ? 44 : undefined}
                  labelSize={props.sheet ? 14 : undefined}
                  style={
                    props.sheet
                      ? {
                          width: "100%",
                          justifyContent: "space-between",
                          paddingHorizontal: 12,
                        }
                      : undefined
                  }
                  onPress={() => toggle(option())}
                />
              )}
            </Each>
          </View>
          <Field
            label={uiText("yourAnswer")}
            value={reply()}
            placeholder={
              props.sheet
                ? uiText("orWriteYourOwnAnswer")
                : uiText("yourAnswerProgress")
            }
            onChange={reply.set}
            style={props.sheet ? { height: 43 } : undefined}
          />
        </View>
      </Scroll>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          gap: 8,
          padding: props.sheet ? 16 : 12,
          borderTopWidth: props.sheet ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <If when={props.sheet && props.onConversation}>
          <Button
            label={uiText("openConversation")}
            tone="ghost"
            onPress={() => props.onConversation?.()}
          />
          <View style={{ flex: 1 }} />
        </If>
        <If when={!props.sheet}>
          <Button
            label={uiText("skip")}
            disabled={busy()}
            onPress={() => void answer({ kind: "none" })}
          />
        </If>
        <Button
          label={props.sheet ? uiText("sendAnswer") : uiText("answer")}
          tone="primary"
          size={props.sheet ? 36 : undefined}
          disabled={busy() || (!selected().length && !reply().trim())}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

export function Proposal(props: {
  operation: CaptainOperationView;
  sheet?: boolean;
  onConversation?: () => void;
}) {
  const host = useHost();
  const c = colors();
  const working = signal(false);
  const title = () =>
    String(
      props.operation.payload.name ??
        props.operation.payload.title ??
        props.operation.kind.replaceAll("_", " "),
    );
  async function decide(decision: "approve" | "reject") {
    if (working()) return;
    working.set(true);
    await host.action(() =>
      host.call("captain", "decideOperation", {
        operationId: props.operation.id,
        decision,
      }),
    );
    working.set(false);
  }
  return (
    <View
      style={{
        ...(props.sheet ? grow : {}),
        borderWidth: props.sheet ? 0 : 1,
        borderColor: c().border,
        padding: props.sheet ? 16 : 10,
        gap: props.sheet ? 10 : 5,
      }}
    >
      <Caption text={props.operation.kind.replaceAll("_", " ")} />
      <Label weight={600} size={props.sheet ? 16 : 14}>
        {title()}
      </Label>
      <Each
        of={Object.entries(props.operation.payload).filter(
          ([key, value]) =>
            !["name", "title"].includes(key) &&
            !key.endsWith("Id") &&
            typeof value === "string",
        )}
      >
        {(detail) => (
          <Label size={12} tone="muted">
            {String(detail()[1])}
          </Label>
        )}
      </Each>
      <If
        when={
          props.operation.requiresApproval &&
          props.operation.status === "pending"
        }
        else={
          <Label size={12} tone="muted">
            {props.operation.error ?? props.operation.status}
          </Label>
        }
      >
        <If when={props.sheet}>
          <View style={{ flex: 1 }} />
        </If>
        <View style={{ ...row, justifyContent: "flex-end", gap: 6 }}>
          <If when={props.sheet && props.onConversation}>
            <Button
              label={uiText("openConversation")}
              tone="ghost"
              onPress={() => props.onConversation?.()}
            />
            <View style={{ flex: 1 }} />
          </If>
          <Button
            label={uiText("reject")}
            disabled={working()}
            onPress={() => void decide("reject")}
          />
          <Button
            label={uiText("approve")}
            tone="primary"
            disabled={working()}
            onPress={() => void decide("approve")}
          />
        </View>
      </If>
    </View>
  );
}
