import type { HostAddress } from "../../services/host";
import { View } from "nsh";
import { normalizeHostOrigin, useSavedHosts } from "../../app/saved-hosts";
import {
  Button,
  colors,
  grow,
  Icon,
  Label,
  row,
  SmoothScroll,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import { StatusDot } from "../../components/status-dot";
import { icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { SavedHostsList } from "../connection/saved-hosts-list";
import { emptyStyle } from "./section";

export function HostSettings(props: {
  phone: boolean;
  onConnect: () => void;
  onSwitchHost?: (address: HostAddress) => void;
}) {
  const host = useHost();
  const savedHosts = useSavedHosts();
  const c = colors();
  const activeAddress = () => host.address();
  const activeOrigin = () => {
    const origin = activeAddress()?.origin;
    return origin ? (normalizeHostOrigin(origin) ?? origin) : undefined;
  };
  const activeConnected = () => host.state().status === "open";
  const activeUnsaved = () => {
    const origin = activeOrigin();
    if (!origin) return undefined;
    return savedHosts.hosts().some((item) => item.origin === origin)
      ? undefined
      : activeAddress()!;
  };
  const switchHost = (address: HostAddress) => {
    if (props.onSwitchHost) props.onSwitchHost(address);
    else props.onConnect();
  };

  return (
    <SmoothScroll style={grow} scrollbar={false}>
      <If when={activeUnsaved()}>
        {(address) => (
          <View
            style={{
              ...row,
              alignItems: "center",
              gap: space[8],
              paddingHorizontal: space[16],
              paddingVertical: space[12],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <View
              style={{
                width: space[24],
                height: space[24],
                flexShrink: 0,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon
                name={address().local ? "monitor" : "globe"}
                size={icon.md}
              />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
              <Label weight={weight.regular} lines={1}>
                {savedHosts.displayName(address().origin)}
              </Label>
              <Label variant="small" tone="muted" lines={1}>
                {address().origin}
              </Label>
            </View>
            <View style={{ ...row, gap: space[4], flexShrink: 0 }}>
              <StatusDot color={activeConnected() ? c().green : c().warning} />
              <Label variant="small" tone="mutedInk">
                {activeConnected()
                  ? uiText("hostCurrent")
                  : uiText("hostReconnecting")}
              </Label>
            </View>
            <Button
              label={uiText("save")}
              onPress={() => savedHosts.remember(address())}
            />
          </View>
        )}
      </If>
      <If
        when={savedHosts.hosts().length}
        else={
          <EmptyState
            size="page"
            width="narrow"
            style={emptyStyle}
            status="empty"
            loading={null}
            error={null}
            empty={{
              art: "machines",
              title: uiText("noSavedHosts"),
              description: uiText("noSavedHostsHint"),
              actions: [
                {
                  label: uiText("addHost"),
                  icon: "plus",
                  onPress: props.onConnect,
                },
              ],
            }}
          />
        }
      >
        <SavedHostsList
          hosts={savedHosts.hosts()}
          activeOrigin={activeOrigin()}
          activeConnected={activeConnected()}
          phone={props.phone}
          onConnect={switchHost}
          onRename={(origin, name) => savedHosts.rename(origin, name)}
          onRemove={(origin) => savedHosts.remove(origin)}
        />
      </If>
    </SmoothScroll>
  );
}
