import type { BoardTaskStatus } from "@eta/client-contracts";
import type { Tokens } from "nsh";
import { Image, Text, token, View } from "nsh";
import { statusInk, TINTS, TONES } from "./status-tone";

// A task's status, drawn as the web app draws it: the outlined three are work not finished yet,
// the four solid ones want the reader or are settled. Each takes its status's state colour, which
// the dark theme makes a step lighter.

/** What a solid status cuts out of its disc, in a 16 box (black in the disc's mask). */
const CUTOUTS: Partial<Record<BoardTaskStatus, string>> = {
  in_review:
    '<path d="M3.6 8C5.2 5.2 10.8 5.2 12.4 8 10.8 10.8 5.2 10.8 3.6 8Z"/><circle cx="8" cy="8" r="1.6" fill="white"/>',
  done: '<path d="M4.8 8.2 7 10.3 11.3 5.9" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="square"/>',
  blocked: '<rect x="4.3" y="7" width="7.4" height="2"/>',
  cancelled:
    '<path d="M5.5 5.5 10.5 10.5M10.5 5.5 5.5 10.5" stroke="black" stroke-width="1.7"/>',
};

/** The mark's SVG in `color` (`#rrggbbaa`, as `token` gives it). */
function statusSvg(status: BoardTaskStatus, color: string): string {
  const hex = color.replace("#", "");
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1;
  const paint = `#${hex.slice(0, 6)}`;
  const cutout = CUTOUTS[status];
  const body =
    cutout === undefined
      ? `<circle cx="8" cy="8" r="6.2" fill="none" stroke="${paint}" stroke-width="${status === "backlog" ? 1.6 : 1.8}"${status === "backlog" ? ' pathLength="36" stroke-dasharray="2.5 2"' : ""}/>${status === "in_progress" ? `<path d="M8 3.3A4.7 4.7 0 0 1 8 12.7Z" fill="${paint}"/>` : ""}`
      : `<mask id="m"><rect width="16" height="16" fill="white"/><g fill="black">${cutout}</g></mask><circle cx="8" cy="8" r="7" fill="${paint}" mask="url(#m)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" opacity="${alpha}">${body}</svg>`;
}

export function TaskStatusIcon(props: {
  status: BoardTaskStatus;
  size?: number;
}) {
  const size = () => props.size ?? 16;
  const uri = () =>
    `data:image/svg+xml;utf8,${encodeURIComponent(
      statusSvg(
        props.status,
        token(TONES[props.status] as keyof Tokens) as string,
      ),
    )}`;
  return (
    <Image
      src={uri()}
      style={{ width: size(), height: size(), flexShrink: 0 }}
    />
  );
}

/** A status as a label: its mark and its words on a tint of its colour. */
export function StatusPill(props: {
  status: BoardTaskStatus;
  label: string;
  icon?: boolean;
}) {
  return (
    <View
      class={`shrink-0 flex-row items-center gap-1 py-[1px] pr-[6px] ${props.icon === false ? "pl-[6px]" : "pl-1"} ${TINTS[props.status]}`}
    >
      <If when={props.icon !== false}>
        <TaskStatusIcon status={props.status} size={12} />
      </If>
      <Text class={`text-sm leading-4 ${statusInk(props.status)}`}>
        {props.label}
      </Text>
    </View>
  );
}
