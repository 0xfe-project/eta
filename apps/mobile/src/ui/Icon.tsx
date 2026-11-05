import type { Tokens } from "nsh";
import type { IconName } from "./icons";
import { Image, token } from "nsh";
import { icons } from "./icons";

type ColorToken =
  | "foreground"
  | "muted-foreground"
  | "faint"
  | "primary-foreground"
  | "state-error"
  | "state-success"
  | "state-warning"
  | "state-info";

const svg = (path: string, fill: string, opacity: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="${path}" fill="#${fill}" fill-opacity="${opacity}"/></svg>`;

/** `#rrggbbaa` as resvg takes it: a colour and its opacity apart. */
function paint(value: string): { fill: string; opacity: number } {
  const hex = value.replace("#", "");
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1;
  return { fill: hex.slice(0, 6), opacity: alpha };
}

export function Icon(props: {
  name: IconName;
  size?: number;
  color?: ColorToken;
}) {
  const size = () => props.size ?? 20;
  const uri = () => {
    const { fill, opacity } = paint(
      token((props.color ?? "foreground") as keyof Tokens) as string,
    );
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg(icons[props.name], fill, opacity))}`;
  };
  return (
    <Image
      src={uri()}
      style={{ width: size(), height: size(), flexShrink: 0 }}
    />
  );
}
