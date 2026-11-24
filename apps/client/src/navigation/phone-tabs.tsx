import type { CaptainOperationView } from "@eta/client-contracts";
import type { Navigation } from "./routes";
import { Image, View } from "nsh";
import { colors, Label, row, sizes } from "../components";
import { pickerTarget } from "../components/element-picker";
import { phoneTabPaths } from "../components/icons";
import { avatar, border, icon, space, weight } from "../components/tokens";
import { useText } from "../i18n";
import { taskNeedsAttention } from "../pages/tasks/status";
import { useHost } from "../services/host";
import { CaptainFace } from "./captain";

/** An unread count over a tab icon. */
const badgeHeight = 16;

export const phoneTabs = [
  ["chat", "chat"],
  ["pending", "pending"],
  ["captain", "captain"],
  ["tasks", "tasks"],
  ["more", "more"],
] as const;

type PhoneTab = (typeof phoneTabs)[number];

export function PhoneTabItem(props: {
  tab: PhoneTab;
  selected: boolean;
  count: number;
  onPress: () => void;
}) {
  const c = colors();
  const text = useText();
  const picker = pickerTarget(
    "PhoneTabItem",
    "apps/client/src/navigation/phone-tabs.tsx",
  );
  const page = () => props.tab[0];
  const glyph = () => {
    const name = page();
    if (name === "captain") return "";
    const paths = phoneTabPaths[name][props.selected ? "selected" : "idle"];
    const color = props.selected ? c().ink : c().muted;
    const markup = paths
      .map(
        (path) =>
          `<path d="${path.d}" fill="${color}" opacity="${"opacity" in path ? path.opacity : 1}"/>`,
      )
      .join("");
    return `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${markup}</svg>`,
    )}`;
  };
  return (
    <View
      {...picker}
      role="button"
      accessibilityLabel={text(props.tab[1])}
      accessibilityState={{ selected: props.selected }}
      onPress={() => props.onPress()}
      style={{
        flex: 1,
        height: sizes.phoneNav - border.hair,
        alignItems: "center",
        justifyContent: "center",
        gap: space[4],
        position: "relative",
        cursor: "pointer",
      }}
    >
      <If when={page() === "captain"}>
        <CaptainFace size={avatar.lg} />
      </If>
      <If when={page() !== "captain"}>
        <Image
          src={glyph()}
          fadeDuration={0}
          style={{ width: icon.lg, height: icon.lg, flexShrink: 0 }}
        />
        <Label
          variant="caption"
          weight={props.selected ? weight.strong : weight.regular}
          tone={props.selected ? "ink" : "muted"}
        >
          {text(props.tab[1])}
        </Label>
      </If>
      <If when={props.count > 0}>
        <View
          style={{
            position: "absolute",
            top: 8,
            left: "50%",
            marginLeft: space[4],
            height: badgeHeight,
            minWidth: badgeHeight,
            paddingHorizontal: space[4],
            backgroundColor: c().blue,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Label variant="caption" tone="buttonInk">
            {props.count}
          </Label>
        </View>
      </If>
    </View>
  );
}

export function PhoneNavigation(props: Navigation) {
  const c = colors();
  const host = useHost();
  const waiting = () =>
    host.pending().length +
    host.tasks().filter(taskNeedsAttention).length +
    host
      .list<CaptainOperationView>("captain", "operations")
      .filter((op) => op.requiresApproval && op.status === "pending").length;
  return (
    <View
      web={{ element: "nav" }}
      style={{
        ...row,
        height: sizes.phoneNav,
        flexShrink: 0,
        borderTopWidth: 1,
        borderColor: c().border,
        backgroundColor: c().canvas,
      }}
    >
      <Each of={phoneTabs}>
        {(tab) => (
          <PhoneTabItem
            tab={tab()}
            selected={
              props.page === tab()[0] ||
              (tab()[0] === "pending" && props.page === "routines") ||
              (tab()[0] === "more" &&
                ["plugins", "settings"].includes(props.page))
            }
            count={tab()[0] === "pending" ? waiting() : 0}
            onPress={() => props.onNavigate(tab()[0])}
          />
        )}
      </Each>
    </View>
  );
}
