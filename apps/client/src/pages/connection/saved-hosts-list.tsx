import type { SavedHost } from "../../app/saved-hosts";
import type { HostAddress } from "../../services/host";
import { signal, View } from "nsh";
import {
  hostDisplayName,
  normalizeHostOrigin,
  toHostAddress,
} from "../../app/saved-hosts";
import {
  ActionItem,
  ActionMenu,
  colors,
  focusRing,
  Icon,
  Label,
  row,
  SmoothScroll,
} from "../../components";
import { FieldDialog } from "../../components/field-dialog";
import { canHover } from "../../components/menu";
import { StatusDot } from "../../components/status-dot";
import { control, icon, opacity, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { relativeTime } from "../../services/host";

/** Max height for the saved-hosts list inside the compact desktop/tablet Connection card. */
const boxedMaxHeight = 200;

export interface SavedHostsListProps {
  hosts: readonly SavedHost[];
  activeOrigin?: string;
  activeConnected?: boolean;
  phone: boolean;
  /** Compact bordered section inside the Connection dialog card; full-bleed rows otherwise. */
  boxed?: boolean;
  busy?: boolean;
  onConnect: (address: HostAddress) => void;
  onRename: (origin: string, name: string) => void;
  onRemove: (origin: string) => void;
}

export function SavedHostsList(props: SavedHostsListProps) {
  const c = colors();
  const renaming = signal<SavedHost | undefined>(undefined);
  const draftName = signal("");
  const activeOrigin = () =>
    props.activeOrigin
      ? (normalizeHostOrigin(props.activeOrigin) ?? props.activeOrigin)
      : undefined;

  function openRename(item: SavedHost) {
    draftName.set(item.name ?? "");
    renaming.set(item);
  }

  function saveRename() {
    const target = renaming();
    if (!target) return;
    props.onRename(target.origin, draftName());
    renaming.set(undefined);
  }

  const rows = () => (
    <Each of={props.hosts} key={(item) => item.origin}>
      {(item, index) => (
        <SavedHostRow
          item={item()}
          current={activeOrigin() === item().origin}
          connected={Boolean(props.activeConnected)}
          phone={props.phone}
          boxed={Boolean(props.boxed)}
          last={index() === props.hosts.length - 1}
          busy={Boolean(props.busy)}
          onConnect={() => props.onConnect(toHostAddress(item()))}
          onRename={() => openRename(item())}
          onRemove={() => props.onRemove(item().origin)}
        />
      )}
    </Each>
  );

  return (
    <>
      <If
        when={props.boxed}
        else={
          <View
            testID="saved-hosts-list"
            style={{
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          >
            {rows()}
          </View>
        }
      >
        <View testID="saved-hosts-list" style={{ gap: space[4] }}>
          <Label variant="caption" tone="muted" tracking="caps">
            {uiText("savedHosts")}
          </Label>
          <View
            style={{
              borderWidth: 1,
              borderColor: c().strong,
              backgroundColor: c().canvas,
            }}
          >
            <SmoothScroll
              style={{ maxHeight: boxedMaxHeight }}
              scrollbar={false}
            >
              {rows()}
            </SmoothScroll>
          </View>
        </View>
      </If>
      <If when={renaming()}>
        {(target) => (
          <FieldDialog
            title={uiText("hostRenameTitle", {
              name: hostDisplayName(target()),
            })}
            label={uiText("hostRenameLabel")}
            value={draftName()}
            phone={props.phone}
            busy={false}
            valid={draftName().trim() !== (target().name ?? "")}
            selectAll
            description={
              <Label variant="small" tone="muted">
                {uiText("hostRenameHint")}
              </Label>
            }
            onChange={draftName.set}
            onSave={saveRename}
            onClose={() => renaming.set(undefined)}
          />
        )}
      </If>
    </>
  );
}

function SavedHostRow(props: {
  item: SavedHost;
  current: boolean;
  connected: boolean;
  phone: boolean;
  boxed: boolean;
  last: boolean;
  busy: boolean;
  onConnect: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const c = colors();
  const title = () => hostDisplayName(props.item);
  const meta = () =>
    [
      props.item.local ? uiText("hostLocal") : undefined,
      props.item.origin,
      props.item.lastConnectedAt > 0
        ? uiText("hostLastConnected", {
            time: relativeTime(props.item.lastConnectedAt),
          })
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  const inset = () => (props.boxed ? space[12] : space[16]);
  const triggerSize = () => (props.phone ? control.md : control.sm);
  const status = () => (
    <If when={props.current}>
      <View
        style={{
          ...row,
          height: props.phone ? space[16] : space[20],
          gap: space[4],
          flexShrink: 0,
        }}
      >
        <StatusDot color={props.connected ? c().green : c().warning} />
        <Label variant="small" tone="mutedInk" lines={1}>
          {props.connected ? uiText("hostCurrent") : uiText("hostReconnecting")}
        </Label>
      </View>
    </If>
  );
  return (
    <View
      hoverStyle={
        !props.busy && canHover ? { backgroundColor: c().selected } : undefined
      }
      style={{
        borderBottomWidth: props.boxed && props.last ? 0 : 1,
        borderColor: c().border,
        opacity: props.busy ? opacity.disabled : 1,
      }}
    >
      <View
        role="button"
        accessibilityLabel={title()}
        accessibilityState={{
          disabled: props.busy,
          selected: props.current,
        }}
        focusVisibleStyle={focusRing(c(), "inset")}
        onPress={() => {
          if (!props.busy) props.onConnect();
        }}
        style={{
          ...row,
          alignItems: "flex-start",
          gap: space[8],
          paddingLeft: inset(),
          paddingRight: inset() + triggerSize() + space[8],
          paddingVertical: space[8],
          cursor: props.busy ? "default" : "pointer",
        }}
      >
        <View
          style={{
            width: props.phone ? control.md : space[24],
            height: props.phone ? control.md : space[24],
            flexShrink: 0,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon
            name={props.item.local ? "monitor" : "globe"}
            size={icon.md}
            tone={props.current ? "ink" : "muted"}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
          <Label weight={weight.regular} lines={1}>
            {title()}
          </Label>
          <If when={props.phone}>{status()}</If>
          <Label variant="small" tone="muted" lines={1}>
            {meta()}
          </Label>
        </View>
        <If when={!props.phone}>{status()}</If>
      </View>
      <View
        style={{
          position: "absolute",
          top: space[8],
          right: inset(),
        }}
      >
        <ActionMenu
          label={uiText("hostActions", { name: title() })}
          sheetTitle={title()}
          disabled={props.busy}
          triggerStyle={{
            minWidth: triggerSize(),
            width: triggerSize(),
            height: triggerSize(),
            paddingHorizontal: 0,
          }}
          triggerHoverStyle={{ backgroundColor: c().border }}
        >
          <ActionItem
            label={uiText("hostMenuRename")}
            onSelect={props.onRename}
          />
          <ActionItem
            label={uiText("hostMenuRemove")}
            tone="red"
            onSelect={props.onRemove}
          />
        </ActionMenu>
      </View>
    </View>
  );
}
