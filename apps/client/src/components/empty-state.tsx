import type { JSX, ViewStyle } from "nsh";
import type { EmptyArt } from "./empty-art";
import type { IconName } from "./icons";
import {
  computed,
  createMotion,
  Image,
  motions,
  signal,
  untracked,
  View,
} from "nsh";
import { uiText } from "../i18n";
import {
  logProblem,
  problemDetail,
  problemHasDetail,
} from "../services/problem-text";
import { Button } from "./controls";
import { emptyArtPaths } from "./empty-art";
import { motion } from "./motion";
import { Icon, Label } from "./text";
import { colors, Fonts, monoFontFamily, row, Screen } from "./theme";
import { control, icon, space, weight } from "./tokens";

/**
 * What a region shows while it has nothing to show (#378): one component for every empty, loading,
 * failed and unopenable state, at four sizes.
 *
 * - `page`: a pane or a page with nothing in it: the art, a title, a line on what comes here, up
 *   to two buttons, centred in the content area (the page's header, tabs, search and filters stay
 *   above it).
 * - `card`: one line in a card: a 40 tile with the art, the title, a ghost button at the end.
 * - `row`: one line in a list, at the list's own row height: muted text, a ghost button at the end.
 * - `menu`: one muted line in a menu or a picker: no art, no button.
 *
 * Every caller says what the region shows in each of its three states, so "nothing here yet" is
 * never drawn while the content is still on its way or did not arrive: `loading` (the region's
 * own skeleton, or a line for a row or a menu), `error` (what did not load, whether it is safe,
 * Retry) and `empty`. `status` picks one. A region that never waits or never fails says so with
 * `null`; leaving one out does not type-check.
 */
type EmptySize = "page" | "card" | "row" | "menu";

/** Which of the three a region is in. */
export type EmptyStatus = "loading" | "error" | "empty";

export interface EmptyAction {
  label: string;
  icon?: IconName;
  onPress: () => void;
}

/** The text of a state: a title, and at the larger sizes the art, a line under it and up to two
 * actions (the first is the primary one on a page; card and row sizes draw ghost buttons). */
interface EmptyContent {
  /** Decorative: screen readers skip it. Pages and cards only. */
  art?: EmptyArt;
  title: string;
  description?: string;
  /** At most two: a third is not drawn. */
  actions?: readonly EmptyAction[];
}

/** What did not load (`EmptyContent` with the warning art by default) and how to try again. The
 * raw `problem` is never the text: it goes to the console and under Details. */
interface EmptyFailure extends EmptyContent {
  /** Draws Retry first; its icon turns while `retrying`. */
  retry?: () => void;
  retrying?: boolean;
  problem?: unknown;
  /** The art's colour: `danger` (red) for a failure, `quiet` for what is gone or cannot open. */
  tone?: "danger" | "quiet";
}

export interface EmptyStateProps {
  size: EmptySize;
  status: EmptyStatus;
  /** While the content is on its way: the region's skeleton, or a line of text (rows and menus).
   * `null`: the region's content is already here (a list filtered on the device). */
  loading: JSX.Element | string | null;
  /** When it did not arrive. `null`: the region cannot fail (its data is on the device). */
  error: EmptyFailure | null;
  /** When there is nothing (yet, or nothing matched). */
  empty: EmptyContent;
  /** No result for a search or a filter: say it politely to a screen reader as it changes. */
  announce?: boolean;
  /** A page's description width: `narrow` in a side panel, `wide` in a main column. */
  width?: keyof typeof emptyWidth;
  style?: ViewStyle;
}

/** How wide a page-size state's description runs. */
const emptyWidth = { narrow: 320, wide: 448 } as const;

export function EmptyState(props: EmptyStateProps) {
  // Read once: each read of a JSX prop builds it again, and a skeleton that is built again starts
  // its wait again (#380), so it would never show.
  const loading = computed(() => props.loading);
  const failed = () => props.status === "error" && props.error !== null;
  const waiting = () => props.status === "loading" && loading() !== null;
  return (
    <If
      when={waiting()}
      else={
        <If
          when={failed()}
          else={
            <Shown
              size={props.size}
              content={props.empty}
              announce={props.announce}
              width={props.width}
              style={props.style}
            />
          }
        >
          <Failed
            size={props.size}
            failure={props.error!}
            width={props.width}
            style={props.style}
          />
        </If>
      }
    >
      <If when={typeof loading() === "string"} else={loading() as JSX.Element}>
        <Waiting
          size={props.size}
          text={loading() as string}
          style={props.style}
        />
      </If>
    </If>
  );
}

