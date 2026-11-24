import { signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  grow,
  Icon,
  Label,
  row,
} from "../../components";
import { canHover, inSheet, MenuFrame, MenuRow } from "../../components/menu";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { setUsageShown, usageShown } from "./usage";

/**
 * The Tasks page's View menu: how the board draws its tasks, for now whether cards and rows say
 * their token usage. On desktop and tablet a toolbar button with a popup; on a phone a button at
 * the top right with a sheet at the bottom.
 */
/** The View menu off phones. */
const menuWidth = 260;

export function ViewMenu(props: { phone?: boolean; tablet?: boolean }) {
  const c = colors();
  const open = signal(false);
  const on = () => usageShown();
  return (
    <MenuFrame
      align="end"
      margin={8}
      open={open()}
      onOpenChange={open.set}
      popupStyle={{
        width: menuWidth,
        paddingVertical: space[4],
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
      sheetHeader={
        <View
          style={{
            ...row,
            height: control.touch,
            paddingLeft: space[16],
            paddingRight: space[8],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label weight={weight.strong} lines={1} style={grow}>
            {uiText("usageView")}
          </Label>
          <Button
            label={uiText("close")}
            icon="close"
            iconOnly
            iconSize={icon.md}
            tone="ghost"
            size={control.lg}
            onPress={() => open.set(false)}
          />
        </View>
      }
      trigger={
        <If
          when={props.phone}
          else={
            <View
              accessibilityLabel={uiText("usageView")}
              hoverStyle={
                canHover ? { backgroundColor: c().selected } : undefined
              }
              expandedStyle={{ backgroundColor: c().selected }}
              style={{
                ...row,
                height: control.sm,
                paddingHorizontal: space[8],
                gap: space[4],
                flexShrink: 0,
                cursor: "pointer",
                backgroundColor: open() ? c().selected : undefined,
              }}
            >
              <Icon
                name="sliders"
                size={icon.sm}
                tone={open() ? "ink" : "muted"}
              />
              <Label
                variant="small"
                weight={weight.regular}
                tone={open() ? "ink" : "muted"}
              >
                {uiText("usageView")}
              </Label>
            </View>
          }
        >
          <View
            accessibilityLabel={uiText("usageView")}
            style={{
              width: space[40],
              height: space[40],
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <Icon name="sliders" size={icon.lg} />
          </View>
        </If>
      }
    >
      <If when={!props.phone}>
        <View
          style={{
            paddingTop: space[8],
            paddingBottom: space[2],
            paddingHorizontal: space[12],
          }}
        >
          <Caption text={uiText("usageView")} />
        </View>
      </If>
      <UsageRow phone={props.phone} on={on()} />
    </MenuFrame>
  );
}

/** The one row: what it does, under its name, and a switch that says whether it is on. */
function UsageRow(props: { phone?: boolean; on: boolean }) {
  const c = colors();
  const sheet = () => inSheet() || !!props.phone;
  return (
    <MenuRow
      role="menuitemradio"
      checked={props.on}
      label={uiText("usageShowTokens")}
      description={uiText(
        props.phone ? "usageShowTokensPhoneHint" : "usageShowTokensHint",
      )}
      style={{
        ...row,
        alignItems: "flex-start",
        paddingVertical: sheet() ? space[16] : space[8],
        paddingHorizontal: sheet() ? space[16] : space[12],
        gap: space[12],
      }}
      onSelect={() => setUsageShown(!props.on)}
    >
      <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
        <Label variant={sheet() ? "body" : "small"}>
          {uiText("usageShowTokens")}
        </Label>
        <Label variant={sheet() ? "small" : "caption"} tone="muted">
          {uiText(
            props.phone ? "usageShowTokensPhoneHint" : "usageShowTokensHint",
          )}
        </Label>
      </View>
      <View
        style={{
          ...row,
          marginTop: space[2],
          width: control.md,
          height: space[16],
          paddingHorizontal: space[2],
          flexShrink: 0,
          justifyContent: props.on ? "flex-end" : "flex-start",
          borderWidth: 1,
          borderColor: props.on ? c().button : c().strong,
          backgroundColor: props.on ? c().button : c().canvas,
        }}
      >
        <View
          style={{
            width: space[12],
            height: space[12],
            backgroundColor: props.on ? c().buttonInk : c().muted,
          }}
        />
      </View>
    </MenuRow>
  );
}
