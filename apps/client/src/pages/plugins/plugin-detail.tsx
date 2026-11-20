import type { PluginAuditView, PluginView } from "@eta/client-contracts";
import { Clipboard, Scroll, signal, View } from "nsh";
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
} from "../../components";
import { AgentFace } from "../../components/agent-face";
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
              height: 40,
              flexShrink: 0,
              gap: 10,
              paddingHorizontal: 14,
              borderBottomWidth: 1,
              borderColor: c().border,
              backgroundColor: c().surface,
            }}
          >
            <View style={{ ...row, flex: 1, minWidth: 0, gap: 8 }}>
              <Label size={14} weight={600} lines={1} style={{ flexShrink: 1 }}>
                {props.item.name}
              </Label>
              <Label size={11} tone="muted" lines={1}>
                {props.item.version ?? ""}
              </Label>
              <Status item={props.item} />
            </View>
            <If when={git()}>
              <Button
                label={updating() ? uiText("updating") : uiText("update")}
                disabled={updating()}
                tone="ghost"
                labelSize={11}
                onPress={update}
              />
              <Button
                label={uiText("remove2")}
                tone="ghost"
                labelSize={11}
                onPress={props.onRemove}
              />
            </If>
            <If when={configure()}>
              <Button
                label={uiText("configure")}
                tone={needsConfig() ? "primary" : "plain"}
                labelSize={11}
                onPress={props.onConfigure}
              />
            </If>
          </View>
        }
      >
        <Header
          title={props.item.name}
          layout="phone"
          onBack={props.onBack}
          inset={16}
        >
          <View style={{ flex: 1 }} />
          <If when={git()}>
            <Button
              label={uiText("pluginActions")}
              icon="more"
              iconOnly
              tone="ghost"
              onPress={() => actions.set(true)}
            />
          </If>
        </Header>
      </If>
      <Scroll style={grow} scrollbar={false}>
        <View
          style={{ padding: props.phone ? 16 : 20, gap: props.phone ? 14 : 16 }}
        >
          <If when={props.phone}>
            <View style={{ ...row, gap: 12 }}>
              <PluginGlyph size={40} />
              <View style={{ gap: 3, flex: 1 }}>
                <View style={{ ...row, gap: 8 }}>
                  <Label
                    size={16}
                    weight={600}
                    lines={1}
                    style={{ flexShrink: 1 }}
                  >
                    {props.item.name}
                  </Label>
                  <Label size={12} tone="muted" lines={1}>
                    {props.item.version ?? ""}
                  </Label>
                </View>
                <Status item={props.item} phone />
              </View>
            </View>
          </If>
          <If when={props.item.description}>
            <Label size={13} line={18} tone="mutedInk">
              {props.item.description}
            </Label>
          </If>
          <If when={props.phone && configure()}>
            <Button
              label={uiText("configure")}
              tone={needsConfig() ? "primary" : "plain"}
              size={40}
              onPress={props.onConfigure}
            />
          </If>
          <If when={pluginWarnings(props.item).length}>
            <PluginWarnings item={props.item} onRefresh={props.onRefresh} />
          </If>
          <View style={{ gap: 4 }}>
            <Caption text={text("source")} />
            <View
              style={{
                ...row,
                gap: 8,
                minHeight: 34,
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderWidth: 1,
                borderColor: c().border,
              }}
            >
              <Icon name={git() ? "clip" : "folder"} size={13} tone="muted" />
              <Label size={12} line={16} style={{ flex: 1, minWidth: 0 }}>
                {source().label}
              </Label>
              <Button
                label={
                  copied() === source().clipboard
                    ? text("sourceCopied")
                    : text("copySource")
                }
                icon={copied() === source().clipboard ? "check" : "panel"}
                iconOnly
                size={24}
                tone="ghost"
                onPress={() => {
                  const value = source().clipboard;
                  void host.action(async () => {
                    await Clipboard.writeText(value);
                    copied.set(value);
                  });
                }}
              />
            </View>
          </View>
          <View style={{ gap: 4 }}>
            <Caption text={text("runs")} />
            <View style={{ borderWidth: 1, borderColor: c().border }}>
              <Each of={props.item.servers} key={(server) => server.name}>
                {(server) => (
                  <View
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                      minHeight: 36,
                      borderBottomWidth: 1,
                      borderColor: c().border,
                      gap: 3,
                    }}
                  >
                    <View style={{ ...row, flexWrap: "wrap", gap: 8 }}>
                      <Icon name="artifact" size={12} tone="muted" />
                      <Label size={12} line={17}>
                        {server().name}
                      </Label>
                      <Label
                        size={10}
                        line={14}
                        tone="muted"
                        style={{
                          paddingHorizontal: 4,
                          borderWidth: 1,
                          borderColor: c().strong,
                        }}
                      >
                        {server().transport}
                      </Label>
                      <View style={{ flex: 1 }} />
                      <If when={server().env.length}>
                        <Label
                          size={10}
                          line={14}
                          tone="muted"
                        >{`${text("env")}: ${server().env.join(", ")}`}</Label>
                      </If>
                      <If when={server().headers.length}>
                        <Label
                          size={10}
                          line={14}
                          tone="muted"
                        >{`${text("headers")}: ${server().headers.join(", ")}`}</Label>
                      </If>
                    </View>
                  </View>
                )}
              </Each>
              <Label
                size={11}
                line={16}
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
            <View style={{ gap: 4 }}>
              <Caption text={text("audit")} />
              <View style={{ borderWidth: 1, borderColor: c().border }}>
                <Each of={reads()} key={(entry) => entry.id}>
                  {(entry, index) => (
                    <View
                      style={{
                        ...row,
                        gap: 8,
                        minHeight: 30,
                        paddingHorizontal: 10,
                        borderTopWidth: index() ? 1 : 0,
                        borderColor: c().border,
                      }}
                    >
                      <AgentFace id={entry().agentId} size={14} />
                      <Label size={12} lines={1} style={{ flex: 1 }}>
                        {`${entry().agentName ?? text("deletedAgent")} · ${entry().field}`}
                      </Label>
                      <Label size={10} tone="muted">
                        {relativeTime(entry().at)}
                      </Label>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>
        </View>
      </Scroll>
      <If when={props.phone && actions() && git()}>
        <Modal
          title={props.item.name}
          phone
          sheet
          blurBackdrop={false}
          overPhoneNavigation
          onClose={() => actions.set(false)}
        >
          <ActionRow
            label={updating() ? uiText("updating") : uiText("update")}
            hint={text("updateDetail")}
            icon="refresh"
            disabled={updating()}
            onPress={update}
          />
          <ActionRow
            label={uiText("remove2")}
            hint={text("removeDetail")}
            icon="archive"
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
  icon: "refresh" | "archive";
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
        gap: 12,
        minHeight: 48,
        borderBottomWidth: 1,
        borderColor: c().border,
        paddingHorizontal: 16,
        cursor: "pointer",
      }}
    >
      <Icon name={props.icon} size={15} />
      <View style={{ flex: 1 }}>
        <Label size={14}>{props.label}</Label>
        <Label size={11} line={14} tone="muted">
          {props.hint}
        </Label>
      </View>
    </View>
  );
}
