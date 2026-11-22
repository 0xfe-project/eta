import type {
  PluginLogoResult,
  PluginLogosCachedResult,
} from "@eta/client-contracts";
import type { Signal } from "nsh";
import { effect, Image, signal, untracked, View } from "nsh";
import { colors, Label } from "../../components";
import { useHost } from "../../services/host";
import { avatarFill, avatarInitial, avatarInk } from "./avatar-color";

const found = new Map<string, Signal<string | null | undefined>>();

/** The key a market entry's picture is kept under. */
const repoKey = (
  repo: { repo: string; ref: string; path: string },
  homepage: string | null | undefined,
): string =>
  ["repo", repo.repo, repo.ref, repo.path, homepage ?? ""].join("\n");

function slot(key: string): Signal<string | null | undefined> {
  let one = found.get(key);
  if (!one) {
    one = signal<string | null | undefined>(undefined);
    found.set(key, one);
  }
  return one;
}

/** How long the first screen waits for the host's kept pictures before it draws letters. */
const LOGOS_CACHED_WAIT_MS = 400;
/** The most entries one `logosCached` call is asked about (the host's own limit). */
const LOGOS_CACHED_MAX = 200;

/**
 * Before the market's first frame: ask the host once for the pictures it already has. A hit is put
 * where the card reads it, so its first frame has the picture; a known miss stays a letter without a
 * request. Anything else (unknown, a timeout, an error, a host without this call) changes nothing:
 * the card draws its letter and asks for its own picture as before. This never fails and never waits
 * longer than `waitMs`.
 */
export async function primeLogos(
  host: ReturnType<typeof useHost>,
  asks: { repo: string; ref: string; path: string; homepage: string | null }[],
  waitMs = LOGOS_CACHED_WAIT_MS,
): Promise<void> {
  const batch = asks
    .filter((ask) => slot(repoKey(ask, ask.homepage))() === undefined)
    .slice(0, LOGOS_CACHED_MAX);
  if (batch.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = await Promise.race([
    host
      .call<PluginLogosCachedResult>("plugins", "logosCached", {
        entries: batch,
      })
      .catch(() => undefined),
    new Promise<undefined>((done) => {
      timer = setTimeout(done, waitMs, undefined);
    }),
  ]);
  clearTimeout(timer);
  if (!answer || !Array.isArray(answer.logos)) return;
  answer.logos.forEach((one, index) => {
    const ask = batch[index];
    if (!ask || !one) return;
    const one_ = slot(repoKey(ask, ask.homepage));
    if (one_() !== undefined) return;
    if (one.status === "hit") one_.set(`data:${one.type};base64,${one.data}`);
    else if (one.status === "miss") one_.set(null);
  });
}

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
  /** An installed plugin: the host reads its own picture, then its homepage's icon. */
  installed?: boolean;
  size?: number;
}) {
  const host = useHost();
  const c = colors();
  const size = () => props.size ?? 28;
  const key = () =>
    props.installed
      ? `installed:${props.name}`
      : props.repo
        ? repoKey(props.repo, props.homepage)
        : (props.homepage ?? "");
  const state = () => slot(key());
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
            : repo
              ? { ...repo, homepage: props.homepage ?? null }
              : { homepage: at },
        );
      (repo ? turn(ask) : ask())
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
      <If
        when={picture()}
        else={
          <Label
            variant="small"
            weight={600}
            style={{ color: avatarInk(avatarFill(props.name)) }}
          >
            {avatarInitial(props.name)}
          </Label>
        }
      >
        <Image
          src={picture()!}
          fadeDuration={0}
          style={{ width: size(), height: size() }}
        />
      </If>
    </View>
  );
}
