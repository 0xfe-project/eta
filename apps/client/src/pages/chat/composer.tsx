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
import { effect, keymap, Picker, signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  Field,
  Icon,
  Label,
  row,
} from "../../components";
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
  onStopMember: (agentId: string) => void;
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
  const showHeld = signal(false);
  const activeMention = signal(0);
  let attempt: { id: string; content: string } | undefined;
  const runningIds = () =>
    props.members
      .filter((member) => activeReply(member.status))
      .map((member) => member.agentId);
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
  // A message to someone still replying waits until that turn ends.
  const waitsFor = () =>
    recipients()
      .filter((id) => runningIds().includes(id))
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
    activeMention.set(0);
  }
  const active = () =>
    choices()[Math.min(activeMention(), choices().length - 1)];
  function submit() {
    const chosen = active();
    if (chosen) chooseMention(chosen.id, chosen.name);
    else void send();
  }
  function moveMention(step: 1 | -1) {
    const count = choices().length;
    if (!count) return;
    activeMention.set(
      (Math.min(activeMention(), count - 1) + step + count) % count,
    );
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
      mode: "queue" as const,
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
      <Each
        of={showHeld() || !props.group ? props.held : []}
        key={(message) => message.id}
      >
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
      <If when={props.group && props.members.length > 1}>
        <ComposerRecipients
          phone={props.phone}
          members={props.members}
          steward={props.steward}
          mentions={mentions()}
          recipients={recipients()}
          running={runningIds()}
          held={props.held.length}
          names={names()}
          waitsFor={waitsFor()}
          onChangeMentions={mentions.set}
          onToggleRecipient={toggle}
          onToggleHeld={() => showHeld.set(!showHeld())}
          onStop={props.onStopMember}
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
          position: "relative",
          borderWidth: 1,
          borderColor: c().ink,
          flexDirection: props.phone ? "row" : "column",
          alignItems: props.phone ? "center" : "stretch",
        }}
      >
        <If when={choices().length && !busy()}>
          <MentionKeys onMove={moveMention} />
          <View
            role="listbox"
            accessibilityLabel={uiText("mentionAnAgent")}
            style={{
              position: "absolute",
              bottom: "100%",
              left: -1,
              zIndex: 3,
              width: 300,
              maxWidth: "100%",
              borderWidth: 1,
              borderColor: c().strong,
              backgroundColor: c().canvas,
              boxShadow: [{ x: 0, y: 4, blur: 12, color: `${c().ink}1f` }],
            }}
          >
            <Caption
              text={uiText("mentions")}
              style={{ paddingHorizontal: 10, paddingTop: 6, paddingBottom: 4 }}
            />
            <Each of={choices()} key={(entry) => entry.id}>
              {(entry) => (
                <View
                  role="option"
                  accessibilityLabel={uiText("mention", { name: entry().name })}
                  accessibilityState={{ selected: active() === entry() }}
                  onPress={() => chooseMention(entry().id, entry().name)}
                  hoverStyle={
                    active() === entry()
                      ? undefined
                      : { backgroundColor: c().selected }
                  }
                  style={{
                    ...row,
                    height: 28,
                    paddingHorizontal: 10,
                    gap: 8,
                    cursor: "pointer",
                    backgroundColor:
                      active() === entry() ? c().ink : "transparent",
                  }}
                >
                  <Label
                    size={12}
                    line={16}
                    weight={600}
                    lines={1}
                    tone={active() === entry() ? "canvas" : "ink"}
                  >
                    {`@${entry().name}`}
                  </Label>
                  <Label
                    size={11}
                    line={16}
                    lines={1}
                    tone={active() === entry() ? "canvas" : "muted"}
                    style={{ opacity: active() === entry() ? 0.75 : 1 }}
                  >
                    {uiText("askForAReply")}
                  </Label>
                </View>
              )}
            </Each>
          </View>
        </If>
        <Field
          label={uiText("message")}
          placeholder={uiText("messageWithCount", { name: props.name })}
          multiline={!props.phone}
          value={draft()}
          onChange={(value) => {
            if (busy()) return;
            draft.set(value);
            activeMention.set(0);
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
            paddingLeft: props.phone ? 0 : 12,
            paddingRight: 6,
            gap: props.phone ? 6 : 12,
            backgroundColor: props.phone ? c().canvas : c().surface,
            borderTopWidth: props.phone ? 0 : 1,
            borderColor: c().border,
          }}
        >
          <View
            role="button"
            accessibilityLabel={uiText("attachFiles")}
            accessibilityState={{ disabled: uploading() || busy() }}
            onPress={() => {
              if (!uploading() && !busy()) void attach();
            }}
            hoverStyle={{ opacity: 0.7 }}
            focusVisibleStyle={{
              outlineWidth: 1,
              outlineColor: c().blue,
              outlineOffset: 1,
            }}
            style={{
              ...row,
              justifyContent: "center",
              width: props.phone ? 32 : 14,
              height: props.phone ? 32 : 14,
              flexShrink: 0,
              opacity: uploading() || busy() ? 0.45 : 1,
              cursor: uploading() || busy() ? "default" : "pointer",
            }}
          >
            <Icon name="clip" size={14} tone="muted" />
          </View>
          <View style={{ flex: props.phone ? 0 : 1 }} />
          <Button
            label={uiText("send")}
            icon={props.phone ? "arrowUp" : undefined}
            iconOnly={props.phone}
            end={props.phone ? undefined : "return"}
            size={props.phone ? 32 : 28}
            labelSize={11}
            labelWeight={500}
            style={props.phone ? undefined : { paddingHorizontal: 10, gap: 8 }}
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

/** Up and Down move through the mention list while it is open, even in the message field. */
function MentionKeys(props: { onMove: (step: 1 | -1) => void }) {
  keymap.bind(
    { up: () => props.onMove(-1), down: () => props.onMove(1) },
    { when: "always" },
  );
  return null;
}
