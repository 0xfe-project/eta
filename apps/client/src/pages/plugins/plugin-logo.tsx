import type { PluginLogoResult } from "@eta/client-contracts";
import type { Signal } from "nsh";
import { effect, Image, signal, untracked, View } from "nsh";
import { colors, Label } from "../../components";
import { useHost } from "../../services/host";
import { avatarFill, avatarInk, avatarInitial } from "./avatar-color";

const found = new Map<string, Signal<string | null | undefined>>();

/** Repository lookups the host is asked for at once; a market of many cards asks a few at a time. */
const LOOKUPS = 4;
let running = 0;
const queued: (() => void)[] = [];
async function turn<T>(run: () => Promise<T>): Promise<T> {
  if (running >= LOOKUPS) await new Promise<void>((go) => queued.push(go));
  else running++;
  try {
    return await run();
  } finally {
    const next = queued.shift();
    if (next) next();
    else running--;
  }
}

/** A plugin's picture, or its first letter. The host finds the picture; nothing is fetched from here. */
export function PluginLogo(props: {
  name: string;
  homepage?: string | null;
  /** A market entry in a repository: the host reads its own logo from its manifest there. */
  repo?: { repo: string; ref: string; path: string } | null;
  /** A Composio toolkit's slug: the host looks the picture up in its own list. */
  composio?: string | null;
  /** An installed plugin: the host reads its own picture, then its homepage's icon. */
  installed?: boolean;
  size?: number;
}) {
  const host = useHost();
  const c = colors();
  const size = () => props.size ?? 28;
  const key = () =>
    props.installed
      ? "installed:" + props.name
      : props.composio
        ? "composio:" + props.composio
        : props.repo
        ? ["repo", props.repo.repo, props.repo.ref, props.repo.path, props.homepage ?? ""].join("\n")
        : (props.homepage ?? "");
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
      const repo = props.repo;
      const ask = () =>
        host.call<PluginLogoResult>(
          "plugins",
          "logo",
          props.installed
            ? { plugin: props.name }
            : props.composio
              ? { composio: props.composio }
              : repo
              ? { ...repo, homepage: props.homepage ?? null }
              : { homepage: at },
        );
      (repo || props.composio ? turn(ask) : ask())
        .then((logo) => {
          if (logo) one.set(`data:${logo.type};base64,${logo.data}`);
        })
        .catch(() => undefined);
    });
  });
  const picture = () => state()();
  return (
    <View
      testID="plugin-avatar"
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
      <If when={picture()} else={<Label variant="small" weight={600} style={{ color: avatarInk(avatarFill(props.name)) }}>{avatarInitial(props.name)}</Label>}>
        <Image src={picture()!} fadeDuration={0} style={{ width: size(), height: size() }} />
      </If>
    </View>
  );
}
