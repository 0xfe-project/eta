import type { Layout } from "../../components";
import { View } from "nsh";
import { desktopPanelOpen } from "../../app/desktop-panel";
import { paneWidth } from "../../app/pane-width";
import { colors, fill, grow, row, sizes } from "../../components";
import { uiText } from "../../i18n";
import { PhoneTabItem, phoneTabs } from "../../navigation/phone-tabs";

function SkeletonBlock(props: {
  width: number | `${number}%`;
  height: number;
  round?: boolean;
  /** A phone draws its blocks in the lighter muted fill. */
  light?: boolean;
}) {
  const c = colors();
  return (
    <View
      style={{
        width: props.width,
        height: props.height,
        flexShrink: 0,
        borderRadius: props.round ? props.height / 2 : 0,
        backgroundColor: props.light ? c().selected : c().border,
      }}
    />
  );
}

/** The tablet list pane's placeholder: four 52pt conversation rows. */
const tabletRows = [
  [150, 100],
  [110, 130],
  [180, 90],
  [120, 140],
] as const;

/** Tablet rail: the Captain circle, then five page glyphs over their labels. */
const railLabels = [30, 24, 28, 34, 30];

function SkeletonRows(props: { widths: number[]; height: number }) {
  return (
    <Each of={props.widths}>
      {(width) => (
        <View
          style={{
            ...row,
            height: props.height,
            paddingHorizontal: 8,
            gap: 12,
          }}
        >
          <SkeletonBlock width={14} height={14} />
          <SkeletonBlock width={width()} height={12} />
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
  const tablet = () => props.layout === "tablet";
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
            width: desktop() ? paneWidth("sidebar") : sizes.rail,
            backgroundColor: c().surface,
            borderRightWidth: 1,
            borderColor: c().border,
          }}
        >
          <If
            when={desktop()}
            else={
              <View style={{ alignItems: "center", gap: 20, paddingTop: 20 }}>
                <View style={{ marginBottom: 8 }}>
                  <SkeletonBlock width={28} height={28} round />
                </View>
                <Each of={railLabels}>
                  {(width) => (
                    <View style={{ alignItems: "center", gap: 6 }}>
                      <SkeletonBlock width={18} height={18} />
                      <SkeletonBlock width={width()} height={8} />
                    </View>
                  )}
                </Each>
              </View>
            }
          >
            <View style={{ ...bar(), height: 40 }} />
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
                borderTopWidth: 1,
                borderColor: c().border,
              }}
            >
              <View style={{ ...bar(), height: 24, paddingHorizontal: 8 }}>
                <SkeletonBlock width={48} height={10} />
              </View>
              <View style={{ paddingVertical: 6 }}>
                <SkeletonRows widths={[107, 71]} height={36} />
              </View>
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
          style={{ width: 320, borderRightWidth: 1, borderColor: c().border }}
        >
          <View style={{ ...bar(), height: 40, paddingHorizontal: 14 }}>
            <SkeletonBlock width={96} height={12} />
          </View>
          <Each of={tabletRows}>
            {(widths) => (
              <View
                style={{ ...bar(), height: 52, paddingHorizontal: 14, gap: 12 }}
              >
                <SkeletonBlock width={20} height={20} round />
                <View style={{ ...grow, gap: 6 }}>
                  <SkeletonBlock width={widths()[0]} height={12} />
                  <SkeletonBlock width={widths()[1]} height={10} />
                </View>
                <SkeletonBlock width={28} height={10} />
              </View>
            )}
          </Each>
        </View>
      </If>
      <View style={grow}>
        <View
          style={{
            ...bar(),
            height: phone() ? 48 : 40,
            paddingHorizontal: desktop() ? 16 : phone() ? 16 : 14,
          }}
        >
          <SkeletonBlock
            width={tablet() ? 140 : 96}
            height={12}
            light={phone()}
          />
        </View>
        <If when={tablet()}>
          <View style={{ paddingVertical: 32, paddingHorizontal: 16, gap: 28 }}>
            <Each of={[360, 240]}>
              {(width, index) => (
                <>
                  <View style={{ gap: 10 }}>
                    <View style={{ ...row, gap: 8 }}>
                      <SkeletonBlock width={18} height={18} round />
                      <SkeletonBlock width={96} height={12} />
                    </View>
                    <SkeletonBlock width={560} height={12} />
                    <SkeletonBlock width={width()} height={12} />
                  </View>
                  <If when={index() === 0}>
                    <View style={{ alignItems: "flex-end" }}>
                      <SkeletonBlock width={240} height={36} />
                    </View>
                  </If>
                </>
              )}
            </Each>
          </View>
        </If>
        <If when={phone()}>
          <View style={{ paddingVertical: 20, paddingHorizontal: 16, gap: 28 }}>
            <Each of={[215, 143, 179]}>
              {(width, index) => (
                <>
                  <View style={{ gap: 10 }}>
                    <View style={{ ...row, gap: 8 }}>
                      <SkeletonBlock width={18} height={18} light />
                      <SkeletonBlock width={96} height={12} light />
                    </View>
                    <View style={{ gap: 8 }}>
                      <SkeletonBlock width="100%" height={12} light />
                      <SkeletonBlock width={width()} height={12} light />
                    </View>
                  </View>
                  <If when={index() < 2}>
                    <View style={{ alignItems: "flex-end" }}>
                      <SkeletonBlock width={143} height={36} light />
                    </View>
                  </If>
                </>
              )}
            </Each>
          </View>
        </If>
        <If when={desktop()}>
          <View style={{ paddingTop: 24, paddingHorizontal: 24 }}>
            <Each of={[0, 1]}>
              {(width) => (
                <>
                  <View style={{ gap: 10, marginBottom: 28 }}>
                    <View style={{ ...row, gap: 8 }}>
                      <SkeletonBlock width={18} height={18} />
                      <SkeletonBlock width={96} height={12} />
                    </View>
                    <View style={{ gap: 8, paddingHorizontal: 2 }}>
                      <SkeletonBlock width="97%" height={12} />
                      <SkeletonBlock width={[408, 272][width()]!} height={12} />
                    </View>
                  </View>
                  <View style={{ alignItems: "flex-end", marginBottom: 28 }}>
                    <SkeletonBlock width={288} height={36} />
                  </View>
                </>
              )}
            </Each>
          </View>
        </If>
        <If when={phone()}>
          <View
            style={{
              ...row,
              marginTop: "auto",
              height: sizes.phoneNav,
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          >
            <Each of={phoneTabs}>
              {(tab) => (
                <PhoneTabItem
                  tab={tab()}
                  selected={false}
                  count={0}
                  onPress={() => {}}
                />
              )}
            </Each>
          </View>
        </If>
        <If when={desktop()}>
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
      <If when={desktop() && desktopPanelOpen()}>
        <View
          style={{
            width: paneWidth("panel"),
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
