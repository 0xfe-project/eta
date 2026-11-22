import type { PluginView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Icon, Label, Modal, row, SmoothScroll } from "../../components";
import { uiText } from "../../i18n";
import { HeadersEditor } from "./headers-editor";
import { pluginText as text } from "./labels";

/** Whether the host sends the fields the servers panel reads (an older host does not). */
export const hostKnowsHeaders = (item: PluginView): boolean =>
  Array.isArray(item.headers) &&
  item.servers.every((server) => Array.isArray(server.headers));

/** A plugin's MCP servers: what each is, its state, and for a remote one its request headers. */
export function ServerRows(props: { item: PluginView; phone?: boolean }) {
  const c = colors();
  return (
    <View style={{ gap: 12 }}>
      <If when={!hostKnowsHeaders(props.item)}>
        <Label variant="small" tone="muted">
          {uiText("hostNeedsUpdate")}
        </Label>
      </If>
      <Each of={props.item.servers} key={(server) => server.name}>
        {(server) => (
          <View
            style={{
              gap: 12,
              padding: 16,
              borderWidth: 1,
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
              <Label variant="subtitle" weight={600}>{server().name}</Label>
              <Label
                variant="small"
                tone={props.phone ? "ink" : "mutedInk"}
                style={{
                  paddingHorizontal: 5,
                  borderWidth: 1,
                  borderColor: c().strong,
                }}
              >
                {server().transport}
              </Label>
              <Label variant="small" tone="muted">
                {props.item.state === "needs_config" || server().problem
                  ? uiText("serverNeedsSetup")
                  : uiText("serverReady")}
              </Label>
              <View style={{ flex: 1 }} />
              <If when={(server().env ?? []).length}>
                <Label
                  variant="small"
                  tone="muted"
                >{`${text(props.phone ? "envShort" : "env")}: ${(server().env ?? []).join(", ")}`}</Label>
              </If>
              <If when={(server().headers ?? []).length}>
                <Label
                  variant="small"
                  tone="muted"
                >{`${text("headers")}: ${(server().headers ?? []).join(", ")}`}</Label>
              </If>
            </View>
            <If when={server().transport !== "stdio" && hostKnowsHeaders(props.item)}>
              <HeadersEditor
                item={props.item}
                server={server().name}
                plainHttp={server().plainHttp}
                phone={props.phone}
              />
            </If>
          </View>
        )}
      </Each>
    </View>
  );
}

/** The panel a plugin card opens: its servers with their headers, over the list, not a page. */
export function ServersDialog(props: {
  item: PluginView;
  phone: boolean;
  onClose: () => void;
}) {
  const c = colors();
  return (
    <Modal
      title={uiText("serversTitle", { name: props.item.name })}
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      compact={!props.phone}
      titleWeight={500}
      width={640}
      overPhoneNavigation={props.phone}
      onClose={props.onClose}
    >
      <SmoothScroll style={{ maxHeight: 560 }} scrollbar={false}>
        <View style={{ padding: 20, gap: 12 }}>
          <Label variant="subtitle" weight={600}>
            {uiText("serversHeading")}
          </Label>
          <ServerRows item={props.item} phone={props.phone} />
        </View>
      </SmoothScroll>
    </Modal>
  );
}
