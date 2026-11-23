import type { PluginAuditView, PluginView } from "@eta/client-contracts";
import { Clipboard, signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";

import { pluginText as text } from "./labels";
import { PluginGlyph, Status } from "./plugin-status";
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
      ? { gap: 6, paddingHorizontal: space[16], paddingTop: top }
      : { gap: 6 };
  const needsConfig = () => props.item.state === "needs_config";
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
              paddingHorizontal: 14,
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
            <If when={git()}>
              <Button
                label={updating() ? uiText("updating") : uiText("update")}
                disabled={updating()}
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
              size={40}
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
              <PluginGlyph size={40} />
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
              </View>
            </View>
          </If>
          <If
            when={
              props.item.description ||
              (props.phone && configure()) ||
              pluginWarnings(props.item).length
            }
          >
            <View style={props.phone ? undefined : { gap: 14 }}>
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
                  size={40}
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
            <Caption text={text("source")} phone={props.phone} />
            <View
              style={{
                ...row,
                gap: space[8],
                minHeight: props.phone ? 36 : undefined,
                paddingHorizontal: 10,
                paddingVertical: props.phone ? 6 : 8,
                borderWidth: 1,
                borderColor: c().border,
              }}
            >
              <Icon name={git() ? "link" : "folder"} size={14} tone="muted" />
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
                focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
                style={{
                  // The hit area stays 24px while the drawn glyph is 14px, like the design.
                  width: space[24],
                  height: space[24],
                  margin: -5,
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
              >
                <Icon
                  name={copied() === source().clipboard ? "check" : "copy"}
                  size={14}
                  tone="muted"
                />
              </View>
            </View>
          </View>
          <View style={section(16)}>
            <Caption text={text("runs")} phone={props.phone} />
            <View style={{ borderWidth: 1, borderColor: c().border }}>
              <Each of={props.item.servers} key={(server) => server.name}>
                {(server) => (
                  <View
                    style={{
                      justifyContent: "center",
                      paddingHorizontal: 10,
                      paddingVertical: space[4],
                      minHeight: 36,
                      borderBottomWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <View
                      style={{
                        ...row,
                        flexWrap: "wrap",
                        gap: props.phone ? 8 : 10,
                      }}
                    >
                      <Icon name="terminal" size={14} tone="muted" />
                      <Label variant="small">{server().name}</Label>
                      <Label
                        variant="caption"
                        tone={props.phone ? "ink" : "mutedInk"}
                        style={{
                          paddingHorizontal: 5,
                          borderWidth: 1,
                          borderColor: c().strong,
                        }}
                      >
                        {server().transport}
                      </Label>
                      <View style={{ flex: 1 }} />
                      <If when={server().env.length}>
                        <Label
                          variant="caption"
                          tone="muted"
                        >{`${text(props.phone ? "envShort" : "env")}: ${server().env.join(", ")}`}</Label>
                      </If>
                      <If when={server().headers.length}>
                        <Label
                          variant="caption"
                          tone="muted"
                        >{`${text("headers")}: ${server().headers.join(", ")}`}</Label>
                      </If>
                    </View>
                  </View>
                )}
              </Each>
              <Label
                variant="small"
                tone="muted"
                style={{ paddingHorizontal: 10, paddingVertical: 7 }}
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
              <Caption text={text("audit")} phone={props.phone} />
              <View style={{ borderWidth: 1, borderColor: c().border }}>
                <Each of={reads()} key={(entry) => entry.id}>
                  {(entry, index) => (
                    <View
                      style={{
                        ...row,
                        gap: props.phone ? 8 : 10,
                        minHeight: props.phone ? 36 : 30,
                        paddingHorizontal: 10,
                        borderTopWidth: index() ? 1 : 0,
                        borderColor: c().border,
                      }}
                    >
                      <AgentFace id={entry().agentId} size={14} />
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
        minHeight: 52,
        borderTopWidth: 1,
        borderColor: c().border,
        paddingHorizontal: space[16],
        cursor: "pointer",
      }}
    >
      <Icon name={props.icon} size={18} />
      <View style={{ flex: 1, gap: space[2] }}>
        <Label>{props.label}</Label>
        <Label variant="caption" tone="muted">
          {props.hint}
        </Label>
      </View>
    </View>
  );
}
