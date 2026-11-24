import type { ContextReading } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { displayContext } from "@eta/client-contracts";
import { computed, Image, View } from "nsh";
import { formatLocale, uiText } from "../i18n";
import { followSession, useHost } from "../services/host";
import { hint } from "./controls";
import { colors, fill } from "./theme";

/** Follow the main session selected by this member row. */
export function useContextUsage(session: () => string | undefined) {
  const host = useHost();
  followSession(session);
  return computed(() => {
    const id = session();
    if (!id) return undefined;
    const reading = host.section<ContextReading>(`sessions.${id}`, "context");
    return displayContext(reading, id, formatLocale());
  });
}

/**
 * The context ring around a face: one arc per source, in the web's colours, starting at the top.
 * The geometry is the web member ring's (a 48 box, radius 20, 3 wide, a 0.75 gap between arcs);
 * the Captain's rail ring passes its own tighter box and radius.
 */
export function ContextRing(props: {
  /** How full the context is (`useContextUsage`); undefined draws only the empty track. */
  usage: () => ReturnType<typeof displayContext> | undefined;
  size: number;
  children: JSX.Element;
  box?: number;
  radius?: number;
  /** Whether hovering or reading the ring says the numbers (off where the parent already speaks). */
  label?: boolean;
}) {
  const c = colors();
  const usage = () => props.usage();
  const source = computed(() => {
    const color = c();
    const box = props.box ?? 48;
    const radius = props.radius ?? 20;
    const centre = box / 2;
    const circle = `<circle cx="${centre}" cy="${centre}" r="${radius}" fill="none" stroke-width="3"`;
    const circumference = 2 * Math.PI * radius;
    const length = (usage()?.fraction ?? 0) * circumference;
    const arcs =
      length > 0
        ? `${circle} stroke="${color.blue}" stroke-dasharray="${length} ${circumference - length}"/>`
        : "";
    return `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}">${circle} stroke="${color.ink}" stroke-opacity=".03"/><g transform="rotate(-90 ${centre} ${centre})">${arcs}</g></svg>`,
    )}`;
  });
  const label = () => {
    const current = usage();
    return current && props.label !== false
      ? uiText("contextRing", { detail: current.detail })
      : undefined;
  };
  return (
    <View
      accessibilityLabel={label()}
      tooltip={hint(label(), c)}
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Image src={source()} fadeDuration={0} style={fill} />
      {props.children}
    </View>
  );
}
