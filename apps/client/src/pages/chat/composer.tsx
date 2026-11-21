import type {
  MemberView,
  MessageView,
  ProjectResults,
} from "@eta/client-contracts";
import type { MenuItem } from "@eta/client-contracts/composer-menu";
import type { InputRef, PasteEvent, ScrollRef, ViewRef } from "nsh";
import type { Outgoing } from "./composer-draft";
import { MAX_ATTACHMENTS } from "@eta/client-contracts";
import {
  draftText,
  draftWithBlocks,
  fileSize,
  isLongPaste,
  MAX_MESSAGE_CHARS,
  plainDraft,
  withTextAbove,
} from "@eta/client-contracts/composer-draft";
import {
  applyItem,
  buildMenu,
  mentionAt,
} from "@eta/client-contracts/composer-menu";
import {
  composerTarget,
  mentionLabel,
} from "@eta/client-contracts/composer-target";
import {
  cleanup,
  computed,
  effect,
  keyboardFrame,
  keymap,
  Scroll,
  signal,
  untracked,
  View,
  windowSize,
} from "nsh";

import {
  Button,
  Caption,
  colors,
  Field,
  Icon,
  Label,
  row,
  textFaces,
} from "../../components";

import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { composerAttachments } from "./composer-attachments";
import { OutboxRows } from "./composer-delivery";
import { drainOutbox, openComposerDraft } from "./composer-draft";
import { ComposerRecipients } from "./composer-recipients";

import { HeldMessages } from "./held-messages";

import { activeReply } from "./member-status";