/** A line for what is still on its way, where a row or a menu has no skeleton of its own. */
function Waiting(props: { size: EmptySize; text: string; style?: ViewStyle }) {
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.text}
      style={{ ...frame(props.size), ...props.style }}
    >
      <Label variant="small" tone="muted">
        {props.text}
      </Label>
    </View>
  );
}

function Failed(props: {
  size: EmptySize;
  failure: EmptyFailure;
  width?: keyof typeof emptyWidth;
  style?: ViewStyle;
}) {
  const failure = () => props.failure;
  untracked(() => logProblem(props.failure.problem));
  const retry = (): EmptyAction | undefined => {
    const again = failure().retry;
    return again
      ? {
          label: failure().retrying ? uiText("retrying") : uiText("retry"),
          icon: "refresh",
          onPress: again,
        }
      : undefined;
  };
  const content = (): EmptyContent => {
    const own = failure().actions ?? [];
    const first = retry();
    const actions = (first ? [first, ...own] : own).slice(0, 2);
    return {
      art: failure().art ?? (failure().tone === "quiet" ? "lock" : "warning"),
      title: failure().title,
      description: failure().description,
      actions: actions.length ? actions : undefined,
    };
  };
  return (
    <Shown
      size={props.size}
      content={content()}
      tone={failure().tone ?? "danger"}
      spinning={failure().retrying}
      problem={failure().problem}
      width={props.width}
      style={props.style}
    />
  );
}

function frame(size: EmptySize, phone = false): ViewStyle {
  switch (size) {
    case "page":
      // Centred in what is empty: the art, the title, the line under it and the buttons sit as one
      // block in the middle of the content area (24 in from the sides, 16 on a phone). A page whose
      // height the content decides (it scrolls) has no middle to speak of: the block then keeps its
      // place at the top of that space, still centred across it.
      return {
        alignItems: "center",
        justifyContent: "center",
        flexGrow: 1,
        gap: space[8],
        paddingHorizontal: phone ? space[16] : space[24],
        paddingVertical: phone ? space[32] : space[48],
      };
    case "card":
      return { ...row, gap: space[12], padding: space[12] };
    case "row":
      return {
        ...row,
        gap: space[8],
        paddingHorizontal: space[8],
        paddingVertical: space[8],
      };
    case "menu":
      return { paddingHorizontal: space[8], paddingVertical: space[8] };
  }
}

