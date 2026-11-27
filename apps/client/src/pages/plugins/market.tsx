import type {
  ComposioAuth,
  ComposioToolkit,
  MarketCatalog,
  MarketEntry,
  MarketPreview,
  PluginResults,
} from "@eta/client-contracts";
import type { JSX, ScrollProps } from "nsh";
import type { Layout } from "../../components";
import type { LogoAsk } from "./plugin-logo";
import {
  COMPOSIO_AUTH_CONFIGS_URL,
  composioNeedsOwnConfig,
} from "@eta/client-contracts";
import {
  cleanup,
  effect,
  lifecycle,
  openUrl,
  signal,
  untracked,
  View,
} from "nsh";
import {
  Button,
  colors,
  CompactSkeleton,
  Field,
  grow,
  Header,
  Label,
  Modal,
  row,
  SmoothScroll,
  textFaces,
} from "../../components";
import { hint } from "../../components/controls";
import { EmptyState } from "../../components/empty-state";
import { ListSkeleton } from "../../components/loading-skeleton";
import { CloseButton } from "../../components/navigation-buttons";
import { avatar, control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import { ComposioDisconnect, linkAndOpen } from "./composio-actions";
import { sheetEdge } from "./configure";
import { pendingLogos, PluginLogo, primeLogos } from "./plugin-logo";
import { PluginName } from "./plugin-name";
import { PluginSettingsButton } from "./settings-button";

/**
 * The online market. Everything the catalog says is shown as text, never as markup. The detail shows
 * what the plugin at its pinned commit would run, and Install installs at once, at that commit (the
 * user decided to drop the confirmation step; the host still pins the commit and refuses what it
 * does not support).
 */
/** A market card: four fit across the market of a 1440-wide window (267 was
 * off the grid; 268 left room for three). The search field and the detail sheet's scrolling body
 * have their own bounds. */
const cardWidth = 264;
const searchWidth = 480;
const detailHeight = 440;

/** The last list shown, kept for the session: the market opened again draws it on its first frame. */
let lastCatalog: MarketCatalog | undefined;

/** How often, and how many times, the market asks Composio whether a toolkit got connected (about three minutes). */
const POLL_MS = 3000;
const POLL_LIMIT = 60;

/** How many rows of cards the market draws at first, and each time Show more is pressed or the end comes near. A batch is whole rows, so how many cards it holds follows from the columns. */
const ROWS = 10;
/** On a phone a row is one short card, so a batch holds more rows: ten of them would not fill the screen, and nothing would scroll to draw the next. */
const PHONE_ROWS = 20;
/** The widest card (a Composio one), for how many fit in a row; the gap between cards is `space[12]`. */
const CARD_SPACE = 267; // design-value: the Composio card's width, the widest card
/** How near the end of the list, in points, the next batch is drawn without Show more being pressed: about a screen, so the next batch is drawn before the end is seen. */
const NEAR_END = 800; // design-value: a distance of scrolling, not a style
/** How long a search waits for the next key before the list follows it. */
const SEARCH_MS = 175;

/** What a search looks through, lower-cased once per item, not on every key. */
const haystacks = new WeakMap<object, string>();
const haystack = (item: object, parts: () => string[]): string => {
  let text = haystacks.get(item);
  if (text === undefined) {
    text = parts().join(" ").toLowerCase();
    haystacks.set(item, text);
  }
  return text;
};

export function Market(props: {
  layout: Layout;
  tabs: () => JSX.Element;
  onBack?: () => void;
  onSettings: () => void;
  /** Opens an address in the browser; the system's by default. */
  open?: (url: string) => Promise<void>;
}) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const catalog = signal<MarketCatalog | undefined>(lastCatalog);
  const show = (next: MarketCatalog) => {
    lastCatalog = next;
    catalog.set(next);
  };
  const loading = signal(false);
  const query = signal("");
  /** The words the list is filtered by: the field's, after the typing paused. */
  const needle = signal("");
  let typing: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const next = query().trim().toLowerCase();
    untracked(() => {
      clearTimeout(typing);
      typing = setTimeout(() => needle.set(next), SEARCH_MS);
    });
  });
  cleanup(() => clearTimeout(typing));
  const detail = signal("");
  /** What the open entry would run, read from its pinned commit: shown in the detail before installing. */
  const info = signal<MarketPreview>();
  const infoLoading = signal(false);
  const infoError = signal("");
  const installError = signal("");
  const busy = signal(false);
  const phone = () => props.layout === "phone";
  const key = (item: MarketEntry) => `${item.source}\n${item.name}`;
  const all = () =>
    (catalog()?.sources ?? []).flatMap((item) => item.entries ?? []);
  const entries = () =>
    all().filter(
      (item) =>
        needle() === "" ||
        haystack(item, () => [
          item.name,
          item.description,
          item.author,
          item.sourceName,
        ]).includes(needle()),
    );
  const current = () => all().find((item) => key(item) === detail());
  const toolkitKey = (item: ComposioToolkit) => `composio\n${item.slug}`;
  const allToolkits = () =>
    (catalog()?.sources ?? []).flatMap((item) => item.toolkits ?? []);
  const toolkits = () =>
    allToolkits().filter(
      (item) =>
        needle() === "" ||
        haystack(item, () => [
          item.name,
          item.description,
          item.sourceName,
          ...item.categories,
        ]).includes(needle()),
    );
  /** The width of the list of cards, once laid out: what the columns follow from. */
  const room = signal(0);
  /** Whether the columns are known: at once on a phone (one), after the first layout elsewhere. Until then nothing is drawn, which would only be redrawn, with its pictures asked for, once the width says how many fit. */
  const known = () => phone() || room() > 0;
  const columns = () =>
    phone()
      ? 1
      : Math.max(
          1,
          Math.floor((room() + space[12]) / (CARD_SPACE + space[12])),
        );
  const batchRows = () => (phone() ? PHONE_ROWS : ROWS);
  /** How many rows of the matching cards (toolkits first, then the other sources' plugins) are drawn: none until the first batch's pictures were asked for. A new search starts again from the first batch. */
  const rows = signal(0);
  const drawn = () => (known() ? rows() * columns() : 0);
  /** Everything the search matches, whatever is drawn: a search looks through all of it. */
  const total = () => toolkits().length + entries().length;
  /** The pictures to ask the host for before the first `count` matching cards are drawn. */
  const asksFor = (count: number): LogoAsk[] => [
    ...toolkits()
      .slice(0, count)
      .map((item) => ({ composio: item.slug })),
    ...entries()
      .slice(0, Math.max(0, count - toolkits().length))
      .filter((item) => item.repo !== "" && item.unsupported === null)
      .map((item) => ({
        repo: item.repo,
        ref: item.rev ?? "HEAD",
        path: item.path,
        homepage: item.homepage,
      })),
  ];
  let reaching = 0;
  /**
   * Draw up to `to` rows. First the host is asked, once, for the pictures it kept for the cards that
   * come with them, and waited for (a little): so they are drawn with their pictures, and not one by
   * one afterwards. Nothing to ask for, or no answer in time, draws at once.
   */
  const reach = (to: number) => {
    const token = ++reaching;
    const need = pendingLogos(asksFor(to * columns()));
    if (need.length === 0) rows.set(to);
    else
      void primeLogos(host, need).then(() => {
        if (token === reaching) rows.set(to);
      });
  };
  /** The height of the content when scrolling last drew a batch: another is drawn only once the content has grown. */
  let drawnAt = 0;
  // The first batch, once there is something to draw and the columns are known.
  effect(() => {
    if (known() && total() > 0 && rows() === 0)
      untracked(() => reach(batchRows()));
  });
  // A new search draws its first batch at once: what it shows is mostly drawn (and asked for) before.
  effect(() => {
    needle();
    untracked(() => {
      if (rows() > 0) rows.set(batchRows());
      drawnAt = 0;
    });
  });
  /** Scrolled near the end of the list: draw the next batch. Show more stays for a list that does not fill the view. */
  const nearEnd: NonNullable<ScrollProps["onScroll"]> = (event) => {
    const end = event.contentSize.height;
    if (
      total() <= drawn() ||
      end === drawnAt ||
      event.offset.y + event.size.height < end - NEAR_END
    )
      return;
    drawnAt = end;
    reach(rows() + batchRows());
  };
  const shownToolkits = () => toolkits().slice(0, drawn());
  /** The other sources' plugins come after the toolkits, so they fill what the toolkits leave of the batch. */
  const shownEntries = () =>
    entries().slice(0, Math.max(0, drawn() - toolkits().length));
  const currentToolkit = () =>
    allToolkits().find((item) => toolkitKey(item) === detail());
  /** A Composio source with no key, or whose key was refused: an answer of its own, not a failure of the market. */
  const composioNotes = () =>
    (catalog()?.sources ?? []).filter(
      (item) => item.status === "needs_key" || item.status === "key_rejected",
    );
  const failed = () =>
    (catalog()?.sources ?? []).filter((item) => item.error !== null);
  const skipped = () =>
    (catalog()?.sources ?? []).flatMap((item) =>
      item.rejected.map((one) => ({
        ...one,
        from: item.source.name || item.source.url,
      })),
    );
  const stale = () =>
    (catalog()?.sources ?? []).filter((item) => item.stale != null);
  /** The oldest time among the catalogs shown: when the whole list was last confirmed. */
  const updated = () => {
    const times = (catalog()?.sources ?? []).flatMap((item) =>
      item.entries !== null && item.updatedAt != null ? [item.updatedAt] : [],
    );
    return times.length === 0
      ? undefined
      : new Date(Math.min(...times)).toLocaleString();
  };
  /** The toolkits Composio says are connected. A mark only: when it cannot be read, no mark shows. */
  const connected = signal<string[]>([]);
  const isConnected = (slug: string) => connected().includes(slug);
  async function refreshConnected(): Promise<void> {
    const answer = await host
      .call<PluginResults["composioConnected"]>(
        "plugins",
        "composioConnected",
        {},
      )
      .catch(() => undefined);
    if (!answer || !Array.isArray(answer.slugs)) return;
    // A failed read keeps what was known; a key that is gone or refused knows nothing.
    if (answer.status === "ready") connected.set(answer.slugs);
    else if (answer.status !== "error") connected.set([]);
  }
  /** The toolkits that need no sign-in and were added. A mark only, like the connected ones. */
  const added = signal<string[]>([]);
  const isAdded = (slug: string) => added().includes(slug);
  async function refreshAdded(): Promise<void> {
    const answer = await host
      .call<PluginResults["composioAdded"]>("plugins", "composioAdded", {})
      .catch(() => undefined);
    if (answer && Array.isArray(answer.slugs)) added.set(answer.slugs);
  }
  /** The toolkit being waited for after Connect opened the browser; empty when nothing is. */
  const waiting = signal("");
  let timer: ReturnType<typeof setInterval> | undefined;
  let asking = false;
  function stopWaiting() {
    clearInterval(timer);
    timer = undefined;
    waiting.set("");
  }
  async function checkWaiting() {
    const slug = waiting();
    if (slug === "" || asking) return;
    asking = true;
    try {
      await refreshConnected();
    } finally {
      asking = false;
    }
    if (waiting() === slug && isConnected(slug)) stopWaiting();
  }
  function startWaiting(slug: string) {
    stopWaiting();
    waiting.set(slug);
    let asked = 0;
    timer = setInterval(() => {
      if (++asked > POLL_LIMIT) stopWaiting();
      else void checkWaiting();
    }, POLL_MS);
  }
  cleanup(() => clearInterval(timer));
  // The window got the focus back (the user is coming back from the browser): ask at once.
  effect(() => {
    if (lifecycle() !== "active" || waiting() === "") return;
    untracked(() => void checkWaiting());
  });
  // The first time toolkits are on the screen, and each time one is opened.
  let asked = false;
  effect(() => {
    if (allToolkits().length === 0) return;
    untracked(() => {
      if (asked) return;
      asked = true;
      void refreshConnected();
      void refreshAdded();
    });
  });
  effect(() => {
    if (!detail().startsWith("composio\n")) return;
    untracked(() => {
      void refreshConnected();
      void refreshAdded();
    });
  });
  const messageOf = (error: unknown) =>
    error instanceof Error && error.message !== ""
      ? error.message
      : String(error);

  /** Connecting a toolkit: the host starts it with Composio, and the user finishes in the browser. */
  async function connect(toolkit: ComposioToolkit) {
    if (busy()) return;
    busy.set(true);
    installError.set("");
    try {
      await linkAndOpen(host, props.open ?? openUrl, toolkit.slug);
      // Already connected: nothing to wait for, the mark is there.
      if (!isConnected(toolkit.slug)) startWaiting(toolkit.slug);
    } catch (error) {
      installError.set(messageOf(error));
    } finally {
      busy.set(false);
    }
  }
  /** The toolkit whose Disconnect is being asked about. */
  const disconnecting = signal<ComposioToolkit | undefined>(undefined);
  function disconnected(slug: string) {
    // Gone at once; the host is asked again behind it.
    connected.update((all) => all.filter((one) => one !== slug));
    disconnecting.set(undefined);
    void refreshConnected();
  }
  /** Adding a toolkit that needs no sign-in: no link and no browser, the host makes it a plugin. */
  async function add(toolkit: ComposioToolkit) {
    if (busy()) return;
    busy.set(true);
    installError.set("");
    try {
      const done = await host.call<PluginResults["composioAdd"]>(
        "plugins",
        "composioAdd",
        { slug: toolkit.slug },
      );
      if (done.status === "ready")
        added.update((all) =>
          all.includes(toolkit.slug) ? all : [...all, toolkit.slug],
        );
      else
        installError.set(
          done.status === "needs_key"
            ? uiText("composioNeedsKey")
            : done.status === "key_rejected"
              ? uiText("composioKeyRejected")
              : uiText("composioAddFailed"),
        );
    } catch (error) {
      installError.set(messageOf(error));
    } finally {
      busy.set(false);
    }
  }
  /** Taking an added toolkit away asks nothing of Composio, so there is nothing to confirm. */
  async function removeAdded(toolkit: ComposioToolkit) {
    if (busy()) return;
    busy.set(true);
    installError.set("");
    try {
      await host.call<PluginResults["composioRemove"]>(
        "plugins",
        "composioRemove",
        { slug: toolkit.slug },
      );
      added.update((all) => all.filter((one) => one !== toolkit.slug));
    } catch (error) {
      installError.set(messageOf(error));
    } finally {
      busy.set(false);
    }
  }
  async function clearCache() {
    await host.action(() => host.call("plugins", "marketClearCache", {}));
    await load();
  }
  follow(() => "plugins");

  async function load() {
    if (loading()) return;
    loading.set(true);
    // What the host kept shows at once (a list already on screen stays); it also says which sources
    // there are now. Then each source is read on its own and replaces only its own part, so a slow
    // one holds nothing back. A kept list is never hidden because it is old.
    const kept = await host.action(() =>
      host.call<MarketCatalog>("plugins", "marketCatalog", { mode: "cached" }),
    );
    if (kept) {
      const before = catalog();
      const merged: MarketCatalog = {
        ...kept,
        sources: kept.sources.map((item) => {
          const shown = before?.sources.find(
            (one) => one.source.url === item.source.url,
          );
          return shown?.entries != null && item.entries === null ? shown : item;
        }),
      };
      if (merged.sources.some((item) => item.entries !== null)) {
        show(merged);
      } else catalog.set(merged);
    }
    const urls = (kept?.sources ?? []).map((item) => item.source.url);
    if (urls.length === 0) {
      const result = await host.action(() =>
        host.call<MarketCatalog>("plugins", "marketCatalog", {}),
      );
      if (result) show(result);
    } else {
      await Promise.all(
        urls.map(async (url) => {
          const result = await host.action(() =>
            host.call<MarketCatalog>("plugins", "marketCatalog", {
              source: url,
            }),
          );
          const one = result?.sources.find((item) => item.source.url === url);
          const now = catalog();
          if (!one || !now) return;
          show({
            ...now,
            proxy: result!.proxy,
            sources: now.sources.map((item) =>
              item.source.url === url ? one : item,
            ),
          });
        }),
      );
    }
    loading.set(false);
  }
  effect(() => {
    host.subscriptionWire();
    untracked(() => void load());
  });

  /** Read what the entry would run. The same read an install pins its commit from; nothing is installed. */
  async function readInfo(entry: MarketEntry): Promise<MarketPreview> {
    return await host.call<MarketPreview>("plugins", "marketPreview", {
      name: entry.name,
      source: entry.source,
    });
  }
  // Opening an entry reads what it would run, so the detail shows it before anyone installs.
  effect(() => {
    const open = detail();
    untracked(() => {
      info.set(undefined);
      infoError.set("");
      installError.set("");
      const entry = all().find((item) => key(item) === open);
      if (!entry || entry.unsupported !== null || entry.installed !== "no")
        return;
      infoLoading.set(true);
      readInfo(entry)
        .then((result) => {
          if (detail() === open) info.set(result);
        })
        .catch((error: unknown) => {
          if (detail() === open) infoError.set(messageOf(error));
        })
        .finally(() => {
          if (detail() === open) infoLoading.set(false);
        });
    });
  });
  /**
   * Install at the commit the detail showed (read once more when it could not be read). The host
   * still pins to that commit and refuses anything it does not support; a plugin that needs values
   * stays "needs configuration" and starts nothing until they are filled in.
   */
  async function install(entry: MarketEntry) {
    if (busy()) return;
    busy.set(true);
    installError.set("");
    try {
      const shown = info() ?? (await readInfo(entry));
      await host.call("plugins", "marketInstall", {
        name: shown.name,
        source: entry.source,
        sha: shown.sha,
      });
      await load();
    } catch (error) {
      installError.set(messageOf(error));
    } finally {
      busy.set(false);
    }
  }
  const field = (
    label: string,
    value: () => string,
    onChange: (value: string) => void,
  ) => (
    <Field
      label={label}
      placeholder={label}
      value={value()}
      compact
      onChange={onChange}
      style={
        phone()
          ? { height: control.touch, paddingHorizontal: space[12] }
          : undefined
      }
    />
  );
  const authLabel = (auth: ComposioAuth) =>
    auth === "api_key"
      ? uiText("composioAuthApiKey")
      : auth === "oauth"
        ? uiText("composioAuthOauth")
        : auth === "none"
          ? uiText("composioAuthNone")
          : uiText("composioAuthUnknown");
  const authHelp = (auth: ComposioAuth) =>
    auth === "api_key"
      ? uiText("composioAuthApiKeyHelp")
      : auth === "oauth"
        ? uiText("composioAuthOauthHelp")
        : auth === "none"
          ? uiText("composioAuthNoneHelp")
          : uiText("composioAuthUnknownHelp");
  const marker = (item: MarketEntry) =>
    item.unsupported !== null
      ? uiText("marketUnsupported")
      : item.installed === "this"
        ? uiText("marketInstalled")
        : item.installed === "other"
          ? uiText("marketNameTaken")
          : "";
  /** A labelled value; a value that is empty or only blanks is not shown at all, nor its label. */
  const line = (name: string, value: string | null | undefined) =>
    value === null || value === undefined || value.trim() === "" ? null : (
      <View style={{ gap: space[2] }}>
        <Label variant="caption" tone="muted">
          {name}
        </Label>
        <Label variant="small" style={{ userSelect: "text" }}>
          {value}
        </Label>
      </View>
    );
  /** What the plugin would run, read from its pinned commit. Plain text; nothing here installs anything. */
  const previewBlock = (shown: MarketPreview) => (
    <View testID="market-info" style={{ gap: space[8] }}>
      <If when={shown.proxy}>
        {line(uiText("marketProxy"), shown.proxy ?? "")}
      </If>
      {line(uiText("marketPath"), shown.path || "/")}
      {line(
        uiText("marketRequires"),
        shown.requires.length
          ? shown.requires.join(", ")
          : uiText("marketNone"),
      )}
      <Label variant="small" weight={weight.regular}>
        {uiText("marketSummary", {
          skills: shown.skills.length,
          servers: shown.servers.length,
        })}
      </Label>
      <Label variant="caption" tone="muted">
        {uiText("marketServers")}
      </Label>
      <If when={!shown.servers.length}>
        <Label variant="small">{uiText("marketNone")}</Label>
      </If>
      <Each of={shown.servers} key={(item) => item.name}>
        {(server) => (
          <View
            style={{
              gap: space[4],
              padding: space[8],
              borderWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label variant="small" weight={weight.regular}>
              {server().name}
            </Label>
            <Label variant="small" style={{ userSelect: "text" }}>
              {server().transport === "stdio"
                ? (server().command ?? []).join(" ")
                : (server().url ?? "")}
            </Label>
            <If when={Object.keys(server().fixedEnv).length}>
              <Label
                variant="caption"
                tone="muted"
                style={{ userSelect: "text" }}
              >
                {`${uiText("marketFixedEnv")}: ${Object.entries(
                  server().fixedEnv,
                )
                  .map(([key, value]) => `${key}=${value}`)
                  .join(" ")}`}
              </Label>
            </If>
            <If when={server().env.length}>
              <Label
                variant="caption"
                tone="muted"
                style={{ userSelect: "text" }}
              >
                {`${uiText("marketEnv")}: ${server().env.join(", ")}`}
              </Label>
            </If>
            <If when={server().headers.length}>
              <Label
                variant="caption"
                tone="muted"
                style={{ userSelect: "text" }}
              >
                {`${uiText("marketHeaders")}: ${server().headers.join(", ")}`}
              </Label>
            </If>
          </View>
        )}
      </Each>
      <If when={shown.fields.length}>
        {line(
          uiText("marketFields"),
          shown.fields
            .map((item) => item.name + (item.secret ? " *" : ""))
            .join(", "),
        )}
      </If>
      <If when={shown.layout}>
        {line(uiText("marketLayout"), shown.layout ?? "")}
      </If>
      <If when={shown.reports.length}>
        {line(uiText("marketReports"), shown.reports.join("; "))}
      </If>
    </View>
  );
  const sheet = (title: string, width: number, onClose: () => void) => ({
    title,
    width,
    onClose,
    phone: phone(),
    sheet: phone(),
    plainSheetHeader: phone(),
    panelStyle: phone() ? sheetEdge : undefined,
    overPhoneNavigation: phone(),
    compact: !phone(),
    titleWeight: weight.regular,
  });
  const inset = () => (phone() ? { paddingHorizontal: space[16] } : {});

  return (
    <View style={grow}>
      <Header
        title={uiText("plugins")}
        layout={props.layout}
        inset={phone() ? undefined : space[12]}
        onBack={phone() ? props.onBack : undefined}
      >
        <View style={{ flex: 1 }} />
        <View style={{ ...row, gap: space[12] }}>
          {/* Like the refresh button beside it, small and ghost on every layout. */}
          <PluginSettingsButton layout="desktop" onPress={props.onSettings} />
          <Button
            label={uiText("refreshPlugins")}
            icon="refresh"
            spinIcon
            busy={loading()}
            iconOnly
            iconSize={icon.md}
            size={control.sm}
            style={{ paddingHorizontal: 0 }}
            tone="ghost"
            onPress={() => void load()}
          />
        </View>
      </Header>
      {props.tabs()}
      <SmoothScroll
        style={grow}
        scrollbar={false}
        onScroll={nearEnd}
        scrollEventThrottle={16}
      >
        <View
          style={{
            paddingHorizontal: phone() ? space[16] : space[24],
            paddingTop: space[8],
            paddingBottom: space[16],
            gap: space[12],
          }}
        >
          <If
            when={
              !catalog() ||
              !catalog()!.sources.length ||
              (!all().length && !failed().length)
            }
          >
            <EmptyState
              size="page"
              status={catalog() ? "empty" : loading() ? "loading" : "error"}
              loading={<ListSkeleton label={uiText("marketLoading")} />}
              error={{
                title: uiText("marketDidNotLoad"),
                description: uiText("marketDidNotLoadHint"),
                retry: () => void load(),
              }}
              empty={
                catalog()?.sources.length
                  ? {
                      art: "plugins",
                      title: uiText("marketEmpty"),
                      description: uiText("marketEmptyHint"),
                    }
                  : {
                      art: "plugins",
                      title: uiText("marketNoSources"),
                      description: uiText("marketNoSourcesHint"),
                    }
              }
              style={{ paddingHorizontal: 0, paddingVertical: space[24] }}
            />
          </If>
          <Each of={failed()} key={(item) => item.source.url}>
            {(item) => (
              <EmptyState
                size="card"
                status="error"
                loading={null}
                error={{
                  title: uiText("marketSourceDidNotLoad", {
                    name: item().source.name || item().source.url,
                  }),
                  description: uiText("marketUnavailable"),
                  problem: item().error ?? undefined,
                  retry: () => void load(),
                }}
                empty={{ title: item().source.name || item().source.url }}
                style={{
                  paddingHorizontal: 0,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              />
            )}
          </Each>
          <Each of={stale()} key={(item) => item.source.url}>
            {(item) => (
              <Label
                variant="small"
                tone="muted"
                style={{ userSelect: "text" }}
              >
                {uiText("marketKeptCopy", {
                  name: item().source.name || item().source.url,
                  time: new Date(item().updatedAt ?? 0).toLocaleString(),
                  reason: problemText(item().stale ?? ""),
                })}
              </Label>
            )}
          </Each>
          <If when={updated() !== undefined}>
            <View
              style={{
                ...row,
                gap: space[8],
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <Label variant="small" tone="muted">
                {uiText("marketUpdatedAt", { time: updated() ?? "" })}
              </Label>
              <Button
                label={uiText("marketClearCache")}
                tone="ghost"
                onPress={() => void clearCache()}
              />
            </View>
          </If>
          <Each of={composioNotes()} key={(item) => item.source.url}>
            {(item) => (
              <View testID="composio-note" style={{ gap: space[4] }}>
                <Label weight={500}>
                  {item().status === "needs_key"
                    ? uiText("composioNeedsKey")
                    : uiText("composioKeyRejected")}
                </Label>
                <Label variant="small" tone="muted">
                  {item().status === "needs_key"
                    ? uiText("composioNeedsKeyHint")
                    : uiText("composioKeyRejectedHint")}
                </Label>
              </View>
            )}
          </Each>
          <If when={all().length || allToolkits().length}>
            <View style={{ maxWidth: searchWidth }}>
              {field(uiText("marketSearch"), query, query.set)}
            </View>
            <If when={!entries().length && !toolkits().length}>
              <EmptyState
                size="page"
                status="empty"
                loading={null}
                error={null}
                empty={{
                  title: uiText("marketNothingFound", {
                    query: query().trim(),
                  }),
                  actions: [
                    {
                      label: uiText("clearSearch"),
                      onPress: () => query.set(""),
                    },
                  ],
                }}
                announce
                style={{ paddingHorizontal: 0, paddingVertical: space[8] }}
              />
            </If>
            <View
              onLayout={({ bounds }) => room.set(bounds.size.width)}
              style={{
                ...row,
                flexWrap: "wrap",
                alignItems: "flex-start",
                gap: space[12],
              }}
            >
              <Each of={shownToolkits()} key={toolkitKey}>
                {(item) => (
                  <View
                    role="button"
                    accessibilityLabel={item().name}
                    onPress={() => detail.set(toolkitKey(item()))}
                    style={{
                      // One card per row on a phone, as the plugin cards below: a flex: 1 card with no width in this wrapping row is squeezed to a sliver.
                      width: phone() ? "100%" : 267, // design-value: card width, as on the installed page's Composio cards
                      padding: space[12],
                      gap: 6, // design-value: 6px between a card's lines, not on the space scale
                      backgroundColor: c().canvas,
                      borderWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <View style={{ ...row, gap: space[8] }}>
                      <PluginLogo name={item().name} composio={item().slug} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <PluginName name={item().name} />
                      </View>
                    </View>
                    <Label variant="small" tone="muted" lines={1}>
                      {authLabel(item().auth)}
                    </Label>
                    <Label variant="small" tone="muted" lines={2}>
                      {item().description}
                    </Label>
                    {/* The mark sits where the other sources' markers do: the card's bottom right, on the source's line. */}
                    <View
                      style={{
                        ...row,
                        gap: space[8],
                        minHeight: type("small").line,
                      }}
                    >
                      <View style={grow}>
                        <Label variant="caption" tone="muted" lines={1}>
                          {uiText("marketFrom", { name: item().sourceName })}
                        </Label>
                      </View>
                      <If when={isConnected(item().slug)}>
                        <View
                          testID="composio-connected"
                          style={{ flexShrink: 1, minWidth: 0 }}
                        >
                          <Label variant="small" lines={1}>
                            {uiText("composioConnected")}
                          </Label>
                        </View>
                      </If>
                      <If when={isAdded(item().slug)}>
                        <View
                          testID="composio-added"
                          style={{ flexShrink: 1, minWidth: 0 }}
                        >
                          <Label variant="small" lines={1}>
                            {uiText("composioAdded")}
                          </Label>
                        </View>
                      </If>
                    </View>
                  </View>
                )}
              </Each>
              <Each of={shownEntries()} key={key}>
                {(item) => (
                  <View
                    role="button"
                    accessibilityLabel={item().name}
                    onPress={() => detail.set(key(item()))}
                    style={{
                      // One card per row on a phone: a flex: 1 card in this wrapping row is squeezed to a sliver.
                      width: phone() ? "100%" : cardWidth,
                      padding: space[12],
                      gap: space[8],
                      backgroundColor: c().canvas,
                      borderWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <View style={{ ...row, gap: space[8] }}>
                      <PluginLogo
                        name={item().name}
                        homepage={item().homepage}
                        repo={
                          item().repo !== "" && item().unsupported === null
                            ? {
                                repo: item().repo,
                                ref: item().rev ?? "HEAD",
                                path: item().path,
                              }
                            : null
                        }
                      />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <PluginName name={item().name} />
                      </View>
                    </View>
                    <Label variant="small" tone="muted" lines={1}>
                      {[item().version, item().author]
                        .filter((part) => part.trim() !== "")
                        .join(" · ")}
                    </Label>
                    <Label variant="small" tone="muted" lines={2}>
                      {item().description}
                    </Label>
                    {/* The marker sits at the card's bottom right, on the source's line, so it adds no row; the row is as tall as the marker either way. */}
                    <View
                      style={{
                        ...row,
                        gap: space[8],
                        minHeight: type("small").line,
                      }}
                    >
                      <View style={grow}>
                        <Label variant="caption" tone="muted" lines={1}>
                          {uiText("marketFrom", { name: item().sourceName })}
                        </Label>
                      </View>
                      <If when={marker(item())}>
                        <View style={{ flexShrink: 1, minWidth: 0 }}>
                          <Label variant="small" lines={1}>
                            {marker(item())}
                          </Label>
                        </View>
                      </If>
                    </View>
                  </View>
                )}
              </Each>
            </View>
            {/* At the end of the list, after both kinds of card; the list also draws the next batch by itself near its end. */}
            <If when={known() && rows() > 0 && total() > drawn()}>
              <View style={{ alignItems: "center" }}>
                <Button
                  label={uiText("marketShowMore")}
                  tone="ghost"
                  onPress={() => reach(rows() + batchRows())}
                />
              </View>
            </If>
            <If when={skipped().length}>
              <Label variant="small" tone="muted">
                {uiText("marketSkipped", { count: skipped().length })}
              </Label>
              <Each of={skipped()} key={(item) => item.from + item.index}>
                {(item) => (
                  <Label
                    variant="caption"
                    tone="muted"
                    style={{ userSelect: "text" }}
                  >
                    {`${item().from} #${item().index} ${item().name ?? ""}: ${item().reason}`}
                  </Label>
                )}
              </Each>
            </If>
          </If>
        </View>
      </SmoothScroll>
      <If when={currentToolkit()}>
        <Modal
          {...sheet(currentToolkit()!.name, 512, () => detail.set(""))}
          hideHeader
        >
          {/* design-value: the detail's scroll height, as the other detail sheets */}
          <SmoothScroll style={{ maxHeight: 440 }} scrollbar={false}>
            {/* design-value: 10px and 6px in the detail's body, not on the space scale */}
            <View style={{ gap: 10, paddingTop: 6, ...inset() }}>
              <View
                testID="market-detail-header"
                style={{ ...row, gap: space[12], alignItems: "center" }}
              >
                <PluginLogo
                  name={currentToolkit()!.name}
                  composio={currentToolkit()!.slug}
                  size={avatar.xl}
                />
                <View
                  tooltip={hint(currentToolkit()!.name, c)}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <Label variant="title" weight={600} lines={1}>
                    {currentToolkit()!.name}
                  </Label>
                </View>
                {/* design-value: the close button's icon, between icon sizes */}
                <CloseButton onPress={() => detail.set("")} iconSize={14} />
              </View>
              <Label
                variant="small"
                tone="muted"
                style={{ userSelect: "text" }}
              >
                {currentToolkit()!.description}
              </Label>
              {line(uiText("marketSource"), currentToolkit()!.sourceName)}
              {line(
                uiText("composioCategories"),
                currentToolkit()!.categories.join(", "),
              )}
              {line(
                uiText("composioTools"),
                currentToolkit()!.toolsCount === null
                  ? null
                  : String(currentToolkit()!.toolsCount),
              )}
              {line(uiText("composioHomepage"), currentToolkit()!.appUrl)}
              {line(uiText("composioAuth"), authLabel(currentToolkit()!.auth))}
              <Label variant="small">{authHelp(currentToolkit()!.auth)}</Label>
              <If
                when={
                  !currentToolkit()!.managed &&
                  currentToolkit()!.auth !== "none" &&
                  !composioNeedsOwnConfig(currentToolkit()!)
                }
              >
                <Label variant="small" tone="muted">
                  {uiText("composioNotManaged")}
                </Label>
              </If>
              {/* Connect cannot make a config for this one: say so before the click, not after an error. */}
              <If when={composioNeedsOwnConfig(currentToolkit()!)}>
                <Label variant="small" style={{ userSelect: "text" }}>
                  {uiText("composioNoManagedLogin")}
                </Label>
              </If>
              <If when={isConnected(currentToolkit()!.slug)}>
                <View testID="composio-connected">
                  <Label variant="small">{uiText("composioConnected")}</Label>
                </View>
              </If>
              <If when={isAdded(currentToolkit()!.slug)}>
                <View testID="composio-added">
                  <Label variant="small">{uiText("composioAdded")}</Label>
                </View>
              </If>
              <If when={currentToolkit()!.auth !== "none"}>
                <Label variant="small" tone="muted">
                  {uiText("composioConnectNote")}
                </Label>
              </If>
              <If when={installError()}>
                <Label
                  variant="small"
                  tone="red"
                  style={{ userSelect: "text" }}
                >
                  {installError()}
                </Label>
              </If>
            </View>
          </SmoothScroll>
          <View
            style={{
              ...row,
              justifyContent: "flex-end",
              gap: space[8],
              paddingTop: 10, // design-value: 10px above the buttons, not on the space scale
              paddingBottom: phone() ? space[24] : 0,
              ...inset(),
            }}
          >
            <If when={currentToolkit()!.auth === "none"}>
              <If
                when={isAdded(currentToolkit()!.slug)}
                else={
                  <Button
                    label={uiText("composioAdd")}
                    tone="primary"
                    size={phone() ? control.touch : control.md}
                    busy={busy()}
                    onPress={() => void add(currentToolkit()!)}
                  />
                }
              >
                <Button
                  label={uiText("composioRemove")}
                  tone="plain"
                  size={phone() ? control.touch : control.md}
                  busy={busy()}
                  onPress={() => void removeAdded(currentToolkit()!)}
                />
              </If>
            </If>
            <If when={currentToolkit()!.auth !== "none"}>
              <View style={{ ...row, gap: space[8] }}>
                <If when={composioNeedsOwnConfig(currentToolkit()!)}>
                  <Button
                    label={uiText("composioOpenDashboard")}
                    tone="plain"
                    size={phone() ? control.touch : control.md}
                    onPress={() =>
                      void (props.open ?? openUrl)(COMPOSIO_AUTH_CONFIGS_URL)
                    }
                  />
                </If>
                <If when={isConnected(currentToolkit()!.slug)}>
                  <Button
                    label={uiText("composioDisconnect")}
                    tone="plain"
                    size={phone() ? control.touch : control.md}
                    disabled={busy()}
                    onPress={() => disconnecting.set(currentToolkit())}
                  />
                </If>
                <Button
                  label={
                    isConnected(currentToolkit()!.slug)
                      ? uiText("composioReconnect")
                      : uiText("composioConnect")
                  }
                  tone="primary"
                  size={phone() ? control.touch : control.md}
                  busy={busy()}
                  onPress={() => void connect(currentToolkit()!)}
                />
              </View>
            </If>
          </View>
        </Modal>
      </If>
      <If when={disconnecting()}>
        <ComposioDisconnect
          slug={disconnecting()!.slug}
          name={disconnecting()!.name}
          phone={phone()}
          onDone={() => disconnected(disconnecting()!.slug)}
          onClose={() => disconnecting.set(undefined)}
        />
      </If>
      <If when={current()}>
        <Modal
          {...sheet(current()!.name, 512, () => detail.set(""))}
          hideHeader
        >
          <SmoothScroll style={{ maxHeight: detailHeight }} scrollbar={false}>
            <View style={{ gap: space[12], paddingTop: space[8], ...inset() }}>
              <View
                testID="market-detail-header"
                style={{ ...row, gap: space[12], alignItems: "center" }}
              >
                <PluginLogo
                  name={current()!.name}
                  homepage={current()!.homepage}
                  repo={
                    current()!.repo !== "" && current()!.unsupported === null
                      ? {
                          repo: current()!.repo,
                          ref: current()!.rev ?? "HEAD",
                          path: current()!.path,
                        }
                      : null
                  }
                  size={avatar.xl}
                />
                <View
                  tooltip={hint(current()!.name, c)}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <Label variant="title" weight={weight.strong} lines={1}>
                    {current()!.name}
                  </Label>
                </View>
                <CloseButton onPress={() => detail.set("")} />
              </View>
              <Label
                variant="small"
                tone="muted"
                style={{ userSelect: "text" }}
              >
                {current()!.description}
              </Label>
              {line(uiText("marketVersion"), current()!.version)}
              {line(uiText("marketAuthor"), current()!.author)}
              {line(uiText("marketSource"), current()!.sourceName)}
              {line(uiText("marketRepository"), current()!.repo)}
              {line(
                uiText("marketCommit"),
                current()!.rev ?? info()?.sha ?? uiText("marketCommitLatest"),
              )}
              <If when={current()!.unsupported}>
                {line(
                  uiText("marketUnsupported"),
                  current()!.unsupported ?? "",
                )}
              </If>
              <If when={current()!.requires.length}>
                {line(uiText("marketRequires"), current()!.requires.join(", "))}
              </If>
              <If when={current()!.homepage}>
                {line(uiText("marketHomepage"), current()!.homepage ?? "")}
              </If>
              <If when={infoLoading()}>
                <CompactSkeleton label={uiText("marketReading")} />
              </If>
              <If when={infoError()}>
                <Label
                  variant="small"
                  tone="red"
                  style={{ userSelect: "text" }}
                >
                  {infoError()}
                </Label>
              </If>
              <If when={info()}>{(shown) => previewBlock(shown())}</If>
              <If when={installError()}>
                <Label
                  variant="small"
                  tone="red"
                  style={{ userSelect: "text" }}
                >
                  {installError()}
                </Label>
              </If>
            </View>
          </SmoothScroll>
          <View
            style={{
              ...row,
              justifyContent: "flex-end",
              paddingTop: space[12],
              paddingBottom: phone() ? space[24] : 0,
              ...inset(),
            }}
          >
            <If
              when={
                current()!.installed === "no" && current()!.unsupported === null
              }
              else={<Label variant="small">{marker(current()!)}</Label>}
            >
              <Button
                label={uiText("marketInstall")}
                tone="primary"
                size={phone() ? control.touch : control.md}
                busy={busy()}
                onPress={() => void install(current()!)}
              />
            </If>
          </View>
        </Modal>
      </If>
    </View>
  );
}
