import type {
  MemberView,
  MessageView,
  ProjectResults,
} from "@eta/client-contracts";
import type { DocNode } from "@eta/client-contracts/composer-doc";
import type { MenuItem } from "@eta/client-contracts/composer-menu";
import type { Outgoing } from "./composer-draft";
import { MAX_ATTACHMENTS } from "@eta/client-contracts";
import { DOC_NODES, isBlankDoc } from "@eta/client-contracts/composer-doc";
import {
  composerTarget,
  mentionLabel,
} from "@eta/client-contracts/composer-target";
import {
  computed,
  effect,
  keyboardFrame,
  signal,
  untracked,
  View,
  windowSize,
} from "nsh";

import { Button, colors, focusRing, Icon, Label, row } from "../../components";
import {
  attachment,
  chatText,
  draft,
  limit,
  mention,
  quote,
  serialize,
  submitKeys,
} from "../../components/eta-editor";
import { control, icon, opacity, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { OutboxRows } from "./composer-delivery";
import { drainOutbox, openComposerDraft } from "./composer-draft";

import { ComposerRecipients } from "./composer-recipients";
import { HeldMessages } from "./held-messages";

import { activeReply } from "./member-status";

interface ComposerProps {
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
  /** Text the reader selected in a reply: it goes after the draft as a quote. */
  quote?: { conversationId: string; text: string } | undefined;
}

/** Quotes already put in a draft: a composer made again (the chat opened again) skips them. */
const quoted = new WeakSet<object>();

/** The chat's composer: its outbox and queue above, the editor (`chatText.Editor`) and its bar. */
export function Composer(props: ComposerProps) {
  const host = useHost();
  const origin = host.address()!.origin;
  const store = openComposerDraft(origin, props.id);
  return (
    <If when={store.ready()} else={<ComposerShell phone={props.phone} />}>
      {() => <ComposerBody {...props} store={store} origin={origin} />}
    </If>
  );
}

/** The box while the saved draft loads: its outline, so the layout does not jump. */
/** About the composer's height with an empty draft. */
const shellHeight = 84;

function ComposerShell(props: { phone: boolean }) {
  const c = colors();
  return (
    <View
      style={{
        paddingVertical: props.phone ? space[12] : space[16],
        paddingHorizontal: props.phone ? space[12] : space[16],
        paddingTop: space[8],
        flexShrink: 0,
      }}
    >
      <View
        style={{ height: shellHeight, borderWidth: 1, borderColor: c().ink }}
      />
    </View>
  );
}

function ComposerBody(
  props: ComposerProps & {
    store: ReturnType<typeof openComposerDraft>;
    origin: string;
  },
) {
  const host = useHost();
  const c = colors();
  const { store, origin } = props;
  const conversationId = props.id;
  const flush = () => void drainOutbox(store, host, origin, conversationId);
  const { edit } = store;
  const offline = () => props.phone && host.disconnected();
  const blocked = () => !!props.blocked;

  const members = computed(() =>
    props.members.map((member) => ({
      id: member.agentId,
      name: host.agent(member.agentId)?.name ?? member.agentId,
      busy: activeReply(member.status),
    })),
  );
  const files = signal<string[]>([]);
  let filesAsked = false;
  function askFiles() {
    if (filesAsked || !props.projectId) return;
    filesAsked = true;
    void host
      .call<ProjectResults["files"]>("projects", "files", {
        projectId: props.projectId,
      })
      .then((result) => files.set(result.files))
      .catch(() => {
        filesAsked = false;
      });
  }
  function describe(item: MenuItem) {
    if (item.kind === "task") return item.label;
    if (item.kind === "file") return uiText("projectFile");
    return uiText(item.hint ? "memberWorking" : "askForAReply");
  }

  const uploads = store.uploads(host, conversationId);
  const files$ = attachment({ uploads, blocked });
  const limits = limit();
  const out = serialize(uploads);
  const quotes = quote();
  // Upload states change without the document changing: re-read them for the Send button.
  effect(() => {
    store.states();
    out.refresh();
  });
  /** The members as `@` names them, for reading a message's mentions back. */
  const mentionRefs = () =>
    members().map((member) => ({
      id: member.id,
      label: mentionLabel(member, members()),
    }));
  // The chat's text (formatted, Markdown as you type; long pastes folded; code as code) with the
  // composer's own: the send keys, `@`, files, the draft, the length limit, quotes.
  const editor = chatText.createEditor({
    doc: untracked(() => store.value().doc),
    plugins: [
      submitKeys({
        onSubmit: () => send(),
        escape: () =>
          props.writing && out.state().blank ? stopConversation : undefined,
      }),
      // A direct chat has one member: `@` offers the project's files and `#` the tasks there,
      // not people.
      mention({
        members: props.group
          ? () =>
              members().map((member) => ({
                ...member,
                name: mentionLabel(member, members()),
              }))
          : undefined,
        files,
        onFiles: askFiles,
        tasks: () => host.tasks(),
        groupId: conversationId,
        describe,
        wide: () => props.tablet,
      }),
      files$,
      draft({ save: (doc) => edit({ doc }) }),
      limits,
      quotes,
      out,
    ],
  });
  // A chat opened again with a draft in it takes the keyboard, to go on writing.
  const resume = untracked(() => !isBlankDoc(editor.doc())) && !props.blocked;

  const text = computed(() => {
    editor.revision();
    return out.text();
  });
  const target = computed(() =>
    composerTarget({
      text: text(),
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

  /** Markdown as blocks to put in the box. */
  const blocksOf = (doc: DocNode) => doc.content ?? [];
  /** Text put in from outside (a held message pulled back, a widget's prompt): above the draft. */
  function prepend(value: string) {
    const nodes = blocksOf(
      chatText.read({ text: value, mentions: mentionRefs() }),
    );
    if (isBlankDoc(editor.doc())) editor.insert(nodes);
    else editor.insert([...nodes, { type: DOC_NODES.paragraph }], 0);
    editor.focus();
  }
  let appliedWidgetDraft: typeof props.widgetDraft;
  effect(() => {
    const suggestion = props.widgetDraft;
    if (
      !suggestion ||
      suggestion === appliedWidgetDraft ||
      suggestion.conversationId !== conversationId
    )
      return;
    appliedWidgetDraft = suggestion;
    untracked(() => prepend(suggestion.text));
  });
  effect(() => {
    const selected = props.quote;
    if (
      props.blocked ||
      !selected ||
      quoted.has(selected) ||
      selected.conversationId !== conversationId
    )
      return;
    quoted.add(selected);
    untracked(() => quotes.append(selected.text));
  });

  function stopConversation() {
    void host.action(() =>
      host.call("conversations", "stop", { conversationId }),
    );
  }
  const state = () => out.state();
  const sendable = () =>
    !limits.tooLong() &&
    !offline() &&
    !state().blank &&
    !state().uploading &&
    !state().failed &&
    !props.blocked &&
    state().files <= MAX_ATTACHMENTS;
  const outgoing = () => store.value().outgoing;
  function removeOutgoing(id: string) {
    return outgoing().filter((item) => item.id !== id);
  }
  function send() {
    if (!sendable()) return;
    const targetAtSend = target();
    const sent = out.read();
    store.forget(
      host,
      conversationId,
      sent.attachments.map((file) => file.id),
    );
    edit({
      sticky: props.group ? targetAtSend.sticky : undefined,
      outgoing: [
        ...outgoing(),
        {
          id: crypto.randomUUID(),
          text: sent.text,
          blocks: sent.blocks,
          mentions: props.group ? targetAtSend.mentions : undefined,
          attachments: sent.attachments,
        },
      ],
    });
    editor.clear();
    flush();
    editor.focus();
  }
  /** A failed send back in the box to edit, above what is there. */
  function restore(message: Outgoing) {
    store.remember(message.attachments);
    // Its words as they were written (formatting, folded pastes, mentions), its files after them.
    const nodes = blocksOf(
      chatText.read({
        text: message.text,
        blocks: message.blocks,
        mentions: mentionRefs(),
      }),
    );
    if (message.attachments.length)
      nodes.push({
        type: DOC_NODES.paragraph,
        content: message.attachments.map((file) => ({
          type: DOC_NODES.file,
          attrs: {
            id: file.id,
            name: file.name,
            contentType: file.contentType,
            size: file.size,
          },
        })),
      });
    edit({ outgoing: removeOutgoing(message.id) });
    if (isBlankDoc(editor.doc()))
      editor.setDoc({ type: DOC_NODES.doc, content: nodes });
    else editor.insert(nodes, 0);
    editor.focus();
  }
  function toggle(id: string) {
    const selected = target().ids;
    const next = selected.includes(id)
      ? selected.filter((entry) => entry !== id)
      : [...selected, id];
    edit({ sticky: next.length ? next : undefined });
  }
  const attachDisabled = () => !!props.blocked || offline();
  return (
    <View
      testID="conversation-composer"
      style={{
        position: "relative",
        // design-value: order inside the conversation, so the composer's popovers draw over the transcript
        zIndex: 2,
        paddingVertical: props.phone ? space[12] : space[16],
        paddingHorizontal: props.phone
          ? space[12]
          : props.alignWithContent
            ? 0
            : space[16],
        paddingTop: space[8],
        gap: space[8],
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
        <View style={{ ...row, gap: space[4] }}>
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
        onPullBack={prepend}
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
      <If when={limits.tooLong()}>
        <Label tone="warning" variant="small">
          {uiText("composerTooLong")}
        </Label>
      </If>
      <View
        accessibilityState={{ disabled: offline() }}
        style={{
          position: "relative",
          borderWidth: 1,
          borderColor: c().ink,
          opacity: offline() ? opacity.disabled : 1,
          pointerEvents: offline() ? "none" : undefined,
        }}
      >
        <View
          style={{
            flexDirection: props.phone ? "row" : "column",
            alignItems: props.phone ? "center" : "stretch",
          }}
        >
          <chatText.Editor
            editor={editor}
            label={uiText("message")}
            placeholder={uiText("messageWithCount", { name: props.name })}
            editable={!props.blocked && !offline()}
            autoFocus={resume}
            maxHeight={
              // Of the screen above the keyboard while it is up.
              (windowSize().height - keyboardFrame().height) * 0.4
            }
            padding={{
              top: props.phone ? 11 : 12,
              bottom: props.phone ? 11 : 14,
              left: 12,
              right: props.phone ? 6 : 12,
            }}
            style={{ flex: props.phone ? 1 : undefined }}
          />
          <View
            style={{
              ...row,
              height: space[40],
              paddingLeft: props.phone ? 0 : space[12],
              paddingRight: space[8],
              gap: props.phone ? space[4] : space[12],
              backgroundColor: props.phone ? c().canvas : c().surface,
              borderTopWidth: props.phone ? 0 : 1,
              borderColor: c().border,
            }}
          >
            <View
              role="button"
              accessibilityLabel={uiText("attachFiles")}
              accessibilityState={{ disabled: attachDisabled() }}
              onPress={() => {
                if (!attachDisabled())
                  void host.action(() => files$.pick(editor));
              }}
              hoverStyle={{ opacity: opacity.muted }}
              focusVisibleStyle={focusRing(c())}
              style={{
                ...row,
                justifyContent: "center",
                width: props.phone ? control.lg : icon.md,
                height: props.phone ? control.lg : icon.md,
                flexShrink: 0,
                opacity: attachDisabled() ? opacity.disabled : 1,
                cursor: attachDisabled() ? "default" : "pointer",
              }}
            >
              <Icon name="plus" size={icon.md} tone="muted" />
            </View>
            <View style={{ flex: props.phone ? 0 : 1 }} />
            <Button
              label={uiText("send")}
              icon={props.phone ? "arrowUp" : undefined}
              iconOnly={props.phone}
              end={props.phone ? undefined : "return"}
              size={props.phone ? control.lg : control.md}
              iconSize={props.phone ? icon.md : undefined}
              labelVariant="caption"
              labelWeight={weight.regular}
              style={
                props.phone
                  ? undefined
                  : { paddingHorizontal: space[12], gap: space[8] }
              }
              tone="primary"
              dimDisabled={
                state().uploading > 0 || state().failed > 0 || !!props.blocked
              }
              disabled={!sendable()}
              onPress={send}
            />
          </View>
        </View>
      </View>
    </View>
  );
}