function Shown(props: {
  size: EmptySize;
  content: EmptyContent;
  tone?: "danger" | "quiet";
  spinning?: boolean;
  problem?: unknown;
  announce?: boolean;
  width?: keyof typeof emptyWidth;
  style?: ViewStyle;
}) {
  const content = () => props.content;
  const layout = Screen();
  const large = () => props.size === "page" || props.size === "card";
  return (
    <View
      accessibilityLiveRegion={props.announce ? "polite" : undefined}
      style={{
        ...frame(props.size, layout() === "phone"),
        ...props.style,
      }}
    >
      <If when={large() ? content().art : undefined}>
        {(art) => (
          <If
            when={props.size === "card"}
            else={
              <View style={{ marginBottom: space[4] }}>
                <ArtImage name={art()} size={icon.xl} tone={props.tone} />
              </View>
            }
          >
            <View
              style={{
                width: space[40],
                height: space[40],
                flexShrink: 0,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors()().selected,
              }}
            >
              <ArtImage name={art()} size={icon.lg} tone={props.tone} />
            </View>
          </If>
        )}
      </If>
      <If
        when={props.size === "page"}
        else={
          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
            <Label
              variant="small"
              tone={props.size === "card" ? "ink" : "muted"}
            >
              {content().title}
            </Label>
            <If when={props.size === "card" && content().description}>
              <Label variant="small" tone="muted">
                {content().description}
              </Label>
            </If>
            <Details problem={props.problem} size={props.size} />
          </View>
        }
      >
        <Label
          variant="body"
          weight={weight.strong}
          style={{ textAlign: "center" }}
        >
          {content().title}
        </Label>
        <If when={content().description}>
          <Label
            variant="small"
            tone="muted"
            style={{
              maxWidth: emptyWidth[props.width ?? "wide"],
              textAlign: "center",
            }}
          >
            {content().description}
          </Label>
        </If>
        <Details problem={props.problem} size={props.size} />
      </If>
      <If when={props.size !== "menu" && content().actions?.length}>
        <View
          style={{
            ...row,
            gap: space[8],
            flexShrink: 0,
            marginTop: props.size === "page" ? space[8] : 0,
          }}
        >
          <Each of={(content().actions ?? []).slice(0, 2)}>
            {(action, index) => (
              <ActionButton
                action={action()}
                primary={props.size === "page" && index() === 0}
                spinning={
                  props.spinning === true &&
                  index() === 0 &&
                  action().icon === "refresh"
                }
              />
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

function ActionButton(props: {
  action: EmptyAction;
  primary: boolean;
  spinning: boolean;
}) {
  return (
    <If
      when={props.spinning}
      else={
        <Button
          label={props.action.label}
          icon={props.action.icon}
          tone={props.primary ? "primary" : "ghost"}
          size={control.md}
          onPress={props.action.onPress}
        />
      }
    >
      <Retrying label={props.action.label} />
    </If>
  );
}

/** Retry while it runs: its icon turns beside "Retrying…" where the button was. */
function Retrying(props: { label: string }) {
  const turn = createMotion({
    enter: { ...motions.spin, duration: motion.spin, iterations: "infinite" },
  });
  return (
    <View
      role="progressbar"
      accessibilityLabel={props.label}
      style={{ ...row, height: control.md, gap: space[4] }}
    >
      <View style={{ opacity: turn.opacity, transform: turn.transform }}>
        <Icon name="refresh" size={icon.sm} tone="muted" />
      </View>
      <Label variant="small" tone="muted">
        {props.label}
      </Label>
    </View>
  );
}

/** The raw text behind a failure, folded under Details: never the message itself. */
function Details(props: { problem?: unknown; size: EmptySize }) {
  const open = signal(false);
  const fonts = Fonts();
  const detail = () =>
    problemHasDetail(props.problem) ? problemDetail(props.problem) : "";
  return (
    <If when={detail() && props.size !== "menu"}>
      <View
        style={{
          gap: space[4],
          alignItems: props.size === "page" ? "center" : "flex-start",
        }}
      >
        <Button
          label={open() ? uiText("hideDetails") : uiText("showDetails")}
          tone="ghost"
          size={control.sm}
          expanded={open()}
          onPress={() => open.set(!open())}
        />
        <If when={open()}>
          <Label
            variant="caption"
            tone="muted"
            style={{
              fontFamily: monoFontFamily(fonts()),
              maxWidth: emptyWidth.wide,
            }}
          >
            {detail()}
          </Label>
        </If>
      </View>
    </If>
  );
}

/** A duotone glyph: the shape shaded in the line's quiet partner colour, then the line. Red for a
 * failure, faint otherwise: an empty state's art never takes the accent, which is the buttons'. */
function ArtImage(props: {
  name: EmptyArt;
  size: number;
  tone: "danger" | "quiet" | undefined;
}) {
  const color = colors();
  const src = () => {
    const c = color();
    const line = props.tone === "danger" ? c.red : c.faint;
    const shade = props.tone === "danger" ? c.redFill : c.border;
    const paths = `<path fill="${shade}" d="${emptyArtPaths[props.name].fill}"/><path fill="${line}" d="${emptyArtPaths[props.name].line}"/>`;
    return `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${paths}</svg>`,
    )}`;
  };
  return (
    <Image
      src={src()}
      fadeDuration={0}
      accessible={false}
      style={{
        width: props.size,
        height: props.size,
        flexShrink: 0,
      }}
    />
  );
}