export function Composer(props: {
  id: string;
  name: string;
  members: MemberView[];
  steward?: string | null;
  group: boolean;
  projectId?: string;
  tablet: boolean;
  writing: boolean;
  blocked?: "archived" | "empty";
  onResolveBlock?: () => void;
  phone: boolean;
  alignWithContent?: boolean;
  held: MessageView[];
  widgetDraft?: { conversationId: string; text: string } | undefined;
}) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const conversationId = props.id;
  const origin = host.address()!.origin;
  const store = openComposerDraft(origin, conversationId);
  const flush = () => void drainOutbox(store, host, origin, conversationId);
  const { ready, uploading, failedUploads, edit } = store;
  const { attach, AttachmentChips } = composerAttachments(
    store,
    conversationId,
    () => !!props.blocked,
  );
  const draft = () => store.value().text;
  const prefix = () => store.value().prefix;
  const parts = () => [...prefix(), ...plainDraft(draft())];
  const fullText = computed(() => draftText(parts()));
  let selection = { start: 0, end: 0 };
  const attachments = () => store.value().attachments;
  const focused = signal(false);
  const textHeight = signal(0);
  const composing = signal(false);
  const dismissed = signal(false);
  const index = signal(0);
  let compositionEnded = -Infinity;
  let input: InputRef | undefined;
  const list = signal<ViewRef>();
  const activeOption = signal<ViewRef>();
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  const focusEditor = () => {
    if (mounted) input?.focus();
  };
  let restoredFocus = false;
  effect(() => {
    if (ready() && !restoredFocus) {
      restoredFocus = true;
      if (untracked(fullText) && !props.blocked) queueMicrotask(focusEditor);
    }
  });
  function prepend(text: string) {
    if (prefix().length) edit({ prefix: withTextAbove(prefix(), text) });
    else edit({ text: [text, draft()].filter(Boolean).join("\n\n") });
  }
  let appliedWidgetDraft: typeof props.widgetDraft;
  effect(() => {
    const suggestion = props.widgetDraft;
    if (
      !ready() ||
      !suggestion ||
      suggestion === appliedWidgetDraft ||
      suggestion.conversationId !== conversationId
    )
      return;
    appliedWidgetDraft = suggestion;
    prepend(suggestion.text);
    focusEditor();
  });
  const members = computed(() =>
    props.members.map((member) => ({
      id: member.agentId,
      name: host.agent(member.agentId)?.name ?? member.agentId,
      busy: activeReply(member.status),
    })),
  );
  const target = computed(() =>
    composerTarget({
      text: fullText(),
      members: members(),
      sticky: store.value().sticky,
      steward: props.steward
        ? {
            id: props.steward,
            name: host.agent(props.steward)?.name ?? props.steward,
          }
        : undefined,
    }),
  );
  const names = () =>
    target()
      .ids.map((id) => host.agent(id)?.name ?? id)
      .join(", ");
  const waitsFor = () =>
    members()
      .filter((member) => member.busy && target().ids.includes(member.id))
      .map((member) => member.name)
      .join(", ");
  const offline = () => props.phone && host.disconnected();
  const files = signal<string[]>([]);
  const wanted = computed(() =>
    mentionAt(draft()) !== null ? props.projectId : undefined,
  );
  effect(() => {
    const projectId = wanted();
    files.set([]);
    if (!projectId) return;
    let active = true;
    void host
      .call<ProjectResults["files"]>("projects", "files", { projectId })
      .then((result) => {
        if (active) files.set(result.files);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  });
  const menu = computed(() =>
    buildMenu({
      text: draft(),
      members: members().map((member) => ({
        ...member,
        name: mentionLabel(member, members()),
      })),
      files: files(),
      tasks: host.tasks(),
      groupId: conversationId,
      dismissed: dismissed() || !!props.blocked || composing(),
    }),
  );
  const choices = () => menu()?.items ?? [];
  const selected = () => Math.min(index(), choices().length - 1);
  let scroll: ScrollRef | undefined;
  const options = new Map<string, ViewRef>();
  effect(() => {
    const active = choices()[selected()];
    const ref = active && options.get(active.value);
    if (ref) activeOption.set(ref);
    scroll?.scrollTo({ y: Math.max(0, selected() - 3) * 28 });
  });
  function description(item: MenuItem) {
    if (item.kind === "task") return item.label;
    if (item.kind === "file") return uiText("projectFile");
    return uiText(item.hint ? "memberWorking" : "askForAReply");
  }
  function change(value: string) {
    if (!ready() || props.blocked || value === draft()) return;
    selection = { start: value.length, end: value.length };
    edit({ text: value });
    dismissed.set(false);
    index.set(0);
  }
  function choose(item: MenuItem) {
    const current = menu();
    if (!current) return;
    change(applyItem(draft(), current, item).text);
    dismissed.set(true);
    focusEditor();
  }
  const imeOwnsKey = () => composing() || Date.now() - compositionEnded < 120;
  function submit() {
    if (imeOwnsKey()) return;
    const item = choices()[selected()];
    if (item) choose(item);
    else void send();
  }
  function stopConversation() {
    void host.action(() =>
      host.call("conversations", "stop", { conversationId }),
    );
  }
  const menuOpen = computed(() => choices().length > 0);
  effect(() => {
    if (!focused() || composing()) return;
    const bindings: Record<string, () => void> = { "alt+enter": submit };
    if (menuOpen()) {
      const move = (step: number) => {
        if (!imeOwnsKey())
          index.set((selected() + step + choices().length) % choices().length);
      };
      Object.assign(bindings, {
        up: () => move(-1),
        down: () => move(1),
        tab: submit,
        escape: () => {
          if (!imeOwnsKey()) dismissed.set(true);
        },
      });
    } else if (props.writing && !fullText().trim() && !attachments().length) {
      bindings.escape = () => {
        if (!imeOwnsKey()) stopConversation();
      };
    }
    return keymap.bind(bindings, { when: "always" });
  });
  const tooLong = () =>
    fullText().length > MAX_MESSAGE_CHARS &&
    Array.from(fullText()).length > MAX_MESSAGE_CHARS;
  const sendable = () =>
    ready() &&
    !tooLong() &&
    !offline() &&
    (fullText().trim() || attachments().length) &&
    !uploading() &&
    !failedUploads().length &&
    !props.blocked &&
    attachments().length <= MAX_ATTACHMENTS;
  const outgoing = () => store.value().outgoing;
  function removeOutgoing(id: string) {
    return outgoing().filter((item) => item.id !== id);
  }
  function send() {
    if (!sendable()) return;
    const targetAtSend = target();
    const sent = draftWithBlocks(parts());
    edit({
      text: "",
      prefix: [],
      attachments: [],
      sticky: props.group ? targetAtSend.sticky : undefined,
      outgoing: [
        ...outgoing(),
        {
          id: crypto.randomUUID(),
          text: sent.text,
          blocks: sent.blocks,
          mentions: props.group ? targetAtSend.mentions : undefined,
          attachments: attachments(),
        },
      ],
    });
    flush();
    dismissed.set(true);
    focusEditor();
  }
  function restore(message: Outgoing) {
    const restored = [];
    let end = 0;
    for (const [start, stop] of message.blocks ?? []) {
      restored.push(...plainDraft(message.text.slice(end, start)), {
        type: "paste" as const,
        id: crypto.randomUUID(),
        text: message.text.slice(start, stop),
      });
      end = stop;
    }
    const tail = message.text.slice(end);
    const separator = message.text && fullText() ? "\n" : "";
    if (prefix().length)
      restored.push(...plainDraft(tail + separator), ...prefix());
    edit({
      outgoing: removeOutgoing(message.id),
      prefix: restored,
      text: prefix().length ? draft() : tail + separator + draft(),
      attachments: [...message.attachments, ...attachments()],
    });
    focusEditor();
  }
  function toggle(id: string) {
    const selected = target().ids;
    const next = selected.includes(id)
      ? selected.filter((entry) => entry !== id)
      : [...selected, id];
    edit({ sticky: next.length ? next : undefined });
  }
  function unfold(index: number) {
    const tail = draftText(prefix().slice(index));
    edit({ prefix: prefix().slice(0, index), text: tail + draft() });
    focusEditor();
    queueMicrotask(() => input?.setSelection(tail.length));
  }
  function removePaste(index: number) {
    const remaining = prefix().filter((_, i) => i !== index);
    const last = remaining.at(-1);
    if (last?.type === "text")
      edit({ prefix: remaining.slice(0, -1), text: last.text + draft() });
    else edit({ prefix: remaining });
    focusEditor();
  }
  function paste(event: PasteEvent) {
    const text = event.text.replace(/\r\n?/g, "\n");
    if (
      event.files.length &&
      !(
        event.html &&
        text.trim() &&
        event.files.every((file) => file.type.startsWith("image/"))
      )
    ) {
      void attach(event.files);
    } else if (text.length > MAX_MESSAGE_CHARS) {
      void attach([
        new File([text], uiText("pastedFile"), {
          type: "text/plain;charset=utf-8",
        }),
      ]);
    } else if (isLongPaste(text)) {
      const { start, end } = selection;
      edit({
        prefix: [
          ...prefix(),
          ...plainDraft(draft().slice(0, start)),
          { type: "paste", id: crypto.randomUUID(), text },
        ],
        text: draft().slice(end),
      });
      selection = { start: 0, end: 0 };
      queueMicrotask(() => input?.setSelection(0));
    } else if (text) {
      // Not `input.insertText`: the native (GPUI) target does not carry it out, so the text was
      // dropped; the draft is the field's value on every target.
      const { start, end } = selection;
      const caret = start + text.length;
      change(draft().slice(0, start) + text + draft().slice(end));
      selection = { start: caret, end: caret };
      queueMicrotask(() => input?.setSelection(caret));
    }
  }
  return (
    <View
      testID="conversation-composer"
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
      <OutboxRows
        messages={outgoing()}
        onRetry={(id) => {
          edit({
            outgoing: outgoing().map((item) =>
              item.id === id ? { ...item, failure: undefined } : item,
            ),
          });
          flush();
        }}
        onEdit={restore}
        onDiscard={(id) => edit({ outgoing: removeOutgoing(id) })}
      />
      <If when={props.blocked}>
        <View style={{ ...row, gap: 6 }}>
          <Label variant="small">
            {uiText(
              props.blocked === "archived"
                ? "archivedComposer"
                : "emptyComposer",
            )}
          </Label>
          <Button
            label={uiText(
              props.blocked === "archived" ? "unarchive" : "members",
            )}
            onPress={() => props.onResolveBlock?.()}
          />
        </View>
      </If>
      <HeldMessages
        messages={props.held}
        conversationId={conversationId}
        phone={props.phone}
        onPullBack={(text) => {
          prepend(text);
          focusEditor();
        }}
      />
      <If when={props.group}>
        <ComposerRecipients
          conversationId={props.id}
          phone={props.phone}
          members={props.members}
          steward={props.steward}
          tablet={props.tablet}
          mentions={
            target().kind === "everyone"
              ? props.members.map((member) => member.agentId)
              : null
          }
          recipients={target().ids}
          running={members()
            .filter((member) => member.busy)
            .map((member) => member.id)}
          names={names()}
          waitsFor={waitsFor()}
          onChangeMentions={(mentions) =>
            edit({ sticky: mentions ? "everyone" : undefined })
          }
          onToggleRecipient={toggle}
        />
      </If>
      <If when={tooLong()}>
        <Label tone="amber" variant="small">
          {uiText("composerTooLong")}
        </Label>
      </If>
      <View
        accessibilityState={{ disabled: offline() }}
        style={{
          position: "relative",
          borderWidth: 1,
          borderColor: c().ink,
          opacity: offline() ? 0.45 : 1,
          pointerEvents: offline() ? "none" : undefined,
        }}
      >
        <If when={menuOpen()}>
          <View
            ref={list.set}
            role="listbox"
            accessibilityLabel={uiText("mentionAnAgent")}
            style={{
              position: "absolute",
              bottom: "100%",
              left: -1,
              right: props.tablet ? -1 : undefined,
              zIndex: 3,
              width: props.tablet ? undefined : 300,
              maxWidth: props.tablet ? undefined : "100%",
              borderWidth: 1,
              borderColor: c().strong,
              backgroundColor: c().canvas,
              boxShadow: props.tablet
                ? undefined
                : [{ x: 0, y: 4, blur: 12, color: `${c().ink}1f` }],
            }}
          >
            <Caption
              text={uiText(menu()?.kind === "hash" ? "tasks" : "mentions")}
              style={{ paddingHorizontal: 10, paddingTop: 6, paddingBottom: 4 }}
            />
            <Scroll
              ref={(ref) => {
                scroll = ref;
              }}
              style={{ maxHeight: 224, flexShrink: 1 }}
            >
              <Each of={choices()} key={(entry) => entry.kind + entry.value}>
                {(entry, i) => (
                  <View
                    ref={(ref) => {
                      options.set(entry().value, ref);
                      if (selected() === i()) activeOption.set(ref);
                    }}
                    onMouseEnter={() => index.set(i())}
                    role="option"
                    accessibilityLabel={
                      entry().kind === "member"
                        ? uiText("mention", { name: entry().label })
                        : entry().value.trim()
                    }
                    accessibilityState={{ selected: selected() === i() }}
                    onPress={() => choose(entry())}
                    hoverStyle={
                      selected() === i()
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
                        selected() === i() ? c().ink : "transparent",
                    }}
                  >
                    <Label
                      variant="small"
                      weight={600}
                      lines={1}
                      tone={selected() === i() ? "canvas" : "ink"}
                    >
                      {entry().value.trim()}
                    </Label>
                    <Label
                      variant="small"
                      lines={1}
                      tone={selected() === i() ? "canvas" : "muted"}
                      style={{ opacity: selected() === i() ? 0.75 : 1 }}
                    >
                      {description(entry())}
                    </Label>
                  </View>
                )}
              </Each>
            </Scroll>
          </View>
        </If>
        <If when={prefix().length}>
          <View style={{ ...row, flexWrap: "wrap", gap: 4 }}>
            <Each of={prefix()}>
              {(part, i) => (
                <If when={part().type !== "file"}>
                  {() => {
                    const contents = () => draftText([part()]);
                    return (
                      <View style={{ ...row, maxWidth: "100%" }}>
                        <Button
                          label={
                            part().type === "paste"
                              ? uiText("pastedBlock", {
                                  size: fileSize(
                                    new TextEncoder().encode(contents()).length,
                                  ),
                                })
                              : contents()
                          }
                          size={24}
                          onPress={() => unfold(i())}
                        />
                        <If when={part().type === "paste"}>
                          <Button
                            label={uiText("removePaste")}
                            icon="close"
                            iconOnly
                            size={24}
                            onPress={() => removePaste(i())}
                          />
                        </If>
                      </View>
                    );
                  }}
                </If>
              )}
            </Each>
          </View>
        </If>
        <AttachmentChips />
        <View
          style={{
            flexDirection: props.phone ? "row" : "column",
            alignItems: props.phone ? "center" : "stretch",
          }}
        >
          <Field
            inputRef={(ref) => {
              input = ref;
            }}
            role="combobox"
            label={uiText("message")}
            accessibilityState={{
              expanded: menuOpen(),
              disabled: !ready() || !!props.blocked || offline(),
            }}
            accessibilityControls={menuOpen() ? list() : undefined}
            accessibilityActiveDescendant={
              menuOpen() ? activeOption() : undefined
            }
            placeholder={
              prefix().length
                ? ""
                : uiText("messageWithCount", { name: props.name })
            }
            multiline
            readonly={!ready() || !!props.blocked || offline()}
            value={draft()}
            onChange={change}
            onSubmit={submit}
            onContentSizeChange={({ size }) => textHeight.set(size.height)}
            onSelectionChange={(range) => {
              selection = range;
            }}
            onFocus={() => focused.set(true)}
            onBlur={() => focused.set(false)}
            onCompositionChange={({ composing: active }) => {
              if (!active && composing()) compositionEnded = Date.now();
              composing.set(active);
            }}
            pasteBehavior="report"
            onPaste={paste}
            style={{
              lineHeight: type("body").prose,
              height: Math.min(
                // Of the screen above the keyboard while it is up.
                (windowSize().height - keyboardFrame().height) * 0.4,
                Math.max(type("body").prose, textHeight()) +
                  (props.phone ? 22 : 26),
              ),
              flex: props.phone ? 1 : undefined,
              borderWidth: 0,
              paddingTop: props.phone ? 11 : 12,
              paddingBottom: props.phone ? 11 : 14,
              paddingLeft: 12,
              paddingRight: props.phone ? 6 : 12,
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
              accessibilityState={{
                disabled: !ready() || uploading() || !!props.blocked,
              }}
              onPress={() => {
                if (ready() && !uploading() && !props.blocked) void attach();
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
                opacity: !ready() || uploading() || !!props.blocked ? 0.45 : 1,
                cursor:
                  !ready() || uploading() || !!props.blocked
                    ? "default"
                    : "pointer",
              }}
            >
              <Icon name="clip" size={props.phone ? 16 : 14} tone="muted" />
            </View>
            <View style={{ flex: props.phone ? 0 : 1 }} />
            <If when={props.writing && !props.phone}>
              <Button
                icon="stop"
                label={uiText("stop")}
                size={28}
                onPress={stopConversation}
              />
            </If>
            <Button
              label={uiText("send")}
              icon={props.phone ? "arrowUp" : undefined}
              iconOnly={props.phone}
              end={props.phone ? undefined : "return"}
              size={props.phone ? 32 : 28}
              iconSize={props.phone ? 16 : undefined}
              labelVariant="caption"
              labelWeight={500}
              style={
                props.phone ? undefined : { paddingHorizontal: 10, gap: 8 }
              }
              tone="primary"
              dimDisabled={uploading() || !!props.blocked}
              disabled={!sendable()}
              onPress={() => void send()}
            />
          </View>
        </View>
      </View>
    </View>
  );
}
