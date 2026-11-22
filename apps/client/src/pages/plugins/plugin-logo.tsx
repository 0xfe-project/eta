import type { PluginLogoResult } from "@eta/client-contracts";
import type { Signal } from "nsh";
import { effect, Image, signal, untracked, View } from "nsh";
import { colors, Label } from "../../components";
import { useHost } from "../../services/host";

/** Muted fills the initial sits on; dark enough for white text. */
const AVATAR_FILLS = ["#5B6EAE", "#3F8F8B", "#9A5B8F", "#B0663F", "#5E8C4A", "#8A6FB0", "#B05A6A", "#4F7FA3"];

/** The same name always gets the same fill. */
export const avatarFill = (name: string): string => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_FILLS[h % AVATAR_FILLS.length]!;
};

const found = new Map<string, Signal<string | null | undefined>>();

/** A plugin's picture, or its first letter. The host finds the picture; nothing is fetched from here. */
export function PluginLogo(props: {
  name: string;
  homepage?: string | null;
  /** An installed plugin: the host reads its own picture, then its homepage's icon. */
  installed?: boolean;
  size?: number;
}) {
  const host = useHost();
  const c = colors();
  const size = () => props.size ?? 28;
  const key = () => (props.installed ? "installed:" + props.name : (props.homepage ?? ""));
  const state = () => {
    let one = found.get(key());
    if (!one) {
      one = signal<string | null | undefined>(undefined);
      found.set(key(), one);
    }
    return one;
  };
  effect(() => {
    const at = key();
    const one = state();
    if (!at || untracked(() => one()) !== undefined) return;
    untracked(() => {
      one.set(null);
      host
        .call<PluginLogoResult>("plugins", "logo", props.installed ? { plugin: props.name } : { homepage: at })
        .then((logo) => {
          if (logo) one.set(`data:${logo.type};base64,${logo.data}`);
        })
        .catch(() => undefined);
    });
  });
  const picture = () => state()();
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: size(),
        height: size(),
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: picture() ? c().border : avatarFill(props.name),
      }}
    >
      <If when={picture()} else={<Label variant="small" weight={600} style={{ color: "#FFFFFF" }}>{(props.name[0] ?? "?").toUpperCase()}</Label>}>
        <Image src={picture()!} fadeDuration={0} style={{ width: size(), height: size() }} />
      </If>
    </View>
  );
}
