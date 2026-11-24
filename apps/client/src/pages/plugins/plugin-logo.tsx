import type {
  PluginLogoResult,
  PluginLogosCachedResult,
} from "@eta/client-contracts";
import type { Signal } from "nsh";
import { effect, Image, signal, untracked, View } from "nsh";
import { colors, Label } from "../../components";
import { useHost } from "../../services/host";
import { avatarFill, avatarInitial, avatarInk } from "./avatar-color";
import { avatar, weight } from "../../components/tokens";

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

/** How long a batch of cards waits for the host's kept pictures before it is drawn with letters. */
const LOGOS_CACHED_WAIT_MS = 400;
/**
 * The most entries one `logosCached` call is asked about. The host answers a call whole only up to
 * about 2 MB of picture data (base64), so a market is asked about in several calls of this size.
 */
const LOGOS_CACHED_BATCH = 50;

/** What `primeLogos` asks the host for: a market entry in a repository, or a Composio toolkit. */
export type LogoAsk =
  | { repo: string; ref: string; path: string; homepage: string | null }
  | { composio: string };
/** The key a card reads its picture under: the same one `PluginLogo` computes. */
const askKey = (ask: LogoAsk): string =>
  "composio" in ask ? `composio:${ask.composio}` : repoKey(ask, ask.homepage);

/** Entries the host was already asked about (whatever it answered): each is asked once. */
const asked = new Set<string>();
/** The calls still waiting for an answer, by the key of each entry in them. */
const flying = new Map<string, Promise<void>>();

/** The entries a card would be drawn without a picture for, unless `primeLogos` is waited for. */
export const pendingLogos = (asks: LogoAsk[]): LogoAsk[] =>
  asks.filter((ask) => {
    const key = askKey(ask);
    return slot(key)() === undefined && (!asked.has(key) || flying.has(key));
  });

/**
 * Before a batch of cards is drawn: ask the host for the pictures it already has for them, each entry
 * once, in calls of at most 50. A hit is put where the card reads it, so its first frame has the
 * picture; a known miss stays a letter without a request. Anything else (unknown, a timeout, an
 * error, a host without this call or without the entry's kind) changes nothing: the card draws its
 * letter and asks for its own picture as before, and only such a card ever does. This never fails and
 * never waits longer than `waitMs`.
 */
export async function primeLogos(
  host: ReturnType<typeof useHost>,
  asks: LogoAsk[],
  waitMs = LOGOS_CACHED_WAIT_MS,
): Promise<void> {
  const fresh = new Map<string, LogoAsk>();
  const waits = new Set<Promise<void>>();
  for (const ask of asks) {
    const key = askKey(ask);
    if (slot(key)() !== undefined) continue;
    const going = flying.get(key);
    if (going) waits.add(going);
    else if (!asked.has(key) && !fresh.has(key)) fresh.set(key, ask);
  }
  const entries = [...fresh.values()];
  const batchOf = async (batch: LogoAsk[]): Promise<void> => {
    const answer = await host
      .call<PluginLogosCachedResult>("plugins", "logosCached", {
        entries: batch,
      })
      .catch(() => undefined);
    if (!answer || !Array.isArray(answer.logos)) return;
    answer.logos.forEach((one, index) => {
      const ask = batch[index];
      if (!ask || !one) return;
      const one_ = slot(askKey(ask));
      if (one_() !== undefined) return;
      if (one.status === "hit") one_.set(`data:${one.type};base64,${one.data}`);
      else if (one.status === "miss") one_.set(null);
    });
  };
  for (let at = 0; at < entries.length; at += LOGOS_CACHED_BATCH) {
    const batch = entries.slice(at, at + LOGOS_CACHED_BATCH);
    const keys = batch.map(askKey);
    for (const key of keys) asked.add(key);
    const done: Promise<void> = batchOf(batch).finally(() => {
      for (const key of keys) if (flying.get(key) === done) flying.delete(key);
    });
    for (const key of keys) flying.set(key, done);
    waits.add(done);
  }
  if (waits.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(waits),
    new Promise<undefined>((done) => {
      timer = setTimeout(done, waitMs, undefined);
    }),
  ]);
  clearTimeout(timer);
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
  /** A Composio toolkit's slug: the host looks the picture up in its own list. */
  composio?: string | null;
  /** An installed plugin: the host reads its own picture, then its homepage's icon. */
  installed?: boolean;
  size?: number;
}) {
  const host = useHost();
  const c = colors();
  const size = () => props.size ?? avatar.lg;
  const key = () =>
    props.installed
      ? `installed:${props.name}`
      : props.composio
        ? `composio:${props.composio}`
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
      <If
        when={picture()}
        else={
          <Label
            variant="small"
            weight={weight.strong}
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
