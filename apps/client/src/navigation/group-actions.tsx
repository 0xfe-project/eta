/**
 * What a sidebar group offers on a right click (a long press on a touch screen): renaming it and
 * archiving it. The menu opens where it was asked for, as the layout shows menus (a popup off
 * phones, the bottom sheet on a phone); each choice opens its dialog.
 */
import type { ConversationSummary } from "@eta/client-contracts";
import type { Point } from "nsh";
import { signal, View } from "nsh";
import { ActionItem, Button, Label, Modal, row } from "../components";
import { FieldDialog } from "../components/field-dialog";
import { MenuFrame } from "../components/menu";
import { colors } from "../components/theme";
import { showToast } from "../components/toast";
import { control, shadow, space, weight } from "../components/tokens";
import { uiText } from "../i18n";
import { useHost } from "../services/host";
import { problemText } from "../services/problem-text";

const menuWidth = 188;
/** The group's name atop the phone's action sheet. */
const sheetHeaderHeight = 36;

/** Renaming and archiving go through `conversations.update`; a connection without it sees both dimmed. */
function useGroupsEditable() {
  const host = useHost();
  return () => host.can("conversations.update");
}

export function GroupMenu(props: {
  group: ConversationSummary;
  /** Where it was asked for, in the row. */
  at: Point;
  onClose: () => void;
  onRename: () => void;
  onArchive: () => void;
  onResetContext: () => void;
}) {
  const c = colors();
  const editable = useGroupsEditable();
  return (
    <View
      style={{
        position: "absolute",
        left: props.at.x,
        top: props.at.y,
        width: 1,
        height: 1,
      }}
    >
      <MenuFrame
        open
        offset={0}
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
        popupStyle={{
          width: menuWidth,
          paddingVertical: space[4],
          borderWidth: 1,
          borderColor: c().strong,
          backgroundColor: c().canvas,
          boxShadow: [shadow.popover],
        }}
        sheetHeader={
          <View
            style={{
              ...row,
              height: sheetHeaderHeight,
              paddingHorizontal: space[16],
            }}
          >
            <Label variant="small" tone="muted" lines={1} style={{ flex: 1 }}>
              {props.group.name}
            </Label>
          </View>
        }
        trigger={<View style={{ width: 1, height: 1 }} />}
      >
        <ActionItem
          label={uiText("renameGroupMenu")}
          disabled={!editable()}
          onSelect={props.onRename}
        />
        <ActionItem
          label={uiText("resetContextMenu")}
          disabled={!editable()}
          onSelect={props.onResetContext}
        />
        <ActionItem
          label={uiText("archiveGroupMenu")}
          tone="red"
          disabled={!editable()}
          onSelect={props.onArchive}
        />
        <If when={!editable()}>
          <Label
            variant="caption"
            tone="muted"
            style={{ paddingHorizontal: space[8], paddingVertical: space[8] }}
          >
            {uiText("groupsReadOnly")}
          </Label>
        </If>
      </MenuFrame>
    </View>
  );
}

