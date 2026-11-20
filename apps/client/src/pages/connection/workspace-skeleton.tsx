import type { Layout } from "../../components";
import { View } from "nsh";
import { colors, fill, grow, Icon, row, sizes } from "../../components";
import { uiText } from "../../i18n";

function SkeletonBlock(props: {
  width: number | `${number}%`;
  height: number;
}) {
  const c = colors();
  return (
    <View
      style={{
        width: props.width,
        height: props.height,
        flexShrink: 0,
        backgroundColor: c().border,
      }}
    />
  );
}

function SkeletonRows(props: {
  widths: number[];
  height: number;
  compact?: boolean;
}) {
  return (
    <Each of={props.widths}>
      {(width) => (
        <View
          style={{
            ...row,
            height: props.height,
            paddingHorizontal: props.compact ? 24 : 8,
            gap: 12,
          }}
        >
          <SkeletonBlock width={14} height={14} />
          <If when={!props.compact}>
            <SkeletonBlock width={width()} height={12} />
          </If>
        </View>
      )}
    </Each>
  );
}

export function WorkspaceSkeleton(props: {
  layout: Layout;
  backdrop?: boolean;
}) {
  const c = colors();
  const desktop = () => props.layout === "desktop";
  const phone = () => props.layout === "phone";
  const bar = () => ({
    ...row,
    borderBottomWidth: 1,
    borderColor: c().border,
    flexShrink: 0,
  });
  return (
    <View
      role={props.backdrop ? undefined : "progressbar"}
      accessibilityLabel={props.backdrop ? undefined : uiText("loadingEta")}
      style={{
        ...fill,
        flexDirection: "row",
        filter: props.backdrop ? "blur(3px)" : undefined,
      }}
    >
      <If when={!phone()}>
        <View
          style={{
            width: desktop() ? sizes.sidebar : sizes.rail,
            backgroundColor: c().surface,
            borderRightWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ ...bar(), height: 40 }} />
          <If
            when={desktop()}
            else={
              <View style={{ gap: 4, paddingTop: 12 }}>
                <SkeletonRows
                  widths={[14, 14, 14, 14, 14]}
                  height={44}
                  compact
                />
              </View>
            }
          >
            <View
              style={{
                paddingHorizontal: 8,
                paddingTop: 8,
                paddingBottom: 4,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <SkeletonRows widths={[107, 71, 89, 119]} height={32} />
            </View>
            <View style={{ ...grow, paddingHorizontal: 8, paddingTop: 8 }}>
              <View style={{ ...bar(), height: 24, paddingHorizontal: 8 }}>
                <SkeletonBlock width={48} height={10} />
              </View>
              <SkeletonRows widths={[107, 71, 89, 119]} height={50} />
            </View>
            <View
              style={{
                paddingHorizontal: 8,
                paddingTop: 8,
                paddingBottom: 6,
                borderTopWidth: 1,
                borderColor: c().border,
              }}
            >
              <View style={{ ...bar(), height: 24, paddingHorizontal: 8 }}>
                <SkeletonBlock width={48} height={10} />
              </View>
              <SkeletonRows widths={[107, 71]} height={36} />
            </View>
            <View
              style={{ padding: 4, borderTopWidth: 1, borderColor: c().border }}
            >
              <SkeletonRows widths={[89]} height={32} />
            </View>
          </If>
        </View>
      </If>
      <If when={!desktop() && !phone()}>
        <View
          style={{
            width: 320,
            borderRightWidth: 1,
            borderColor: c().border,
            padding: 12,
          }}
        >
          <SkeletonRows widths={[108, 84, 118, 102, 129]} height={46} />
        </View>
      </If>
      <View style={grow}>
        <View style={{ ...bar(), height: 40, paddingHorizontal: 16 }}>
          <SkeletonBlock width={96} height={12} />
        </View>
        <View style={{ paddingTop: 24, paddingHorizontal: 24 }}>
          <Each of={phone() ? [0, 1, 2] : [0, 1]}>
            {(width) => (
              <>
                <View style={{ gap: 10, marginBottom: 28 }}>
                  <View style={{ ...row, gap: 8 }}>
                    <SkeletonBlock width={18} height={18} />
                    <SkeletonBlock width={96} height={12} />
                  </View>
                  <View style={{ gap: 8, paddingHorizontal: 2 }}>
                    <SkeletonBlock width="97%" height={12} />
                    <SkeletonBlock
                      width={
                        phone()
                          ? (["60%", "66%", "46%"] as const)[width()]!
                          : [408, 272][width()]!
                      }
                      height={12}
                    />
                  </View>
                </View>
                <View style={{ alignItems: "flex-end", marginBottom: 28 }}>
                  <SkeletonBlock width={phone() ? "40%" : 288} height={36} />
                </View>
              </>
            )}
          </Each>
        </View>
        <If
          when={!phone()}
          else={
            <View
              style={{
                ...row,
                marginTop: "auto",
                height: sizes.phoneNav,
                borderTopWidth: 1,
                borderColor: c().border,
                justifyContent: "space-around",
              }}
            >
              <Each of={["chat", "bell", "context", "tasks", "more"] as const}>
                {(icon) => <Icon name={icon()} size={20} tone="muted" />}
              </Each>
            </View>
          }
        >
          <View
            style={{
              marginTop: "auto",
              marginBottom: 14,
              marginHorizontal: 16,
              height: 83,
              borderWidth: 1,
              borderColor: c().border,
            }}
          />
        </If>
      </View>
      <If when={desktop()}>
        <View
          style={{
            width: sizes.panel,
            backgroundColor: c().surface,
            borderLeftWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ ...bar(), height: 40 }} />
        </View>
      </If>
      <If when={props.backdrop}>
        <View style={{ ...fill, backgroundColor: c().shade }} />
      </If>
    </View>
  );
}
