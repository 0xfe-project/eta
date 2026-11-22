import type {
  ComposioAuth,
  ComposioToolkit,
  MarketCatalog,
  MarketEntry,
  MarketPreview,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { Layout } from "../../components";
import { effect, openUrl, signal, untracked, View } from "nsh";
import { Input } from "nsh/base";
import {
  Button,
  colors,
  fontFamily,
  Fonts,
  grow,
  Header,
  Label,
  Modal,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../components";
import { hint } from "../../components/context-ring";
import { CloseButton } from "../../components/navigation-buttons";
import { ToggleSwitch } from "../../components/toggle-switch";
import { PluginLogo } from "./plugin-logo";
import { PluginName } from "./plugin-name";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { sheetEdge } from "./configure";

/**
 * The online market. Everything the catalog says is shown as text, never as markup. The detail shows
 * what the plugin at its pinned commit would run, and Install installs at once, at that commit (the
 * user decided to drop the confirmation step; the host still pins the commit and refuses what it
 * does not support).
 */
export function Market(props: {
  layout: Layout;
  tabs: () => JSX.Element;
  onBack?: () => void;
  /** Opens an address in the browser; the system's by default. */
  open?: (url: string) => Promise<void>;
}) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const fonts = Fonts();
  const catalog = signal<MarketCatalog>();
  const loading = signal(false);
  const query = signal("");
  const detail = signal("");
  /** What the open entry would run, read from its pinned commit: shown in the detail before installing. */
  const info = signal<MarketPreview>();
  const infoLoading = signal(false);
  const infoError = signal("");
  const installError = signal("");
  const busy = signal(false);
  const phone = () => props.layout === "phone";
  const key = (item: MarketEntry) => item.source + "\n" + item.name;
  const all = () =>
    (catalog()?.sources ?? []).flatMap((item) => item.entries ?? []);
  const entries = () => {
    const needle = query().trim().toLowerCase();
    return all().filter(
      (item) =>
        needle === "" ||
        [item.name, item.description, item.author, item.sourceName]
          .join(" ")
          .toLowerCase()
          .includes(needle),
    );
  };
  const current = () => all().find((item) => key(item) === detail());
  const toolkitKey = (item: ComposioToolkit) => "composio\n" + item.slug;
  const allToolkits = () =>
    (catalog()?.sources ?? []).flatMap((item) => item.toolkits ?? []);
  const toolkits = () => {
    const needle = query().trim().toLowerCase();
    return allToolkits().filter(
      (item) =>
        needle === "" ||
        [item.name, item.description, item.sourceName, ...item.categories]
          .join(" ")
          .toLowerCase()
          .includes(needle),
    );
  };
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
      item.rejected.map((one) => ({ ...one, from: item.source.name || item.source.url })),
    );
  const stale = () =>
    (catalog()?.sources ?? []).filter((item) => item.stale != null);
  /** The oldest time among the catalogs shown: when the whole list was last confirmed. */
  const updated = () => {
    const times = (catalog()?.sources ?? []).flatMap((item) =>
      item.entries !== null && item.updatedAt != null ? [item.updatedAt] : [],
    );
    return times.length === 0 ? undefined : new Date(Math.min(...times)).toLocaleString();
  };
  /** Connecting a toolkit: the host starts it with Composio, and the user finishes in the browser. */
  async function connect(toolkit: ComposioToolkit) {
    if (busy()) return;
    busy.set(true);
    installError.set("");
    try {
      const link = await host.call<{ redirectUrl: string }>(
        "plugins",
        "composioLink",
        { slug: toolkit.slug },
      );
      await (props.open ?? openUrl)(link.redirectUrl);
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
    // What the host kept shows at once; the read that asks the servers follows and replaces it.
    if (catalog() === undefined) {
      const kept = await host.action(() =>
        host.call<MarketCatalog>("plugins", "marketCatalog", { mode: "cached" }),
      );
      if (kept?.sources.some((item) => item.entries !== null)) catalog.set(kept);
    }
    const result = await host.action(() =>
      host.call<MarketCatalog>("plugins", "marketCatalog", {}),
    );
    if (result) catalog.set(result);
    loading.set(false);
  }
  effect(() => {
    host.subscriptionWire();
    untracked(() => void load());
  });

  const messageOf = (error: unknown) =>
    error instanceof Error && error.message !== "" ? error.message : String(error);

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
      if (!entry || entry.unsupported !== null || entry.installed !== "no") return;
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
    <Input
      accessibilityLabel={label}
      placeholder={label}
      value={value()}
      submitBehavior="submit"
      onChange={(event) => onChange(event.value)}
      focusStyle={{ borderColor: c().ink }}
      style={{
        color: c().ink,
        placeholderColor: c().faint,
        backgroundColor: c().canvas,
        fontFamily: fontFamily(fonts().interface),
        ...textStyle(type("small")),
        height: phone() ? 40 : 28,
        paddingHorizontal: phone() ? 12 : 8,
        borderWidth: 1,
        borderColor: c().strong,
        borderRadius: 0,
      }}
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
    <View style={{ gap: 2 }}>
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
    <View testID="market-info" style={{ gap: 10 }}>
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
                <Label variant="small" weight={500}>
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
                      style={{ gap: 4, padding: 8, borderWidth: 1, borderColor: c().border }}
                    >
                      <Label variant="small" weight={500}>
                        {server().name}
                      </Label>
                      <Label variant="small" style={{ userSelect: "text" }}>
                        {server().transport === "stdio"
                          ? (server().command ?? []).join(" ")
                          : (server().url ?? "")}
                      </Label>
                      <If when={Object.keys(server().fixedEnv).length}>
                        <Label variant="caption" tone="muted" style={{ userSelect: "text" }}>
                          {uiText("marketFixedEnv") +
                            ": " +
                            Object.entries(server().fixedEnv)
                              .map(([key, value]) => key + "=" + value)
                              .join(" ")}
                        </Label>
                      </If>
                      <If when={server().env.length}>
                        <Label variant="caption" tone="muted" style={{ userSelect: "text" }}>
                          {uiText("marketEnv") + ": " + server().env.join(", ")}
                        </Label>
                      </If>
                      <If when={server().headers.length}>
                        <Label variant="caption" tone="muted" style={{ userSelect: "text" }}>
                          {uiText("marketHeaders") + ": " + server().headers.join(", ")}
                        </Label>
                      </If>
                    </View>
                  )}
                </Each>
                <If when={shown.fields.length}>
                  {line(
                    uiText("marketFields"),
                    shown
                      .fields.map((item) => item.name + (item.secret ? " *" : ""))
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
    titleWeight: 500 as const,
  });
  const inset = () => (phone() ? { paddingHorizontal: 16 } : {});

  return (
    <View style={grow}>
      <Header
        title={uiText("plugins")}
        layout={props.layout}
        inset={phone() ? undefined : 10}
        onBack={phone() ? props.onBack : undefined}
      >
        <View style={{ flex: 1 }} />
        <View style={{ ...row, gap: 12 }}>
          <Button
            label={uiText("refreshPlugins")}
            icon="refresh"
            iconOnly
            iconSize={16}
            size={16}
            style={{ paddingHorizontal: 0 }}
            tone="ghost"
            onPress={() => void load()}
          />
        </View>
      </Header>
      {props.tabs()}
      <SmoothScroll style={grow} scrollbar={false}>
        <View
          style={{
            paddingHorizontal: phone() ? 16 : 24,
            paddingTop: 8,
            paddingBottom: 16,
            gap: 12,
          }}
        >
          <If when={catalog() && !catalog()!.sources.length}>
            <View style={{ gap: 8 }}>
              <Label weight={500}>{uiText("marketNoSources")}</Label>
              <Label variant="small" tone="muted">
                {uiText("marketNoSourcesHint")}
              </Label>
            </View>
          </If>
          <Each of={failed()} key={(item) => item.source.url}>
            {(item) => (
              <View style={{ gap: 4 }}>
                <Label weight={500}>
                  {item().source.name || item().source.url}
                </Label>
                <Label variant="small" tone="muted">
                  {uiText("marketUnavailable")}
                </Label>
                <Label variant="small" tone="muted" style={{ userSelect: "text" }}>
                  {item().error ?? ""}
                </Label>
              </View>
            )}
          </Each>
          <Each of={stale()} key={(item) => item.source.url}>
            {(item) => (
              <Label variant="small" tone="muted" style={{ userSelect: "text" }}>
                {uiText("marketKeptCopy", {
                  name: item().source.name || item().source.url,
                  time: new Date(item().updatedAt ?? 0).toLocaleString(),
                  reason: item().stale ?? "",
                })}
              </Label>
            )}
          </Each>
          <If when={updated() !== undefined}>
            <View style={{ ...row, gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
              <View testID="composio-note" style={{ gap: 4 }}>
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
            <View style={{ maxWidth: 480 }}>
              {field(uiText("marketSearch"), query, query.set)}
            </View>
            <If when={!entries().length && !toolkits().length}>
              <Label variant="small" tone="muted">
                {uiText("marketNothingFound")}
              </Label>
            </If>
            <View
              style={{ ...row, flexWrap: "wrap", alignItems: "flex-start", gap: 12 }}
            >
              <Each of={toolkits()} key={toolkitKey}>
                {(item) => (
                  <View
                    role="button"
                    accessibilityLabel={item().name}
                    onPress={() => detail.set(toolkitKey(item()))}
                    style={{
                      width: phone() ? undefined : 267,
                      flex: phone() ? 1 : undefined,
                      padding: 12,
                      gap: 6,
                      backgroundColor: c().canvas,
                      borderWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <View style={{ ...row, gap: 8 }}>
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
                    <Label variant="caption" tone="muted" lines={1}>
                      {uiText("marketFrom", { name: item().sourceName })}
                    </Label>
                  </View>
                )}
              </Each>
              <Each of={entries()} key={key}>
                {(item) => (
                  <View
                    role="button"
                    accessibilityLabel={item().name}
                    onPress={() => detail.set(key(item()))}
                    style={{
                      width: phone() ? undefined : 267,
                      flex: phone() ? 1 : undefined,
                      padding: 12,
                      gap: 6,
                      backgroundColor: c().canvas,
                      borderWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <View style={{ ...row, gap: 8 }}>
                      <PluginLogo
                        name={item().name}
                        homepage={item().homepage}
                        repo={
                          item().repo !== "" && item().unsupported === null
                            ? { repo: item().repo, ref: item().rev ?? "HEAD", path: item().path }
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
                    <Label variant="caption" tone="muted" lines={1}>
                      {uiText("marketFrom", { name: item().sourceName })}
                    </Label>
                    <If when={marker(item())}>
                      <Label variant="small">{marker(item())}</Label>
                    </If>
                  </View>
                )}
              </Each>
            </View>
            <If when={skipped().length}>
              <Label variant="small" tone="muted">
                {uiText("marketSkipped", { count: skipped().length })}
              </Label>
              <Each of={skipped()} key={(item) => item.from + item.index}>
                {(item) => (
                  <Label variant="caption" tone="muted" style={{ userSelect: "text" }}>
                    {item().from + " #" + item().index + " " + (item().name ?? "") + ": " + item().reason}
                  </Label>
                )}
              </Each>
            </If>
          </If>
        </View>
      </SmoothScroll>
      <If when={currentToolkit()}>
        <Modal {...sheet(currentToolkit()!.name, 512, () => detail.set(""))} hideHeader>
          <SmoothScroll style={{ maxHeight: 440 }} scrollbar={false}>
            <View style={{ gap: 10, paddingTop: 6, ...inset() }}>
              <View testID="market-detail-header" style={{ ...row, gap: 12, alignItems: "center" }}>
                <PluginLogo
                  name={currentToolkit()!.name}
                  composio={currentToolkit()!.slug}
                  size={40}
                />
                <View tooltip={hint(currentToolkit()!.name, c)} style={{ flex: 1, minWidth: 0 }}>
                  <Label variant="title" weight={600} lines={1}>
                    {currentToolkit()!.name}
                  </Label>
                </View>
                <CloseButton onPress={() => detail.set("")} iconSize={14} />
              </View>
              <Label variant="small" tone="muted" style={{ userSelect: "text" }}>
                {currentToolkit()!.description}
              </Label>
              {line(uiText("marketSource"), currentToolkit()!.sourceName)}
              {line(uiText("composioCategories"), currentToolkit()!.categories.join(", "))}
              {line(
                uiText("composioTools"),
                currentToolkit()!.toolsCount === null ? null : String(currentToolkit()!.toolsCount),
              )}
              {line(uiText("composioHomepage"), currentToolkit()!.appUrl)}
              {line(uiText("composioAuth"), authLabel(currentToolkit()!.auth))}
              <Label variant="small">
                {authHelp(currentToolkit()!.auth)}
              </Label>
              <If when={!currentToolkit()!.managed && currentToolkit()!.auth !== "none"}>
                <Label variant="small" tone="muted">
                  {uiText("composioNotManaged")}
                </Label>
              </If>
              <Label variant="small" tone="muted">
                {uiText("composioConnectNote")}
              </Label>
              <If when={installError()}>
                <Label variant="small" tone="red" style={{ userSelect: "text" }}>
                  {installError()}
                </Label>
              </If>
            </View>
          </SmoothScroll>
          <View
            style={{
              ...row,
              justifyContent: "flex-end",
              paddingTop: 10,
              paddingBottom: phone() ? 24 : 0,
              ...inset(),
            }}
          >
            <Button
              label={busy() ? uiText("composioConnecting") : uiText("composioConnect")}
              tone="primary"
              size={phone() ? 44 : 28}
              disabled={busy()}
              onPress={() => void connect(currentToolkit()!)}
            />
          </View>
        </Modal>
      </If>
      <If when={current()}>
        <Modal {...sheet(current()!.name, 512, () => detail.set(""))} hideHeader>
          <SmoothScroll style={{ maxHeight: 440 }} scrollbar={false}>
          <View style={{ gap: 10, paddingTop: 6, ...inset() }}>
            <View testID="market-detail-header" style={{ ...row, gap: 12, alignItems: "center" }}>
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
                size={40}
              />
              <View tooltip={hint(current()!.name, c)} style={{ flex: 1, minWidth: 0 }}>
                <Label variant="title" weight={600} lines={1}>
                  {current()!.name}
                </Label>
              </View>
              <CloseButton onPress={() => detail.set("")} iconSize={14} />
            </View>
            <Label variant="small" tone="muted" style={{ userSelect: "text" }}>
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
              {line(uiText("marketUnsupported"), current()!.unsupported ?? "")}
            </If>
            <If when={current()!.requires.length}>
              {line(uiText("marketRequires"), current()!.requires.join(", "))}
            </If>
            <If when={current()!.homepage}>
              {line(uiText("marketHomepage"), current()!.homepage ?? "")}
            </If>
            <If when={infoLoading()}>
              <Label variant="small" tone="muted">
                {uiText("marketReading")}
              </Label>
            </If>
            <If when={infoError()}>
              <Label variant="small" tone="red" style={{ userSelect: "text" }}>
                {infoError()}
              </Label>
            </If>
            <If when={info()}>{(shown) => previewBlock(shown())}</If>
            <If when={installError()}>
              <Label variant="small" tone="red" style={{ userSelect: "text" }}>
                {installError()}
              </Label>
            </If>
          </View>
          </SmoothScroll>
            <View
              style={{
                ...row,
                justifyContent: "flex-end",
                paddingTop: 10,
                paddingBottom: phone() ? 24 : 0,
                ...inset(),
              }}
            >
              <If
                when={current()!.installed === "no" && current()!.unsupported === null}
                else={<Label variant="small">{marker(current()!)}</Label>}
              >
                <Button
                  label={busy() ? uiText("adding") : uiText("marketInstall")}
                  tone="primary"
                  size={phone() ? 44 : 28}
                  disabled={busy()}
                  onPress={() => void install(current()!)}
                />
              </If>
            </View>
        </Modal>
      </If>
    </View>
  );
}
