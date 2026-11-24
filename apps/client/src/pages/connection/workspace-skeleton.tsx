import type { Layout } from "../../components";
import { View } from "nsh";
import { desktopPanelOpen } from "../../app/desktop-panel";
import { paneWidth } from "../../app/pane-width";
import { colors, fill, grow, row, sizes } from "../../components";
import { avatar, icon, space } from "../../components/tokens";
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

/** A placeholder line of text, and a rail glyph's label under it. */
const lineHeight = 12;
const railLabelHeight = 8;
/** A conversation row in the tablet list, the sidebar's chat and group rows, a section
 * heading's text. */
const tabletRowHeight = 52;
const sidebarRowHeight = 52;
const groupRowHeight = 36;
const headingWidth = 48;
/** The tablet list's header title, a row's leading mark and trailing time. */
const titleWidth = { tablet: 140, other: 96 } as const;
const leadingWidth = 20;
const timeWidth = 28;
/** A reply's author mark, and the button-sized block under a reply. */
const authorWidth = 20;
const actionHeight = 36;
/** The composer's place at the foot of the desktop page. */
const composerHeight = 84;
/** A desktop reply's first line, just short of the column. */
const firstLineWidth = "97%";
/** A reply's lines (a tablet's first is full width), and the block under it. */
const replyWidth = {
  tablet: [560, 360, 240],
  phone: [216, 144, 180],
  desktop: [408, 272],
} as const;
const actionWidth = { tablet: 240, phone: 144, desktop: 288 } as const;

/** The tablet list pane's placeholder: four conversation rows. */
const tabletRows = [
  [150, 100],
  [110, 130],
  [180, 90],
  [120, 140],
] as const;

/** Tablet rail: the Captain circle, then five page glyphs over their labels. */
const railLabelWidth = [32, 24, 28, 36, 32];

