import type { BoardTaskStatus, CompactResult } from "@eta/client-contracts";
import type { InputRef, Signal } from "nsh";
import type { Chat } from "./conversation";
import type { ComposerTarget } from "./mentions";
import type { MenuItem, MenuState } from "./menu";
import type { SendMode, Upload } from "./outbox";
import { MAX_ATTACHMENTS } from "@eta/client-contracts";
import {
  colorScheme,
  computed,
  effect,
  Picker,
  Scroll,
  signal,
  Text,
  View,
} from "nsh";
import { Input } from "nsh/base";
import { agentById, boardTasks, projectById } from "../../app/lists";
import { setScheme } from "../../app/prefs";
import { t } from "../../i18n";
import { go } from "../../nav/links";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { reason } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { SelectSheet } from "../../ui/SelectSheet";
import { toast } from "../../ui/toast";
import { call } from "../../wire/target";
import { BottomInset } from "./BottomInset";
import { TaskStatusIcon, taskStatusLabel } from "./cards";
import { agentName } from "./conversation";
import { composerTarget, mentionLabel } from "./mentions";
import { buildMenu, hashAt, mentionAt } from "./menu";
import {
  attach,
  clearUploads,
  drafts,
  dropUpload,
  send as sendMessage,
  setDraft,
  setSticky,
  stickies,
  uploads,
} from "./outbox";
import { answeringElsewhere } from "./queue";
import { forgetRows, rememberRows } from "./rows";

/** A message's text at most. */
const MAX_MESSAGE_CHARS = 100_000;
/** What the box grows to before it scrolls inside itself. */
const MAX_TEXT_HEIGHT = 120;

type CommandName =
  | "/stop"
  | "/queue"
  | "/steer"
  | "/compact"
  | "/goal"
  | "/theme"
  | "/settings"
  | "/new";

const commands = (): {
  name: CommandName;
  description: string;
  takesText?: boolean;
}[] => [
  { name: "/stop", description: t("chat.command.stop") },
  { name: "/queue", description: t("chat.send.queue"), takesText: true },
  { name: "/steer", description: t("chat.send.steer"), takesText: true },
  { name: "/compact", description: t("chat.command.compact") },
  { name: "/goal", description: t("chat.command.goal"), takesText: true },
  { name: "/theme", description: t("chat.command.theme") },
  { name: "/settings", description: t("chat.command.settings") },
  { name: "/new", description: t("chat.command.new") },
];

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const taskStatus = (item: MenuItem) =>
  (item.kind === "task" ? item.status : "todo") as BoardTaskStatus;

/** One row of the composer's menu. Its first row is what a pick would be on a keyboard. */
function MenuRow(props: {
  item: MenuItem;
  first: boolean;
  edge: boolean;
  onPick: () => void;
}) {
  const item = () => props.item;
  const hint = () => {
    const row = item();
    if (row.kind === "member")
      return row.hint === "busy"
        ? t("chat.mention.busy")
        : t("chat.mention.free");
    if (row.kind === "everyone") return t("chat.mention.everyone");
    return undefined;
  };
  return (
    <View
      role="button"
      accessibilityLabel={item().label}
      onPress={props.onPick}
      class={`h-11 shrink-0 flex-row items-center gap-[10px] px-4 active:bg-muted ${props.first ? "bg-muted" : ""} ${props.edge ? "border-t border-border" : ""}`}
    >
      <If when={item().kind === "member"}>
        <AgentAvatar
          id={(item() as { memberId?: string }).memberId ?? ""}
          size={20}
        />
      </If>
      <If when={item().kind === "everyone"}>
        <View class="size-[20px] shrink-0" />
      </If>
      <If when={item().kind === "file"}>
        <Icon name="fileText" size={18} color="muted-foreground" />
      </If>
      <If when={item().kind === "command"}>
        <Text class="w-[80px] shrink-0 text-base leading-[18px] text-foreground">
          {item().label}
        </Text>
        <Text class="truncate grow basis-0 text-md leading-4 text-muted-foreground">
          {(item() as { description?: string }).description}
        </Text>
      </If>
      <If when={item().kind === "task"}>
        <TaskStatusIcon status={taskStatus(item())} size={16} />
        <Text class="w-[40px] shrink-0 text-md leading-4 text-muted-foreground">
          #{(item() as { number?: number }).number}
        </Text>
      </If>
      <If when={item().kind !== "command"}>
        <Text class="truncate grow basis-0 text-base leading-[18px] text-foreground">
          {item().label}
        </Text>
      </If>
      <If when={hint() !== undefined}>
        <Text class="text-sm leading-4 text-muted-foreground">{hint()}</Text>
      </If>
      <If when={item().kind === "task"}>
        <Text class="text-sm leading-4 text-muted-foreground">
          {taskStatusLabel(taskStatus(item()))}
        </Text>
      </If>
    </View>
  );
}

