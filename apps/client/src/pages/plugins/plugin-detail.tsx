import type { PluginAuditView, PluginView } from "@eta/client-contracts";
import { Clipboard, signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  focusRing,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { avatar, control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";

import { pluginText as text } from "./labels";
import { PluginEnabled } from "./plugin-name";
import { PluginGlyph, Status } from "./plugin-status";
import { ServerRows, SkillRows } from "./servers-panel";
import { PluginWarnings, pluginWarnings } from "./warnings";
function excerpt(source: PluginView["source"]) {
  if (source.kind === "local")
    return { label: source.path, clipboard: source.path };
  let repository = source.repo;
  try {
    const url = new URL(repository);
    // A formatted source line and its clipboard text need only the repository address.
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    repository = url.href;
  } catch {}
  const path = source.path && source.path !== "." ? ` / ${source.path}` : "";
  const rev = source.sha ? source.sha.slice(0, 12) : source.rev;
  const label = repository.replace(/^https?:\/\//, "").replace(/\.git$/, "");
  return {
    label: `${label}${path}${rev ? ` @ ${rev}` : ""}`,
    clipboard: repository,
  };
}

interface DetailProps {
  item: PluginView;
  phone?: boolean;
  onBack?: () => void;
  onConfigure: () => void;
  onUpdate: () => Promise<boolean>;
  onRemove: () => void;
  onRefresh: () => Promise<void>;
}

// A read shows how long ago it happened; "now" and dates read as they are.
function readTime(at: number) {
  const age = Date.now() - at;
  return age >= 60_000 && age < 86_400_000
    ? uiText("pluginReadAgo", { time: relativeTime(at) })
    : relativeTime(at);
}

// A ghost button keeps a transparent frame so it is as wide as a bordered one.
const ghostFrame = { borderWidth: 1, borderColor: "transparent" };

/** A row of the source, servers and reads boxes; reads are denser off phones. */
const rowHeight = 36;
const denseRowHeight = 32;
/** A row of the phone's actions at the foot. */
const actionRowHeight = 52;

export function PluginDetail(props: DetailProps) {
  const host = useHost();
  const c = colors();
  const actions = signal(false);
  const updating = signal(false);
  const copied = signal("");
  const git = () => props.item.source.kind === "git";
  const source = () => excerpt(props.item.source);
  const reads = () =>
    host
      .list<PluginAuditView>("plugins", "audit")
      .filter((entry) => entry.plugin === props.item.name)
      .slice()
      .sort((a, b) => b.at - a.at);
  const configure = () => props.item.fields.length > 0;
  // On a phone each block carries the design's own top spacing.
  const section = (top: number) =>
    props.phone
      ? { gap: space[4], paddingHorizontal: space[16], paddingTop: top }
      : { gap: space[4] };
  const needsConfig = () => props.item.state === "needs_config";
  const enabledSwitch = () => <PluginEnabled item={props.item} />;
  function update() {
    if (updating()) return;
    updating.set(true);
    void props
      .onUpdate()
      .then((ok) => {
        if (ok) actions.set(false);
      })
      .finally(() => updating.set(false));
  }
  return (
    <View style={{ ...grow, backgroundColor: c().canvas }}>
      <If
        when={props.phone}
        else={
          <View
            style={{
              ...row,
              height: space[40],
              flexShrink: 0,
              gap: space[8],
              paddingHorizontal: space[16],
              borderBottomWidth: 1,
              borderColor: c().border,
              backgroundColor: c().surface,
            }}
          >
            <View style={{ ...row, flex: 1, minWidth: 0, gap: space[8] }}>
              <Label weight={weight.strong} lines={1} style={{ flexShrink: 1 }}>
                {props.item.name}
              </Label>
              <Label variant="small" tone="muted" lines={1}>
                {props.item.version ?? ""}
              </Label>
              <Status item={props.item} />
            </View>
            {enabledSwitch()}
            <If when={git()}>
              <Button
                label={uiText("update")}
                busy={updating()}
                tone="ghost"
                labelVariant="caption"
                style={ghostFrame}
                onPress={update}
              />
              <Button
                label={uiText("remove2")}
                tone="ghost"
                labelVariant="caption"
                style={ghostFrame}
                onPress={props.onRemove}
              />
            </If>
            <If when={configure()}>
              <Button
                label={uiText("configure")}
                tone={needsConfig() ? "primary" : "plain"}
                labelVariant="caption"
                onPress={props.onConfigure}
              />
            </If>
          </View>
        }
      >
        <Header title={props.item.name} layout="phone" onBack={props.onBack}>
          <View style={{ flex: 1 }} />
          <If when={git()}>
            <Button
              label={uiText("pluginActions")}
              icon="more"
              iconOnly
              size={control.touch}
              iconSize={icon.lg}
              tone="ghost"
              onPress={() => actions.set(true)}
            />
          </If>
        </Header>
      </If>
      <SmoothScroll style={grow} scrollbar={false}>
        <View
          style={
            props.phone
              ? { paddingBottom: space[16] }
              : { padding: space[20], gap: space[20] }
          }
        >
          <If when={props.phone}>
            <View
              style={{
                ...row,
                gap: space[12],
                paddingHorizontal: space[16],
                paddingTop: space[16],
                paddingBottom: space[4],
              }}
            >
              <PluginGlyph size={avatar.xl} />
              <View style={{ gap: space[4], flex: 1 }}>
                <View style={{ ...row, gap: space[8] }}>
                  <Label
                    variant="subtitle"
                    weight={weight.strong}
                    lines={1}
                    style={{ flexShrink: 1 }}
                  >
                    {props.item.name}
                  </Label>
                  <Label variant="small" tone="muted" lines={1}>
                    {props.item.version ?? ""}
                  </Label>
                </View>
                <Status item={props.item} phone />
                {enabledSwitch()}
              </View>
            </View>
          </If>
          <If when={!props.item.enabled}>
            <Label
              variant="small"
              tone="muted"
              style={
                props.phone
                  ? { paddingHorizontal: space[16], paddingTop: space[8] }
                  : undefined
              }
            >
              {uiText("pluginSwitchHint")}
            </Label>
          </If>
          <If
            when={
              props.item.description ||
              (props.phone && configure()) ||
              pluginWarnings(props.item).length
            }
          >
            <View style={props.phone ? undefined : { gap: space[12] }}>
              <If when={props.item.description}>
                <Label
                  variant="small"
                  tone="mutedInk"
                  style={
                    props.phone
                      ? {
                          paddingHorizontal: space[16],
                          paddingTop: space[8],
                          paddingBottom: space[12],
                        }
                      : undefined
                  }
                >
                  {props.item.description}
                </Label>
              </If>
              <If when={props.phone && configure()}>
                <Button
                  label={uiText("configure")}
                  tone={needsConfig() ? "primary" : "plain"}
                  size={control.touch}
                  labelVariant="body"
                  style={{ marginHorizontal: space[16] }}
                  onPress={props.onConfigure}
                />
              </If>
              <If when={pluginWarnings(props.item).length}>
                <PluginWarnings
                  item={props.item}
                  phone={props.phone}
                  style={
                    props.phone
                      ? {
                          marginHorizontal: space[16],
                          marginTop: configure() ? space[16] : 0,
                        }
                      : undefined
                  }
                  onRefresh={props.onRefresh}
                />
              </If>
            </View>
          </If>
          <View style={section(20)}>
            <Caption text={text("source")} />
            <View
              style={{
                ...row,
                gap: space[8],
                minHeight: props.phone ? rowHeight : undefined,
                paddingHorizontal: space[12],
                paddingVertical: space[8],
                borderWidth: 1,
                borderColor: c().border,
              }}
            >
              <Icon
                name={git() ? "link" : "folder"}
                size={icon.md}
                tone="muted"
              />
              <Label variant="small" style={{ flex: 1, minWidth: 0 }}>
                {source().label}
              </Label>
              <View
                role="button"
                accessibilityLabel={
                  copied() === source().clipboard
                    ? text("sourceCopied")
                    : text("copySource")
                }
                onPress={() => {
                  const value = source().clipboard;
                  void host.action(async () => {
                    await Clipboard.writeText(value);
                    copied.set(value);
                  });
                }}
                focusVisibleStyle={focusRing(c(), "inset")}
                style={{
                  // The hit area stays 24px while the drawn glyph is 14px, like the design.
                  width: space[24],
                  height: space[24],
                  margin: -space[4],
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
              >
                <Icon
                  name={copied() === source().clipboard ? "check" : "copy"}
                  size={icon.md}
                  tone="muted"
                />
              </View>
            </View>
          </View>
          <View style={section(16)}>
            <Caption text={text("runs")} />
            <View style={{ gap: space[12] }}>
              <ServerRows item={props.item} phone={props.phone} />
              <SkillRows item={props.item} />
              <Label
                variant="small"
                tone="muted"
                style={{
                  paddingHorizontal: space[12],
                  paddingVertical: space[8],
                }}
              >
                {uiText("skillsMcpServers", {
                  length: props.item.skills.length,
                  value2: props.item.servers.length,
                })}
              </Label>
            </View>
          </View>
          <If when={reads().length}>
            <View style={section(16)}>
              <Caption text={text("audit")} />
              <View style={{ borderWidth: 1, borderColor: c().border }}>
                <Each of={reads()} key={(entry) => entry.id}>
                  {(entry, index) => (
                    <View
                      style={{
                        ...row,
                        gap: space[8],
                        minHeight: props.phone ? rowHeight : denseRowHeight,
                        paddingHorizontal: space[12],
                        borderTopWidth: index() ? 1 : 0,
                        borderColor: c().border,
                      }}
                    >
                      <AgentFace id={entry().agentId} size={avatar.sm} />
                      <Label variant="small" lines={1} style={{ flex: 1 }}>
                        {`${entry().agentName ?? text("deletedAgent")} · ${entry().field}`}
                      </Label>
                      <Label variant="caption" tone="muted">
                        {readTime(entry().at)}
                      </Label>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>
        </View>
      </SmoothScroll>
      <If when={props.phone && actions() && git()}>
        <Modal
          title={props.item.name}
          phone
          sheet
          plainSheetHeader
          overPhoneNavigation
          onClose={() => actions.set(false)}
        >
          <ActionRow
            label={updating() ? uiText("updating") : uiText("update")}
            hint={text("updateDetail")}
            icon="refreshAll"
            disabled={updating()}
            onPress={update}
          />
          <ActionRow
            label={uiText("remove2")}
            hint={text("removeDetail")}
            icon="trash"
            disabled={updating()}
            onPress={() => {
              actions.set(false);
              props.onRemove();
            }}
          />
        </Modal>
      </If>
    </View>
  );
}

function ActionRow(props: {
  label: string;
  hint: string;
  icon: "refreshAll" | "trash";
  disabled: boolean;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        gap: space[12],
        minHeight: actionRowHeight,
        borderTopWidth: 1,
        borderColor: c().border,
        paddingHorizontal: space[16],
        cursor: "pointer",
      }}
    >
      <Icon name={props.icon} size={icon.md} />
      <View style={{ flex: 1, gap: space[2] }}>
        <Label>{props.label}</Label>
        <Label variant="caption" tone="muted">
          {props.hint}
        </Label>
      </View>
    </View>
  );
}