function SkeletonRows(props: { widths: readonly number[]; height: number }) {
  return (
    <Each of={props.widths}>
      {(width) => (
        <View
          style={{
            ...row,
            height: props.height,
            paddingHorizontal: space[8],
            gap: space[12],
          }}
        >
          <SkeletonBlock width={icon.sm} height={icon.sm} />
          <SkeletonBlock width={width()} height={lineHeight} />
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
              <View
                style={{
                  alignItems: "center",
                  gap: space[20],
                  paddingTop: space[20],
                }}
              >
                <View style={{ marginBottom: space[8] }}>
                  <SkeletonBlock width={avatar.lg} height={avatar.lg} round />
                </View>
                <Each of={railLabelWidth}>
                  {(width) => (
                    <View style={{ alignItems: "center", gap: space[4] }}>
                      <SkeletonBlock width={icon.md} height={icon.md} />
                      <SkeletonBlock width={width()} height={railLabelHeight} />
                    </View>
                  )}
                </Each>
              </View>
            }
          >
            <View style={{ ...bar(), height: space[40] }} />
            <View
              style={{
                paddingHorizontal: space[8],
                paddingTop: space[8],
                paddingBottom: space[4],
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <SkeletonRows widths={[108, 72, 88, 120]} height={space[32]} />
            </View>
            <View
              style={{
                ...grow,
                paddingHorizontal: space[8],
                paddingTop: space[8],
              }}
            >
              <View
                style={{
                  ...bar(),
                  height: space[24],
                  paddingHorizontal: space[8],
                }}
              >
                <SkeletonBlock width={headingWidth} height={lineHeight} />
              </View>
              <SkeletonRows
                widths={[108, 72, 88, 120]}
                height={sidebarRowHeight}
              />
            </View>
            <View
              style={{
                paddingHorizontal: space[8],
                paddingTop: space[8],
                borderTopWidth: 1,
                borderColor: c().border,
              }}
            >
              <View
                style={{
                  ...bar(),
                  height: space[24],
                  paddingHorizontal: space[8],
                }}
              >
                <SkeletonBlock width={headingWidth} height={lineHeight} />
              </View>
              <View style={{ paddingVertical: space[8] }}>
                <SkeletonRows widths={[108, 72]} height={groupRowHeight} />
              </View>
            </View>
            <View
              style={{
                padding: space[4],
                borderTopWidth: 1,
                borderColor: c().border,
              }}
            >
              <SkeletonRows widths={[88]} height={space[32]} />
            </View>
          </If>
        </View>
      </If>
      <If when={!desktop() && !phone()}>
        <View
          style={{
            width: sizes.tabletList,
            borderRightWidth: 1,
            borderColor: c().border,
          }}
        >
          <View
            style={{
              ...bar(),
              height: space[40],
              paddingHorizontal: space[16],
            }}
          >
            <SkeletonBlock width={titleWidth.other} height={lineHeight} />
          </View>
          <Each of={tabletRows}>
            {(widths) => (
              <View
                style={{
                  ...bar(),
                  height: tabletRowHeight,
                  paddingHorizontal: space[16],
                  gap: space[12],
                }}
              >
                <SkeletonBlock
                  width={leadingWidth}
                  height={leadingWidth}
                  round
                />
                <View style={{ ...grow, gap: space[4] }}>
                  <SkeletonBlock width={widths()[0]} height={lineHeight} />
                  <SkeletonBlock width={widths()[1]} height={lineHeight} />
                </View>
                <SkeletonBlock width={timeWidth} height={lineHeight} />
              </View>
            )}
          </Each>
        </View>
      </If>
      <View style={grow}>
        <View
          style={{
            ...bar(),
            height: phone() ? space[48] : space[40],
            paddingHorizontal: desktop() ? space[16] : space[16],
          }}
        >
          <SkeletonBlock
            width={tablet() ? titleWidth.tablet : titleWidth.other}
            height={lineHeight}
            light={phone()}
          />
        </View>
        <If when={tablet()}>
          <View
            style={{
              paddingVertical: space[32],
              paddingHorizontal: space[16],
              gap: space[24],
            }}
          >
            <Each of={replyWidth.tablet.slice(1)}>
              {(width, index) => (
                <>
                  <View style={{ gap: space[8] }}>
                    <View style={{ ...row, gap: space[8] }}>
                      <SkeletonBlock
                        width={authorWidth}
                        height={authorWidth}
                        round
                      />
                      <SkeletonBlock
                        width={titleWidth.other}
                        height={lineHeight}
                      />
                    </View>
                    <SkeletonBlock
                      width={replyWidth.tablet[0]}
                      height={lineHeight}
                    />
                    <SkeletonBlock width={width()} height={lineHeight} />
                  </View>
                  <If when={index() === 0}>
                    <View style={{ alignItems: "flex-end" }}>
                      <SkeletonBlock
                        width={actionWidth.tablet}
                        height={actionHeight}
                      />
                    </View>
                  </If>
                </>
              )}
            </Each>
          </View>
        </If>
        <If when={phone()}>
          <View
            style={{
              paddingVertical: space[20],
              paddingHorizontal: space[16],
              gap: space[24],
            }}
          >
            <Each of={replyWidth.phone}>
              {(width, index) => (
                <>
                  <View style={{ gap: space[8] }}>
                    <View style={{ ...row, gap: space[8] }}>
                      <SkeletonBlock
                        width={authorWidth}
                        height={authorWidth}
                        light
                      />
                      <SkeletonBlock
                        width={titleWidth.other}
                        height={lineHeight}
                        light
                      />
                    </View>
                    <View style={{ gap: space[8] }}>
                      <SkeletonBlock width="100%" height={lineHeight} light />
                      <SkeletonBlock
                        width={width()}
                        height={lineHeight}
                        light
                      />
                    </View>
                  </View>
                  <If when={index() < 2}>
                    <View style={{ alignItems: "flex-end" }}>
                      <SkeletonBlock
                        width={actionWidth.phone}
                        height={actionHeight}
                        light
                      />
                    </View>
                  </If>
                </>
              )}
            </Each>
          </View>
        </If>
        <If when={desktop()}>
          <View style={{ paddingTop: space[24], paddingHorizontal: space[24] }}>
            <Each of={[0, 1]}>
              {(width) => (
                <>
                  <View style={{ gap: space[8], marginBottom: space[32] }}>
                    <View style={{ ...row, gap: space[8] }}>
                      <SkeletonBlock width={authorWidth} height={authorWidth} />
                      <SkeletonBlock
                        width={titleWidth.other}
                        height={lineHeight}
                      />
                    </View>
                    <View
                      style={{ gap: space[8], paddingHorizontal: space[2] }}
                    >
                      <SkeletonBlock
                        width={firstLineWidth}
                        height={lineHeight}
                      />
                      <SkeletonBlock
                        width={replyWidth.desktop[width()]!}
                        height={lineHeight}
                      />
                    </View>
                  </View>
                  <View
                    style={{ alignItems: "flex-end", marginBottom: space[32] }}
                  >
                    <SkeletonBlock
                      width={actionWidth.desktop}
                      height={actionHeight}
                    />
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
              marginBottom: space[16],
              marginHorizontal: space[16],
              height: composerHeight,
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
          <View style={{ ...bar(), height: space[40] }} />
        </View>
      </If>
      <If when={props.backdrop}>
        <View style={{ ...fill, backgroundColor: c().scrim }} />
      </If>
    </View>
  );
}