export function RenameGroup(props: {
  group: ConversationSummary;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const name = signal(props.group.name);
  const busy = signal(false);
  const error = signal("");
  const valid = () => !!name().trim() && name().trim() !== props.group.name;
  async function save() {
    if (busy() || !valid()) return;
    busy.set(true);
    try {
      await host.call("conversations", "update", {
        conversationId: props.group.id,
        name: name().trim(),
      });
      props.onClose();
    } catch (problem) {
      const message =
        problem instanceof Error ? problem.message : String(problem);
      // The host refuses a live group's name in the same project.
      error.set(
        /already exists/.test(message)
          ? uiText("groupNameTaken")
          : problemText(problem),
      );
    } finally {
      busy.set(false);
    }
  }
  return (
    <FieldDialog
      title={uiText("renameGroupTitle")}
      label={uiText("groupName")}
      value={name()}
      phone={props.phone}
      busy={busy()}
      valid={valid()}
      error={error()}
      selectAll
      onChange={(next) => {
        name.set(next);
        error.set("");
      }}
      onSave={() => void save()}
      onClose={props.onClose}
    />
  );
}

/** Replies that have not ended yet: archiving only marks the group, so they go on. */
function runningReplies(group: ConversationSummary) {
  return group.participants.filter(
    (member) =>
      member.status === "queued" ||
      member.status === "working" ||
      member.status === "waiting_for_input",
  ).length;
}

export function ArchiveGroup(props: {
  group: ConversationSummary;
  phone: boolean;
  onClose: () => void;
  onArchived: (id: string) => void;
}) {
  const host = useHost();
  const busy = signal(false);
  // Closing ends the dialog's group: hold on to which one it was.
  const id = props.group.id;
  const running = () => runningReplies(props.group);
  async function archive() {
    if (busy()) return;
    // A group with no reply running is archived ahead of the host (#380), with a toast to take it
    // back; stopping replies cannot be taken back quietly, so that one waits for the host.
    if (!running()) {
      archiveGroupAhead(host, id);
      props.onArchived(id);
      props.onClose();
      return;
    }
    busy.set(true);
    const result = await host.action(() =>
      host.call("conversations", "update", {
        conversationId: id,
        archived: true,
      }),
    );
    busy.set(false);
    if (result === undefined) return;
    props.onArchived(id);
    props.onClose();
  }
  const title = () => uiText("archiveGroupTitle", { name: props.group.name });
  const body = () => (
    <>
      <Label variant="small" tone="muted">
        {uiText("archiveGroupBody")}
      </Label>
      <If when={running() > 0}>
        <Label variant="small" tone="warning">
          {running() === 1
            ? uiText("archiveGroupOneRunning")
            : uiText("archiveGroupRunning", { count: running() })}
        </Label>
      </If>
    </>
  );
  return (
    <Modal
      title={title()}
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      overPhoneNavigation
      hideHeader={props.phone}
      compact={!props.phone}
      titleWeight={weight.regular}
      dismissible={!busy()}
      onClose={props.onClose}
    >
      <If
        when={props.phone}
        else={
          <View style={{ paddingTop: space[8], gap: space[8] }}>
            {body()}
            <View
              style={{
                ...row,
                gap: space[8],
                justifyContent: "flex-end",
                paddingTop: space[12],
              }}
            >
              <Button
                label={uiText("cancel")}
                size={control.md}
                disabled={busy()}
                onPress={props.onClose}
              />
              <Button
                label={uiText("archive")}
                tone="danger"
                size={control.md}
                busy={busy()}
                onPress={() => void archive()}
              />
            </View>
          </View>
        }
      >
        <View
          style={{
            ...row,
            height: control.touch,
            paddingLeft: space[16],
            paddingRight: space[8],
          }}
        >
          <Label weight={weight.strong} style={{ flex: 1 }}>
            {title()}
          </Label>
        </View>
        <View style={{ paddingHorizontal: space[16], gap: space[8] }}>
          {body()}
        </View>
        <View style={{ padding: space[16], gap: space[8] }}>
          <Button
            label={uiText("archive")}
            tone="danger"
            size={control.touch}
            busy={busy()}
            onPress={() => void archive()}
          />
          <Button
            label={uiText("cancel")}
            size={control.touch}
            disabled={busy()}
            onPress={props.onClose}
          />
        </View>
      </If>
    </Modal>
  );
}

/** Asks before every member of a group starts over with an empty context. */
export function ResetGroupContext(props: {
  group: ConversationSummary;
  phone?: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const busy = signal(false);
  const running = () => runningReplies(props.group);
  async function reset() {
    if (busy() || running() > 0) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call("conversations", "resetContext", {
        conversationId: props.group.id,
      }),
    );
    busy.set(false);
    if (result !== undefined) props.onClose();
  }
  const body = () => (
    <>
      <Label variant="small" tone="muted">
        {uiText("resetContextBody")}
      </Label>
      <If when={running() > 0}>
        <Label variant="small" tone="warning">
          {uiText("resetContextRunning")}
        </Label>
      </If>
    </>
  );
  const actions = (size: number) => (
    <>
      <Button
        label={uiText("cancel")}
        size={size}
        disabled={busy()}
        onPress={props.onClose}
      />
      <Button
        label={uiText("resetContextConfirm")}
        tone="danger"
        size={size}
        busy={busy()}
        disabled={running() > 0}
        onPress={() => void reset()}
      />
    </>
  );
  return (
    <Modal
      title={uiText("resetContextTitle", { name: props.group.name })}
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      overPhoneNavigation
      hideHeader={props.phone}
      compact={!props.phone}
      titleWeight={weight.regular}
      dismissible={!busy()}
      onClose={props.onClose}
    >
      <View style={{ paddingTop: space[8], gap: space[8] }}>
        {body()}
        <View
          style={{
            ...row,
            gap: space[8],
            justifyContent: "flex-end",
            paddingTop: space[12],
          }}
        >
          {actions(props.phone ? control.touch : control.md)}
        </View>
      </View>
    </Modal>
  );
}

/** Archives a group ahead of the host: it leaves the sidebar at once, and a toast can bring it back. */
function archiveGroupAhead(host: ReturnType<typeof useHost>, id: string) {
  const update = (archived: boolean) =>
    host.optimistic(id, { archived }, () =>
      host.call("conversations", "update", { conversationId: id, archived }),
    );
  const archived = update(true);
  archived.catch((problem: unknown) =>
    showToast({
      title: uiText("groupArchiveFailed"),
      body: problem instanceof Error ? problem.message : String(problem),
      tone: "red",
      action: {
        label: uiText("retry"),
        onPress: () => archiveGroupAhead(host, id),
      },
    }),
  );
  showToast({
    title: uiText("groupArchivedToast"),
    action: {
      label: uiText("undo"),
      onPress: () => void archived.then(() => update(false)).catch(() => {}),
    },
  });
}