function UploadChip(props: { upload: Upload }) {
  const state = () =>
    props.upload.error ??
    (props.upload.attachment === undefined
      ? t("chat.attachments.uploading")
      : fileSize(props.upload.size));
  return (
    <View class="h-8 max-w-full flex-row items-center gap-[6px] border border-border pl-2">
      <Icon name="paperclip" size={14} color="muted-foreground" />
      <Text class="truncate max-w-[180px] text-sm leading-4 text-foreground">
        {props.upload.name}
      </Text>
      <Text
        class={`text-sm leading-4 ${props.upload.error === undefined ? "text-muted-foreground" : "text-state-error"}`}
      >
        {state()}
      </Text>
      <View
        role="button"
        accessibilityLabel={t("chat.attachments.remove")}
        onPress={() => dropUpload(props.upload)}
        class="size-8 items-center justify-center active:opacity-60"
      >
        <Icon name="x" size={14} color="muted-foreground" />
      </View>
    </View>
  );
}

/** Why the box cannot be used, with the way out (03g). */
function Blocked(props: {
  message: string;
  action: string;
  onPress: () => void;
}) {
  return (
    <View class="min-h-[52px] flex-row items-center gap-3 border-b border-border px-4 py-2">
      <Text class="grow basis-0 text-md leading-[20px] text-foreground">
        {props.message}
      </Text>
      <View
        role="button"
        accessibilityLabel={props.action}
        onPress={props.onPress}
        class="h-9 shrink-0 items-center justify-center border border-border-strong px-3 active:bg-muted"
      >
        <Text class="text-md leading-4 text-foreground">{props.action}</Text>
      </View>
    </View>
  );
}

function Notice(props: { text: string }) {
  return (
    <View class="min-h-10 flex-row items-center border-b border-border px-4 py-2">
      <Text class="text-md leading-[20px] text-foreground">{props.text}</Text>
    </View>
  );
}

