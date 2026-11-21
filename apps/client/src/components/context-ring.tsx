import type {
  ContextSource,
  ContextUsage,
  LlmModel,
  ProvidersView,
  SessionViewSections,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import { contextRingDashes, contextUsage } from "@eta/client-contracts";
import { computed, Image, View } from "nsh";
import { uiText } from "../i18n";
import { followSession, useHost } from "../services/host";
import { Label } from "./text";
import { colors, fill } from "./theme";

/**
 * How full a session's context window is: the shared rule in @eta/client-contracts, read from the
 * session's own view sections and its model's window. Undefined while there is no session.
 */
export function useContextUsage(
  session: () => string | undefined,
): () => ContextUsage | undefined {
  const host = useHost();
  const target = () => {
    const id = session();
    return id ? `sessions.${id}` : undefined;
  };
  followSession(session);
  return computed(() => {
    const at = target();
    if (!at) return undefined;
    const section = <K extends keyof SessionViewSections & string>(name: K) =>
      host.section<SessionViewSections[K]>(at, name);
    const model = section("model")?.id;
    const window =
      host
        .list<LlmModel>("llm", "models")
        .find(({ id }) => `llm:${id}` === model)?.contextWindow ??
      host
        .section<ProvidersView>("providers", "config")
        ?.providers.flatMap((provider) =>
          provider.models.map((entry) => ({
            id: `${provider.id}:${entry.id}`,
            window: entry.contextWindow,
          })),
        )
        .find(({ id }) => id === model)?.window;
    return contextUsage({
      messages: section("transcript")?.messages ?? [],
      tools: section("tools") ?? [],
      prompt: section("prompt"),
      window,
    });
  });
}

/** A hover hint drawn as a small dark label (a bare string tooltip draws nothing on the web). */
export function hint(text: string | undefined, c: ReturnType<typeof colors>) {
  return text ? (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 4,
        backgroundColor: c().ink,
      }}
    >
      <Label variant="small" tone="canvas">
        {text}
      </Label>
    </View>
  ) : undefined;
}

/** What the ring says when it is hovered or read out: the web ring's own words. */
function contextRingLabel(usage: ContextUsage) {
  return uiText("contextRing", {
    percent: String(usage.percent),
    used: usage.used.toLocaleString(),
    window: Math.round(usage.window / 1000).toLocaleString(),
  });
}

/**
 * The context ring around a face: one arc per source, in the web's colours, starting at the top.
 * The geometry is the web member ring's (a 48 box, radius 20, 3 wide, a 0.75 gap between arcs);
 * the Captain's rail ring passes its own tighter box and radius.
 */
export function ContextRing(props: {
  /** How full the context is (`useContextUsage`); undefined draws only the empty track. */
  usage: () => ContextUsage | undefined;
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
    const stroke: Record<ContextSource, [string, number]> = {
      system: [color.faint, 1],
      context: [color.muted, 1],
      user: [color.green, 1],
      assistant: [color.amber, 1],
      toolDefs: [color.blue, 0.45],
      tool: [color.blue, 1],
    };
    const circumference = 2 * Math.PI * radius;
    const current = usage();
    const arcs = current
      ? contextRingDashes(current, circumference, 0.75)
          .map(({ source, dash, at }) => {
            const [paint, opacity] = stroke[source];
            return `${circle} stroke="${paint}" stroke-opacity="${opacity}" stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-at}"/>`;
          })
          .join("")
      : "";
    return `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}">${circle} stroke="${color.ink}" stroke-opacity=".03"/><g transform="rotate(-90 ${centre} ${centre})">${arcs}</g></svg>`,
    )}`;
  });
  const label = () => {
    const current = usage();
    return current && props.label !== false
      ? contextRingLabel(current)
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
