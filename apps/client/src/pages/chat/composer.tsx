import type {
  MemberView,
  MessageView,
  ProjectResults,
} from "@eta/client-contracts";
import type { MenuItem } from "@eta/client-contracts/composer-menu";
import type { RichNodeJSON } from "nsh/base";
import type { Outgoing } from "./composer-draft";
import { MAX_ATTACHMENTS } from "@eta/client-contracts";
import {
  draftToDoc,
  isBlankDoc,
  sentToDraft,
  textToNodes,
} from "@eta/client-contracts/composer-doc";
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
import { insertContent, insertContentAt } from "nsh/base";

import { Button, colors, Icon, Label, row } from "../../components";
import {
  attachment,
  createEtaEditor,
  draft,
  EtaEditor,
  limit,
  mention,
  pasteBlock,
  plainText,
  serialize,
  submitKeys,
} from "../../components/eta-editor";
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
}

/** The chat's composer: its outbox and queue above, the editor (`EtaEditor`) and its bar. */
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
function ComposerShell(props: { phone: boolean }) {
  const c = colors();
  return (
    <View
      style={{
        paddingVertical: props.phone ? 12 : 16,
        paddingHorizontal: props.phone ? 12 : 16,
        paddingTop: 8,
        flexShrink: 0,
      }}
    >
      <View style={{ height: 82, borderWidth: 1, borderColor: c().ink }} />
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
  // Upload states change without the document changing: re-read them for the Send button.
  effect(() => {
    store.states();
    out.refresh();
  });
  const editor = createEtaEditor({
    doc: untracked(() => store.value().doc),
    plugins: [
      plainText(),
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
      pasteBlock(),
      files$,
      draft({ save: (doc) => edit({ doc }) }),
      limits,
      out,
    ],
  });
  // A chat opened again with a draft in it takes the keyboard, to go on writing.
  const resume = untracked(() => !isBlankDoc(editor.doc())) && !props.blocked;

  const text = computed(() => {
    editor.revision();
    return out.read().text;
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

  /** Text put in from outside (a held message pulled back, a widget's prompt): above the draft. */
  function prepend(value: string) {
    if (isBlankDoc(editor.doc()))
      editor.session.run(insertContent(textToNodes(value) as RichNodeJSON[]));
    else
      editor.session.run(
        insertContentAt(0, [...textToNodes(value), { type: "paragraph" }]),
      );
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
    const nodes = (draftToDoc(sentToDraft(message)).content ??
      []) as RichNodeJSON[];
    edit({ outgoing: removeOutgoing(message.id) });
    if (isBlankDoc(editor.doc()))
      editor.session.setContent({ type: "doc", content: nodes });
    else editor.session.run(insertContentAt(0, nodes));
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
        <View
          style={{
            flexDirection: props.phone ? "row" : "column",
            alignItems: props.phone ? "center" : "stretch",
          }}
        >
          <EtaEditor
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
              accessibilityState={{ disabled: attachDisabled() }}
              onPress={() => {
                if (!attachDisabled())
                  void host.action(() => files$.pick(editor));
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
                opacity: attachDisabled() ? 0.45 : 1,
                cursor: attachDisabled() ? "default" : "pointer",
              }}
            >
              <Icon name="plus" size={props.phone ? 16 : 14} tone="muted" />
            </View>
            <View style={{ flex: props.phone ? 0 : 1 }} />
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