/** Written but waiting for a lane (03a): pull it back into the box, or drop it. Only the host says it is gone. */
function HeldBand(props: { chat: Chat; onPullBack: (text: string) => void }) {
  const busy = signal<string | undefined>(undefined);
  const take = async (messageId: string): Promise<boolean> => {
    busy.set(messageId);
    try {
      const answer = await call<{ recalled: boolean }>(
        "conversations",
        "recall",
        {
          conversationId: props.chat.id,
          messageId,
        },
      );
      if (answer.recalled) forgetRows(props.chat.id, [messageId]);
      return answer.recalled;
    } catch {
      // No answer is not a win: recalling again is free, a duplicated message is not.
      return false;
    } finally {
      busy.set(undefined);
    }
  };
  return (
    <If when={props.chat.held().length > 0}>
      <View class="shrink-0 gap-1 px-4 pb-2">
        <Each of={props.chat.held()} key={(row) => row.id}>
          {(row) => (
            <View class="h-9 shrink-0 flex-row items-center gap-2 border border-border px-[10px]">
              <Text class="text-sm leading-4 text-muted-foreground">
                {t("chat.held.label")}
              </Text>
              <Text class="line-clamp-1 grow basis-0 text-md leading-4 text-foreground">
                {row().text}
              </Text>
              <View
                role="button"
                accessibilityLabel={t("chat.held.pull", { text: row().text })}
                disabled={busy() === row().id}
                onPress={() =>
                  void take(row().id).then((recalled) => {
                    if (recalled) props.onPullBack(row().text);
                  })
                }
                class="h-9 justify-center active:opacity-60"
              >
                <Text class="text-sm leading-4 text-foreground">
                  {t("chat.held.pullAction")}
                </Text>
              </View>
              <View
                role="button"
                accessibilityLabel={t("chat.held.drop", { text: row().text })}
                disabled={busy() === row().id}
                onPress={() => void take(row().id)}
                class="h-9 justify-center active:opacity-60"
              >
                <Text class="text-sm leading-4 text-muted-foreground">
                  {t("chat.held.dropAction")}
                </Text>
              </View>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}

export function Composer(props: {
  chat: Chat;
  /** The menu of send modes is open; the screen dismisses it on a press outside. */
  modes: Signal<boolean>;
  /** The @ / # menu is open: over the keyboard it takes the room the screen has. */
  menuOpen: Signal<boolean>;
  /** Sending jumps back to the live end, as in a terminal. */
  onSent: () => void;
  /** Send a failed reply's message again goes through the same target rules. */
  bindResend: (resend: (text: string, agentId: string | null) => void) => void;
}) {
  const chat = props.chat;
  const id = chat.id;
  let input: InputRef | undefined;
  const text = computed(() => drafts()[id] ?? "");
  const blank = () => text().trim() === "" && files().length === 0;
  const files = computed(() =>
    uploads().filter((file) => file.conversationId === id),
  );
  const dismissed = signal(false);
  const focused = signal(false);
  const height = signal(0);
  const picking = signal(false);

  const members = computed(() =>
    chat.members().map((member) => ({
      id: member.agentId,
      name: agentName(member.agentId),
      status: member.status,
    })),
  );
  const steward = computed(() => {
    const stewardId = chat.direct() ? null : chat.stewardId();
    return stewardId === null
      ? undefined
      : { id: stewardId, name: agentName(stewardId) };
  });
  const sticky = () => (chat.direct() ? undefined : stickies()[id]);
  const target = computed(
    (): ComposerTarget =>
      composerTarget({
        text: text(),
        members: members(),
        steward: steward(),
        sticky: sticky(),
      }),
  );
  const people = computed(() => {
    const steward_ = steward();
    return steward_ === undefined ||
      members().some((member) => member.id === steward_.id)
      ? members()
      : [steward_, ...members()];
  });
  const targetNames = () =>
    target()
      .ids.flatMap((agentId) =>
        people().filter((person) => person.id === agentId),
      )
      .map((person) => mentionLabel(person, people()))
      .join("、");
  const everyoneLabel = () => t("chat.mention.everyoneName");
  const placeholder = () => {
    if (chat.direct())
      return t("chat.composer.placeholder", {
        name: agentName(members()[0]?.id),
      });
    if (target().kind === "everyone")
      return t("chat.composer.placeholder", { name: everyoneLabel() });
    return target().kind === "none"
      ? t("chat.composer.noTarget")
      : t("chat.composer.placeholder", { name: targetNames() });
  };

  const archived = () =>
    chat.summary()?.archived === true || chat.info()?.archived === true;
  const noMembers = () =>
    chat.summary() !== undefined &&
    chat.kind() === "group" &&
    members().length === 0;
  const blocked = () => archived() || noMembers();
  const unarchive = () =>
    void call("conversations", "update", {
      conversationId: id,
      archived: false,
    }).catch((error: unknown) =>
      toast(t("common.failed", { message: reason(error) })),
    );

  // Why this draft cannot go yet: the limits, and files that are not up.
  const hold = () => {
    if ([...text()].length > MAX_MESSAGE_CHARS)
      return t("chat.composer.tooLong", { max: MAX_MESSAGE_CHARS });
    if (files().length > MAX_ATTACHMENTS)
      return t("chat.composer.tooManyFiles", { max: MAX_ATTACHMENTS });
    if (files().some((file) => file.error !== undefined))
      return t("chat.composer.failedFiles");
    if (files().some((file) => file.attachment === undefined))
      return t("chat.composer.waitForFiles");
    return undefined;
  };
  /** Who the next message reaches: a direct chat's one reader is not a choice the target holds. */
  const reach = () =>
    chat.direct() ? members().map((member) => member.id) : target().ids;
  // A warning that leaves the box usable: 03g's two.
  const notice = () => {
    if (text().trim() !== "") {
      for (const agentId of reach()) {
        const group = answeringElsewhere(agentId, id, sessionOf(agentId));
        if (group !== undefined)
          return t("chat.composer.queuedElsewhere", {
            name: agentName(agentId),
            group,
          });
      }
    }
    // An agent on eta's own loop runs on the model it names; there is no default to fall back to.
    const unset = reach().filter((agentId) => {
      const agent = agentById(agentId);
      return agent?.runtime === "eta" && agent.model === null;
    });
    return unset.length === 0
      ? undefined
      : t("chat.composer.noModel", { names: unset.map(agentName).join("、") });
  };

  // The project's files, asked for from its machine once an `@` is being typed.
  const projectFiles = signal<readonly string[]>([]);
  let filesAsked = false;
  effect(() => {
    if (filesAsked || mentionAt(text()) === null) return;
    const projectId = chat.summary()?.projectId;
    if (projectId === undefined || projectById(projectId) === undefined) return;
    filesAsked = true;
    call<{ files: string[] }>("projects", "files", { projectId }).then(
      (result) => projectFiles.set(result.files),
      () => undefined,
    );
  });
  effect(() => props.menuOpen.set(menu() !== null));

  const menu = computed((): MenuState | null =>
    buildMenu({
      text: text(),
      members: members().map((member) => ({
        id: member.id,
        name: mentionLabel(member, members()),
        busy: member.status !== "idle",
      })),
      files: projectFiles(),
      commands: commands(),
      tasks: boardTasks(),
      groupId: id,
      dismissed: dismissed() || blocked(),
      ...(chat.direct()
        ? {}
        : {
            everyone: {
              label: everyoneLabel(),
              aliases: ["所有人", "everyone"],
            },
          }),
    }),
  );
  const showToolbar = () => {
    const kind = menu()?.kind;
    return !blocked() && kind !== "slash" && kind !== "hash";
  };

  const replaceDraft = (next: string) => {
    setDraft(id, next);
    dismissed.set(false);
  };
  const sessionOf = (agentId: string | undefined) =>
    members().length === 0
      ? undefined
      : (chat.members().find((member) => member.agentId === agentId)
          ?.sessionId ?? undefined);
  const stopAll = () =>
    call<{ stopped: never[] }>("conversations", "stop", {
      conversationId: id,
    }).then(
      (result) => rememberRows(id, result.stopped),
      (error: unknown) => toast(t("common.failed", { message: reason(error) })),
    );
  const stopActive = () => {
    const active = chat.active();
    if (active === undefined) return;
    call<{ stopped: never[] }>("conversations", "stop", {
      conversationId: id,
      messageId: active.id,
    }).then(
      (result) => rememberRows(id, result.stopped),
      (error: unknown) => toast(t("common.failed", { message: reason(error) })),
    );
  };
  const compact = () => {
    // Who the composer says it is talking to, the steward included.
    const named = target()
      .ids.map(sessionOf)
      .filter((session) => session !== undefined);
    const sessions =
      named.length > 0
        ? named
        : members().length === 1
          ? [sessionOf(members()[0]?.id)]
          : [];
    const session = sessions.find(
      (value): value is string => typeof value === "string",
    );
    if (session === undefined) {
      toast(t("chat.command.compactNeedsTarget"));
      return;
    }
    replaceDraft("");
    call<CompactResult>("sessions", "compact", { session }).then(
      ({ runtime }) => {
        if (runtime === undefined) return;
        const key = `chat.compaction.${runtime.outcome}` as const;
        toast(
          t(key, { runtime: runtime.runtime, reason: runtime.reason ?? "" }),
        );
      },
      (error: unknown) => toast(t("common.failed", { message: reason(error) })),
    );
  };
  const goal = (objective: string) => {
    const session =
      target().ids.map(sessionOf).find(Boolean) ??
      chat.members().find((member) => member.sessionId !== null)?.sessionId ??
      undefined;
    if (session === undefined) return;
    call("sessions", "goal", { session, action: "set", objective }).catch(
      (error: unknown) => toast(t("common.failed", { message: reason(error) })),
    );
  };
  const deliver = (body: string, mode: SendMode) => {
    const chosen = target();
    const attachments = files().flatMap((file) =>
      file.attachment === undefined ? [] : [file.attachment],
    );
    sendMessage(id, body, mode, chosen.mentions, attachments);
    setSticky(id, chosen.sticky);
    clearUploads(id);
    replaceDraft("");
  };
  const run = (name: CommandName, rest: string) => {
    if (name === "/stop") {
      void stopAll();
      replaceDraft("");
    } else if (name === "/compact") compact();
    else if (name === "/goal") {
      if (rest.length > 0) goal(rest);
      replaceDraft("");
    } else if (name === "/theme") {
      setScheme(colorScheme() === "dark" ? "light" : "dark");
      replaceDraft("");
    } else if (name === "/settings") {
      replaceDraft("");
      go.settings();
    } else if (name === "/new") {
      replaceDraft("");
      go.newConversation();
    } else if (rest.length > 0)
      deliver(rest, name === "/steer" ? "steer" : "queue");
  };
  const choose = (item: MenuItem) => {
    if (
      item.kind === "member" ||
      item.kind === "everyone" ||
      item.kind === "file"
    ) {
      setDraft(
        id,
        text().replace(/@[^@\n]*$/, () => item.value),
      );
      dismissed.set(true);
    } else if (item.kind === "task") {
      // Replace exactly the `#…` being typed, and end with the space that closes the reference.
      const at = hashAt(text());
      if (at !== null)
        setDraft(id, `${text().slice(0, at.start)}${item.value}`);
      dismissed.set(true);
    } else {
      const command = commands().find((entry) => entry.name === item.value);
      if (command === undefined) return;
      if (command.name === "/compact" && members().length > 1)
        setDraft(id, "/compact ");
      else if (command.takesText === true) setDraft(id, `${command.name} `);
      else run(command.name, "");
    }
    input?.focus();
  };
  const send = (mode: SendMode) => {
    props.modes.set(false);
    if (blocked() || hold() !== undefined) return;
    // The button says Stop while a reply runs and the box is empty, and that promise is kept.
    if (blank()) {
      stopActive();
      return;
    }
    const first = text().trimStart();
    const space = first.search(/\s/);
    const name = space === -1 ? first : first.slice(0, space);
    const command = commands().find((entry) => entry.name === name);
    if (command !== undefined)
      run(command.name, first.slice(name.length).trim());
    else deliver(text().trim(), mode);
    props.onSent();
  };
  const pick = () => {
    const room = MAX_ATTACHMENTS - files().length;
    if (room <= 0) {
      toast(t("chat.composer.tooManyFiles", { max: MAX_ATTACHMENTS }));
      return;
    }
    Picker.pickImages({ multiple: true, limit: room, maxDimension: 2048 }).then(
      (images) => {
        for (const image of images) void attach(id, image.file);
      },
      (error: unknown) => toast(t("common.failed", { message: reason(error) })),
    );
  };
  props.bindResend((body, agentId) => {
    sendMessage(
      id,
      body,
      "queue",
      agentId === null ? target().mentions : [agentId],
    );
    props.onSent();
  });

  const pickerOptions = computed(() => {
    const stewardRow = steward();
    return [
      ...(stewardRow === undefined
        ? []
        : [{ value: "steward", label: mentionLabel(stewardRow, people()) }]),
      { value: "everyone", label: `@${everyoneLabel()}` },
      ...members()
        .filter((member) => member.id !== stewardRow?.id)
        .map((member) => ({
          value: `member:${member.id}`,
          label: mentionLabel(member, members()),
        })),
    ];
  });
  const pickerValue = () => {
    const chosen = target();
    if (chosen.kind === "everyone") return "everyone";
    if (chosen.kind === "steward") return "steward";
    return chosen.kind === "members" && chosen.ids.length === 1
      ? `member:${chosen.ids[0]}`
      : undefined;
  };
  const pickerLabel = () => {
    const chosen = target();
    if (chosen.kind === "none") return t("chat.composer.pickTarget");
    return chosen.kind === "everyone" ? `@${everyoneLabel()}` : targetNames();
  };

  return (
    <View class="shrink-0">
      <HeldBand
        chat={chat}
        onPullBack={(body) =>
          replaceDraft(text() === "" ? body : `${body}\n\n${text()}`)
        }
      />
      <If when={props.modes()}>
        <View class="w-[236px] shrink-0 self-end border border-border-strong bg-background">
          <View
            role="button"
            accessibilityLabel={t("chat.send.queue")}
            onPress={() => send("queue")}
            class="h-11 shrink-0 flex-row items-center gap-2 px-3 active:bg-muted"
          >
            <Text class="grow basis-0 text-base leading-[18px] text-foreground">
              {t("chat.send.queue")}
            </Text>
            <Icon name="check" size={14} />
          </View>
          <View
            role="button"
            accessibilityLabel={t("chat.send.steer")}
            onPress={() => send("steer")}
            class="h-11 shrink-0 flex-row items-center border-t border-border px-3 active:bg-muted"
          >
            <Text class="text-base leading-[18px] text-foreground">
              {t("chat.send.steer")}
            </Text>
          </View>
        </View>
      </If>
      <If when={archived()}>
        <Blocked
          message={t("chat.blocked.archived")}
          action={t("chat.blocked.unarchive")}
          onPress={unarchive}
        />
      </If>
      <If when={!archived() && noMembers()}>
        <Blocked
          message={t("chat.blocked.noMembers")}
          action={t("chat.blocked.viewInfo")}
          onPress={() => go.groupInfo(id)}
        />
      </If>
      <If when={!blocked() && hold() !== undefined}>
        <Notice text={hold() ?? ""} />
      </If>
      <If when={!blocked() && hold() === undefined && notice() !== undefined}>
        <Notice text={notice() ?? ""} />
      </If>
      <If when={menu()}>
        {(open) => (
          <Scroll
            testID="composer-menu"
            style={{ maxHeight: 352, flexGrow: 0 }}
            keyboardShouldPersistTaps="handled"
            class="shrink-0 border-t border-border-strong"
          >
            <Each of={open().items}>
              {(item, index) => (
                <MenuRow
                  item={item()}
                  first={index() === 0}
                  edge={
                    index() > 0 &&
                    open().items[index() - 1]?.kind !== item().kind
                  }
                  onPick={() => choose(item())}
                />
              )}
            </Each>
          </Scroll>
        )}
      </If>
      <View
        class={`shrink-0 border-t ${focused() || text() !== "" ? "border-border-strong" : "border-border"}`}
      >
        <If when={files().length > 0}>
          <View class="flex-row flex-wrap gap-2 px-4 pt-2">
            <Each of={files()} key={(file) => file.id}>
              {(file) => <UploadChip upload={file()} />}
            </Each>
          </View>
        </If>
        <Input
          ref={(node) => {
            input = node;
          }}
          testID="composer-input"
          accessibilityLabel={t("chat.composer.label")}
          multiline
          value={text()}
          readonly={blocked()}
          placeholder={placeholder()}
          onChange={({ value }) => replaceDraft(value)}
          onContentSizeChange={({ size }) =>
            height.set(Math.min(size.height, MAX_TEXT_HEIGHT))
          }
          onFocus={() => focused.set(true)}
          onBlur={() => focused.set(false)}
          class={`px-4 py-[10px] text-input leading-5 text-foreground ${blocked() ? "bg-surface placeholder:text-border-strong" : "placeholder:text-faint"}`}
          style={{ height: Math.max(Math.max(height(), 20) + 20, 44) }}
        />
        <If when={showToolbar()}>
          <View class="h-11 shrink-0 flex-row items-center gap-2 border-t border-border bg-surface px-4">
            <If when={!chat.direct()}>
              <View
                role="button"
                accessibilityLabel={t("chat.composer.pickTarget")}
                testID="composer-target"
                onPress={() => picking.set(true)}
                class="h-8 max-w-[180px] flex-row items-center gap-1 border border-border px-2 active:bg-muted"
              >
                <Text class="truncate text-md leading-4 text-foreground">
                  {pickerLabel()}
                </Text>
                <Icon name="caretDown" size={12} color="muted-foreground" />
              </View>
            </If>
            <View
              role="button"
              accessibilityLabel={t("chat.attachments.pick")}
              testID="composer-attach"
              onPress={pick}
              class="size-8 shrink-0 items-center justify-center active:opacity-60"
            >
              <Icon name="paperclip" size={18} color="muted-foreground" />
            </View>
            <View class="grow basis-0" />
            <View
              role="button"
              accessibilityLabel={
                blank() && chat.active() !== undefined
                  ? t("chat.composer.stop")
                  : t("common.send")
              }
              testID="composer-submit"
              onPress={() => send("queue")}
              onLongPress={() => {
                if (!blank() && chat.active() !== undefined)
                  props.modes.set(true);
              }}
              class="h-8 items-center justify-center bg-primary px-[14px] active:opacity-80"
            >
              <Text class="text-md leading-4 text-primary-foreground">
                {blank() && chat.active() !== undefined
                  ? t("chat.composer.stop")
                  : t("common.send")}
              </Text>
            </View>
          </View>
        </If>
      </View>
      <BottomInset />
      <SelectSheet
        open={picking()}
        title={t("chat.composer.pickTarget")}
        options={pickerOptions()}
        value={pickerValue()}
        onChange={(value) => {
          if (value === "steward") setSticky(id, undefined);
          else if (value === "everyone") setSticky(id, "everyone");
          else setSticky(id, [value.slice("member:".length)]);
        }}
        onClose={() => picking.set(false)}
      />
    </View>
  );
}
