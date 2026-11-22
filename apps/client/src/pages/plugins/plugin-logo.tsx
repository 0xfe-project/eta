import type { PluginLogoResult } from "@eta/client-contracts";
import type { Signal } from "nsh";
import { effect, Image, signal, untracked, View } from "nsh";
import { colors, Label } from "../../components";
import { useHost } from "../../services/host";

const found = new Map<string, Signal<string | null | undefined>>();

/** A plugin's picture, or its first letter. The host finds the picture; nothing is fetched from here. */
export function PluginLogo(props: {
  name: string;
  homepage?: string | null;
  size?: number;
}) {
  const host = useHost();
  const c = colors();
  const size = () => props.size ?? 28;
  const key = () => props.homepage ?? "";
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
        .call<PluginLogoResult>("plugins", "logo", { homepage: at })
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
        backgroundColor: c().border,
      }}
    >
      <If when={picture()} else={<Label variant="small" weight={600}>{(props.name[0] ?? "?").toUpperCase()}</Label>}>
        <Image src={picture()!} fadeDuration={0} style={{ width: size(), height: size() }} />
      </If>
    </View>
  );
}
