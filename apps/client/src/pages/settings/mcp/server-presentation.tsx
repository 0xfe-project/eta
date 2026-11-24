import type { McpServerView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Label, row } from "../../../components";
import { BackButton } from "../../../components/navigation-buttons";
import { control, icon, space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";

const stateLabels = {
  connected: "mcpConnected",
  cached: "mcpCached",
  "not-connected": "mcpNotConnected",
  failed: "failed",
  "needs-auth": "mcpNeedsSignIn",
  disabled: "mcpDisabled",
} as const;
const lifecycleLabels = {
  lazy: "mcpLazy",
  "keep-alive": "mcpKeepAlive",
  "lazy-keep-alive": "mcpLazyKeepAlive",
} as const;
const transports = { stdio: "stdio", http: "HTTP", sse: "SSE" } as const;

export function serverStatus(item: McpServerView) {
  return uiText(
    item.auth === "needs_login" ? "mcpNeedsSignIn" : stateLabels[item.state],
  );
}

export function transportName(item: McpServerView) {
  return transports[item.transport];
}

export function transportDescription(item: McpServerView) {
  return `${transports[item.transport]} · ${uiText(lifecycleLabels[item.lifecycle])}`;
}

export function toolsDescription(count: number) {
  return uiText(count === 1 ? "mcpOneTool" : "mcpToolCount", { count });
}

export function statusTone(item: McpServerView) {
  if (item.state === "failed") return "red";
  if (item.auth === "needs_login") return "warning";
  return item.state === "connected" ? "green" : "muted";
}

export function McpPhoneHeader(props: { title: string; onBack: () => void }) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        height: space[48],
        flexShrink: 0,
        paddingHorizontal: space[8],
        gap: space[4],
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <BackButton
        size={control.touch}
        iconSize={icon.md}
        onPress={props.onBack}
      />
      <Label weight={weight.strong}>{props.title}</Label>
    </View>
  );
}
