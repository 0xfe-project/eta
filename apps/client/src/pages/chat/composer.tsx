import type {
  AttachmentView,
  ConversationResults,
  MemberView,
  MessageView,
} from "@eta/client-contracts";
import {
  ATTACH_CHUNK_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
} from "@eta/client-contracts";
import { effect, Picker, signal, View } from "nsh";
import { Button, Caption, colors, Field, Label, row } from "../../components";
import { AgentFace } from "../../components/agent-face";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { ComposerRecipients } from "./composer-recipients";

import { activeReply } from "./member-status";

export function Composer(props: {
  id: string;
  name: string;
  members: MemberView[];
  steward?: string | null;
  group: boolean;
  phone: boolean;
  alignWithContent?: boolean;
  held: MessageView[];
  widgetDraft?: { conversationId: string; text: string } | undefined;
}) {
  const host = useHost();
  const c = colors();
  const draft = signal("");
  const mentions = signal<string[] | null>(null);
  const attachments = signal<AttachmentView[]>([]);
  const busy = signal(false);
  let appliedWidgetDraft: typeof props.widgetDraft;
  effect(() => {
    const suggestion = props.widgetDraft;
    if (
      busy() ||
      !suggestion ||
      suggestion === appliedWidgetDraft ||
      suggestion.conversationId !== props.id
    )
      return;
    appliedWidgetDraft = suggestion;
    draft.update((text) =>
      text ? `${text}\n${suggestion.text}` : suggestion.text,
    );
  });
  const uploading = signal(false);
  const mode = signal<"queue" | "steer">("queue");
  let attempt: { id: string; content: string } | undefined;
  const running = () =>
    props.members.some((member) => activeReply(member.status));
  const recipients = () =>
    mentions() ??
    (props.steward
      ? [props.steward]
      : props.members.length === 1
        ? [props.members[0]!.agentId]
        : []);
  const names = () =>
    recipients()
      .map((id) => host.agent(id)?.name)
      .filter(Boolean)
      .join(", ");
  const mentionQuery = () =>
    props.group ? /(?:^|\s)@([^\s@]*)$/.exec(draft())?.[1] : undefined;
  const choices = () => {
    const query = mentionQuery()?.toLowerCase();
    return query === undefined
      ? []
      : props.members
          .flatMap((member) => {
            const agent = host.agent(member.agentId);
            return agent && agent.name.toLowerCase().includes(query)
              ? [agent]
              : [];
          })
          .slice(0, 5);
  };
  function chooseMention(id: string, name: string) {
    draft.update((value) => value.replace(/@[^\s@]*$/, `@${name} `));
    mentions.update((current) => [...new Set([...(current ?? []), id])]);
  }
  function submit() {
    const first = choices()[0];
    if (first) chooseMention(first.id, first.name);
    else void send();
  }
  const sendable = () =>
    (draft().trim() || attachments().length) &&
    !busy() &&
    !uploading() &&
    host.state().status === "open";
  async function send() {
    if (!sendable()) return;
    busy.set(true);
    const outgoing = {
      conversationId: props.id,
      text: draft().trim(),
      mentions: mentions() ?? undefined,
      mode: mode(),
      attachments: attachments().map((file) => file.id),
    };
    const content = JSON.stringify(outgoing);
    if (attempt?.content !== content)
      attempt = { id: crypto.randomUUID(), content };
    const clientId = attempt.id;
    const result = await host.action(() =>
      host.call<ConversationResults["send"]>("conversations", "send", {
        ...outgoing,
        clientId,
      }),
    );
    busy.set(false);
    if (result) {
      draft.set("");
      attachments.set([]);
      mentions.set(null);
      mode.set("queue");
      attempt = undefined;
    }
  }
  async function attach() {
    if (uploading() || busy()) return;
    uploading.set(true);
    await host.action(async () => {
      const chosen = await Picker.pickFiles({
        multiple: true,
        maxSize: MAX_ATTACHMENT_BYTES,
      });
      if (chosen.length + attachments().length > MAX_ATTACHMENTS)
        throw new Error(
          `A message can carry up to ${MAX_ATTACHMENTS} attachments.`,
        );
      for (const file of chosen) {
        if (!file.file)
          throw new Error(`${file.name} exceeds the attachment size limit.`);
        const bytes = new Uint8Array(await file.file.arrayBuffer());
        const id = crypto.randomUUID();
        try {
          for (
            let offset = 0, index = 0;
            offset < bytes.length || index === 0;
            offset += ATTACH_CHUNK_BYTES, index++
          ) {
            const result = await host.call<ConversationResults["attach"]>(
              "conversations",
              "attach",
              {
                conversationId: props.id,
                uploadId: id,
                name: file.name,
                contentType: file.type ?? undefined,
                index,
                last: offset + ATTACH_CHUNK_BYTES >= bytes.length,
                data: Buffer.from(
                  bytes.subarray(offset, offset + ATTACH_CHUNK_BYTES),
                ).toString("base64"),
              },
            );
            if (result.attachment)
              attachments.update((list) => [...list, result.attachment!]);
          }
        } catch (error) {
          await host
            .call("conversations", "unattach", {
              conversationId: props.id,
              attachmentId: id,
            })
            .catch(() => {});
          throw error;
        }
      }
    });
    uploading.set(false);
  }
  function toggle(id: string) {
    const selected = recipients();
    const next = selected.includes(id)
      ? selected.filter((entry) => entry !== id)
      : [...selected, id];
    mentions.set(next.length ? next : null);
  }
  return (
    <View
      style={{
        position: "relative",
        zIndex: 2,
        paddingVertical: props.phone ? 12 : 16,
        paddingHorizontal: props.phone ? 12 : props.alignWithContent ? 0 : 16,
        paddingTop: 8,
        gap: 8,
        flexShrink: 0,
        borderTopWidth: props.phone ? 1 : 0,
        borderColor: c().border,
        backgroundColor: c().canvas,
      }}
    >
      <If when={choices().length && !busy()}>
        <View
          role="group"
          accessibilityLabel={uiText("mentionAnAgent")}
          style={{
            position: "absolute",
            bottom: "100%",
            left: props.phone ? 12 : 16,
            zIndex: 3,
            minWidth: 180,
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
            padding: 4,
            gap: 2,
          }}
        >
          <Caption
            text={uiText("mentionAnAgent")}
            style={{ paddingHorizontal: 8, paddingVertical: 3 }}
          />
          <Each of={choices()} key={(entry) => entry.id}>
            {(entry) => (
              <View
                role="button"
                accessibilityLabel={uiText("mention", { name: entry().name })}
                onPress={() => chooseMention(entry().id, entry().name)}
                hoverStyle={{ backgroundColor: c().selected }}
                style={{
                  ...row,
                  minHeight: 28,
                  paddingHorizontal: 8,
                  gap: 8,
                  cursor: "pointer",
                }}
              >
                <AgentFace id={entry().id} size={16} />
                <Label size={12}>{entry().name}</Label>
              </View>
            )}
          </Each>
        </View>
      </If>
      <Each of={props.held} key={(message) => message.id}>
        {(message) => (
          <View style={{ ...row, gap: 6 }}>
            <Label size={12} tone="muted" style={{ flex: 1 }} lines={1}>
              {uiText("queuedWithCount", { text: message().text })}
            </Label>
            <Button
              label={uiText("steer")}
              onPress={() =>
                void host.action(() =>
                  host.call("conversations", "steerHeld", {
                    conversationId: props.id,
                    messageId: message().id,
                  }),
                )
              }
            />
            <Button
              label={uiText("recall")}
              onPress={() =>
                void host.action(async () => {
                  const result = await host.call<ConversationResults["recall"]>(
                    "conversations",
                    "recall",
                    { conversationId: props.id, messageId: message().id },
                  );
                  if (result.recalled)
                    draft.update((text) =>
                      [text, message().text].filter(Boolean).join("\n"),
                    );
                })
              }
            />
          </View>
        )}
      </Each>
      <If when={props.group}>
        <ComposerRecipients
          phone={props.phone}
          members={props.members}
          steward={props.steward}
          mentions={mentions()}
          recipients={recipients()}
          running={running()}
          names={names()}
          mode={mode()}
          onChangeMentions={mentions.set}
          onToggleRecipient={toggle}
        />
      </If>
      <If when={attachments().length}>
        <View style={{ ...row, flexWrap: "wrap", gap: 5 }}>
          <Each of={attachments()} key={(file) => file.id}>
            {(file) => (
              <Button
                label={file().name}
                end="close"
                disabled={busy()}
                onPress={() =>
                  void host.action(async () => {
                    await host.call("conversations", "unattach", {
                      conversationId: props.id,
                      attachmentId: file().id,
                    });
                    attachments.update((list) =>
                      list.filter((entry) => entry.id !== file().id),
                    );
                  })
                }
              />
            )}
          </Each>
        </View>
      </If>
      <View
        style={{
          borderWidth: 1,
          borderColor: c().ink,
          flexDirection: props.phone ? "row" : "column",
          alignItems: props.phone ? "center" : "stretch",
        }}
      >
        <Field
          label={uiText("message")}
          placeholder={uiText("messageWithCount", { name: props.name })}
          multiline={!props.phone}
          value={draft()}
          onChange={(value) => {
            if (!busy()) draft.set(value);
          }}
          onSubmit={submit}
          style={{
            height: props.phone ? 42 : 48,
            flex: props.phone ? 1 : undefined,
            borderWidth: 0,
            paddingVertical: props.phone ? 7 : 12,
            paddingHorizontal: 12,
          }}
        />
        <View
          style={{
            ...row,
            height: 40,
            paddingLeft: props.phone ? 0 : 7,
            paddingRight: 6,
            gap: 6,
            backgroundColor: props.phone ? c().canvas : c().surface,
            borderTopWidth: props.phone ? 0 : 1,
            borderColor: c().border,
          }}
        >
          <Button
            label={uiText("attachFiles")}
            icon="clip"
            iconOnly
            tone="ghost"
            disabled={uploading() || busy()}
            onPress={() => void attach()}
          />
          <View style={{ flex: props.phone ? 0 : 1 }} />
          <If when={running() && !props.phone}>
            <Button
              label={mode() === "queue" ? uiText("queue") : uiText("steer")}
              onPress={() => mode.set(mode() === "queue" ? "steer" : "queue")}
            />
            <Button
              label={uiText("stop")}
              onPress={() =>
                void host.action(() =>
                  host.call("conversations", "stop", {
                    conversationId: props.id,
                  }),
                )
              }
            />
          </If>
          <Button
            label={uiText("send")}
            icon={props.phone ? "arrowUp" : undefined}
            iconOnly={props.phone}
            end={props.phone ? undefined : "return"}
            size={props.phone ? 32 : 28}
            labelSize={11}
            tone="primary"
            dimDisabled={busy() || uploading()}
            disabled={!sendable()}
            onPress={() => void send()}
          />
        </View>
      </View>
    </View>
  );
}
