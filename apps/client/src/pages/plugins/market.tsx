import type {
  MarketCatalog,
  MarketEntry,
  MarketPreview,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { Layout } from "../../components";
import { effect, signal, untracked, View } from "nsh";
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
import { ToggleSwitch } from "../../components/toggle-switch";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { sheetEdge } from "./configure";

/**
 * The online market. Everything the catalog says is shown as text, never as markup, and an install
 * is only offered after the preview of what the plugin at the pinned commit would run.
 */
export function Market(props: {
  layout: Layout;
  tabs: () => JSX.Element;
  onBack?: () => void;
}) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const fonts = Fonts();
  const catalog = signal<MarketCatalog>();
  const loading = signal(false);
  const query = signal("");
  const detail = signal("");
  const preview = signal<MarketPreview>();
  const agreed = signal(false);
  const busy = signal(false);
  /** The source of the entry being previewed: what `install` is asked for. */
  const from = signal("");
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
  const failed = () =>
    (catalog()?.sources ?? []).filter((item) => item.error !== null);
  const skipped = () =>
    (catalog()?.sources ?? []).flatMap((item) =>
      item.rejected.map((one) => ({ ...one, from: item.source.name || item.source.url })),
    );
  follow(() => "plugins");

  async function load() {
    if (loading()) return;
    loading.set(true);
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

  async function look(entry: MarketEntry) {
    if (busy()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call<MarketPreview>("plugins", "marketPreview", {
        name: entry.name,
        source: entry.source,
      }),
    );
    busy.set(false);
    if (!result) return;
    from.set(entry.source);
    agreed.set(false);
    preview.set(result);
  }
  async function install() {
    const shown = preview();
    if (!shown || !agreed() || busy()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call("plugins", "marketInstall", {
        name: shown.name,
        source: from(),
        sha: shown.sha,
      }),
    );
    busy.set(false);
    if (!result) return;
    preview.set(undefined);
    detail.set("");
    from.set("");
    await load();
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
  const marker = (item: MarketEntry) =>
    item.unsupported !== null
      ? uiText("marketUnsupported")
      : item.installed === "this"
      ? uiText("marketInstalled")
      : item.installed === "other"
        ? uiText("marketNameTaken")
        : "";
  const line = (name: string, value: string) => (
    <View style={{ gap: 2 }}>
      <Label variant="caption" tone="muted">
        {name}
      </Label>
      <Label variant="small" style={{ userSelect: "text" }}>
        {value}
      </Label>
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
          <Label variant="small" tone="muted" style={{ maxWidth: 1000 }}>
            {uiText("marketIntro")}
          </Label>
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
          <If when={all().length}>
            <View style={{ maxWidth: 480 }}>
              {field(uiText("marketSearch"), query, query.set)}
            </View>
            <If when={!entries().length}>
              <Label variant="small" tone="muted">
                {uiText("marketNothingFound")}
              </Label>
            </If>
            <View
              style={{ ...row, flexWrap: "wrap", alignItems: "flex-start", gap: 12 }}
            >
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
                    <Label weight={500} lines={1}>
                      {item().name}
                    </Label>
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
      <If when={current() && !preview()}>
        <Modal {...sheet(current()!.name, 512, () => detail.set(""))}>
          <View style={{ gap: 10, paddingTop: 6, paddingBottom: phone() ? 24 : 0, ...inset() }}>
            <Label variant="small" tone="muted" style={{ userSelect: "text" }}>
              {current()!.description}
            </Label>
            {line(uiText("marketVersion"), current()!.version)}
            {line(uiText("marketAuthor"), current()!.author)}
            {line(uiText("marketSource"), current()!.sourceName)}
            {line(uiText("marketRepository"), current()!.repo)}
            {line(
              uiText("marketCommit"),
              current()!.rev ?? uiText("marketCommitLatest"),
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
            <View style={{ ...row, justifyContent: "flex-end", paddingTop: 10 }}>
              <If
                when={current()!.installed === "no" && current()!.unsupported === null}
                else={<Label variant="small">{marker(current()!)}</Label>}
              >
                <Button
                  label={busy() ? uiText("marketReading") : uiText("marketInstall")}
                  tone="primary"
                  size={phone() ? 44 : 28}
                  disabled={busy()}
                  onPress={() => void look(current()!)}
                />
              </If>
            </View>
          </View>
        </Modal>
      </If>
      <If when={preview()}>
        {(shown) => (
          <Modal
            {...sheet(
              uiText("marketConfirmTitle", { name: shown().name }),
              560,
              () => preview.set(undefined),
            )}
          >
            <SmoothScroll style={{ maxHeight: 420 }} scrollbar={false}>
              <View style={{ gap: 10, paddingTop: 6, ...inset() }}>
                <Label variant="small" tone="muted">
                  {uiText("marketConfirmDescription")}
                </Label>
                <If when={shown().proxy}>
                  {line(uiText("marketProxy"), shown().proxy ?? "")}
                </If>
                {line(uiText("marketRepository"), shown().repo)}
                {line(uiText("marketPath"), shown().path || "/")}
                {line(uiText("marketCommit"), shown().sha)}
                {line(
                  uiText("marketRequires"),
                  shown().requires.length
                    ? shown().requires.join(", ")
                    : uiText("marketNone"),
                )}
                <Label variant="caption" tone="muted">
                  {uiText("marketServers")}
                </Label>
                <If when={!shown().servers.length}>
                  <Label variant="small">{uiText("marketNone")}</Label>
                </If>
                <Each of={shown().servers} key={(item) => item.name}>
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
                <If when={shown().fields.length}>
                  {line(
                    uiText("marketFields"),
                    shown()
                      .fields.map((item) => item.name + (item.secret ? " *" : ""))
                      .join(", "),
                  )}
                </If>
                <If when={shown().reports.length}>
                  {line(uiText("marketReports"), shown().reports.join("; "))}
                </If>
              </View>
            </SmoothScroll>
            <View style={{ ...row, gap: 10, paddingTop: 12, ...inset() }}>
              <ToggleSwitch
                label={uiText("marketAgree")}
                checked={agreed()}
                onChange={agreed.set}
              />
              <Label variant="small" style={{ flex: 1 }}>
                {uiText("marketAgree")}
              </Label>
            </View>
            <View
              style={{
                ...row,
                justifyContent: "flex-end",
                gap: 8,
                paddingTop: 12,
                paddingBottom: phone() ? 24 : 0,
                ...inset(),
              }}
            >
              <Button
                label={uiText("cancel")}
                size={phone() ? 44 : 28}
                onPress={() => preview.set(undefined)}
              />
              <Button
                label={busy() ? uiText("adding") : uiText("marketInstall")}
                tone="primary"
                size={phone() ? 44 : 28}
                dimDisabled={false}
                style={{ opacity: agreed() && !busy() ? 1 : 0.5 }}
                disabled={!agreed() || busy()}
                onPress={() => void install()}
              />
            </View>
          </Modal>
        )}
      </If>
    </View>
  );
}
