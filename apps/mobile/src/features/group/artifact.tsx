// 03n 产物查看 and 03o 产物分享. The site runs in a web view from a preview address the host hands out
// for the version. That address carries an hour's capability, so it is asked for each time a version
// is shown and kept nowhere else. Every page under it is served in a sandbox by the host.

import type { ArtifactArgs, ArtifactResults, ArtifactVersionView, ArtifactView } from "@eta/client-contracts";
import { Clipboard, computed, effect, openUrl, Scroll, signal, Text, View, WebView } from "nsh";
import { t } from "../../i18n";
import { nav } from "../../nav/stack";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { Page } from "../../ui/Page";
import { Sheet } from "../../ui/Sheet";
import { Empty, Failed, Loading } from "../../ui/States";
import { reason } from "../../ui/format";
import { hostUrl } from "../../ui/hostUrl";
import { toast } from "../../ui/toast";
import { call, useTarget } from "../../wire/target";
import { act, SheetRow, SheetTitle } from "./shared";

/** A page with no address, the fake host's: a web view only navigates to http(s), so it takes the markup. */
const inlinePage = (url: string): string | undefined =>
  url.startsWith("data:text/html") ? decodeURIComponent(url.slice(url.indexOf(",") + 1)) : undefined;

/** What this app can show in its frame. A version of anything else is its ZIP, as on the web. */
const framed = (version: ArtifactVersionView | undefined): boolean =>
  version?.viewer === "iframe" && version.kind === "site";

function BarButton(props: { title: string; first?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      class={`h-[52px] grow basis-0 items-center justify-center active:bg-muted ${props.first ? "" : "border-l border-border"}`}
    >
      <Text class={`text-base leading-[18px] ${props.disabled ? "text-muted-foreground" : "text-foreground"}`}>
        {props.title}
      </Text>
    </View>
  );
}

function ShareSheet(props: { open: boolean; link: string; onRevoke: () => void; onClose: () => void }) {
  const copy = () =>
    act(Clipboard.writeText(hostUrl(props.link)), () => toast(t("common.copied")));
  return (
    <Sheet open={props.open} onClose={props.onClose} testID="share-sheet">
      <SheetTitle title={t("group.share.title")} body={t("group.share.hint")} />
      <View class="flex-row items-center gap-2 px-4 pb-3">
        <View class="h-11 min-w-0 grow basis-0 justify-center bg-muted px-3">
          <Text class="truncate text-base leading-[18px] text-foreground">
            {hostUrl(props.link).replace(/^https?:\/\//, "")}
          </Text>
        </View>
        <Button title={t("group.share.copy")} variant="primary" grow={false} height={44} onPress={copy} />
      </View>
      <View
        role="button"
        accessibilityLabel={t("group.share.revoke")}
        onPress={props.onRevoke}
        class="gap-[2px] border-t border-border px-4 py-3 active:bg-muted"
      >
        <Text class="text-lead leading-[22px] text-state-error">{t("group.share.revoke")}</Text>
        <Text class="text-sm leading-[18px] text-muted-foreground">{t("group.share.revokeHint")}</Text>
      </View>
    </Sheet>
  );
}

export function ArtifactScreen(props: { id: string; version?: number | undefined }) {
  const target = useTarget("artifacts");
  const artifact = () =>
    (target.section<ArtifactView[]>("list") ?? []).find((item) => item.id === props.id);
  const versions = () => artifact()?.versions ?? [];
  const chosen = signal(props.version);
  const current = () => versions().find((version) => version.number === chosen()) ?? versions()[0];
  const latest = () => versions()[0]?.number;
  const label = (version: ArtifactVersionView) =>
    t(version.number === latest() && versions().length > 1 ? "group.artifact.latest" : "group.artifact.version", {
      version: version.number,
    });

  const shown = computed(() => (framed(current()) ? current()?.number : undefined));
  const preview = signal<string | undefined>(undefined);
  const failure = signal<string | undefined>(undefined);
  const attempt = signal(0);

  // Only a new version or a retry asks again: a push of the list must not reload the page.
  let asked = "";
  let latestAsk = 0;
  effect(() => {
    const number = shown();
    const key = `${number}:${attempt()}`;
    if (key === asked) return;
    asked = key;
    const ask = ++latestAsk;
    preview.set(undefined);
    failure.set(undefined);
    if (number === undefined) return;
    const args: ArtifactArgs["preview"] = { artifactId: props.id, version: number };
    call<ArtifactResults["preview"]>("artifacts", "preview", args).then(
      (result) => {
        if (ask === latestAsk) preview.set(result.url);
      },
      (error: unknown) => {
        if (ask === latestAsk) failure.set(reason(error));
      },
    );
  });

  const picking = signal(false);
  const sharing = signal(false);
  // The list's push may come after the reply.
  const justShared = signal<string | null>(null);
  const shareLink = () => current()?.shareUrl ?? justShared();

  const share = () => {
    const version = current();
    if (version === undefined) return;
    if (shareLink() !== null) {
      sharing.set(true);
      return;
    }
    act(
      call<ArtifactResults["share"]>("artifacts", "share", {
        artifactId: props.id,
        version: version.number,
      }),
      (result) => {
        justShared.set(
          result.artifact.versions.find((item) => item.number === version.number)?.shareUrl ?? null,
        );
        sharing.set(true);
      },
    );
  };
  const revoke = () => {
    const version = current();
    if (version === undefined) return;
    act(
      call("artifacts", "unshare", { artifactId: props.id, version: version.number }),
      () => {
        justShared.set(null);
        sharing.set(false);
        toast(t("group.share.revoked"));
      },
    );
  };

  // The app's own ZIP is behind the token and the system browser has none: only a public one opens.
  const download = () => {
    const link = shareLink();
    if (link === null) toast(t("group.artifact.downloadNeedsShare"));
    else act(openUrl(hostUrl(`${link}archive.zip`)));
  };
  const openOutside = () => {
    const url = preview();
    if (url !== undefined) act(openUrl(hostUrl(url)));
  };
  const pick = (number: number) => {
    picking.set(false);
    justShared.set(null);
    chosen.set(number);
  };

  return (
    <Page>
      <View class="h-12 shrink-0 flex-row items-center gap-2 border-b border-border pr-4 pl-2">
        <View
          role="button"
          accessibilityLabel={t("common.close")}
          testID="back"
          onPress={() => nav.pop()}
          class="h-11 w-10 shrink-0 items-center justify-center active:opacity-60"
        >
          <Icon name="x" size={20} />
        </View>
        <Text class="truncate grow basis-0 text-lead leading-[20px] text-foreground">{artifact()?.title ?? ""}</Text>
        <If when={current()}>
          {(version) => (
            <View
              role="button"
              accessibilityLabel={t("group.artifact.versions")}
              testID="artifact-version"
              onPress={() => {
                if (versions().length > 1) picking.set(true);
              }}
              class="h-6 flex-row items-center gap-1 border border-border px-2 active:bg-muted"
            >
              <Text class="text-md leading-4 text-foreground">{label(version())}</Text>
              <If when={versions().length > 1}>
                <Icon name="caretDown" size={12} color="muted-foreground" />
              </If>
            </View>
          )}
        </If>
      </View>

      <View class="min-h-0 grow basis-0 bg-surface">
        <If when={target.loaded()} else={<Loading />}>
          <If when={current() !== undefined} else={<Empty title={t("group.artifact.gone")} />}>
            <If
              when={framed(current())}
              else={<Empty title={t("group.artifact.downloadOnly")} body={t("group.artifact.downloadOnlyBody")} />}
            >
              <If
                when={failure() === undefined}
                else={
                  <Failed
                    title={t("group.artifact.loadFailed")}
                    body={failure()}
                    onRetry={() => attempt.set(attempt() + 1)}
                  />
                }
              >
                <If when={preview()} else={<Loading />}>
                  {(url) => (
                    <WebView
                      testID="artifact-page"
                      {...(inlinePage(url()) === undefined
                        ? { src: hostUrl(url()) }
                        : { html: inlinePage(url()) as string })}
                      style={{ flex: 1 }}
                      onError={(error) => failure.set(error.message)}
                    />
                  )}
                </If>
              </If>
            </If>
          </If>
        </If>
      </View>

      <If when={current() !== undefined}>
        <View class="h-[52px] shrink-0 flex-row items-center border-t border-border-strong">
          <BarButton first title={t("group.artifact.share")} onPress={share} />
          <BarButton title={t("group.artifact.download")} onPress={download} />
          <BarButton
            title={t("group.artifact.openOutside")}
            disabled={preview() === undefined}
            onPress={openOutside}
          />
        </View>
      </If>

      <Sheet open={picking()} onClose={() => picking.set(false)} testID="version-sheet">
        <SheetTitle title={t("group.artifact.versions")} />
        <Scroll style={{ maxHeight: 416 }}>
          <Each of={versions()} key={(version) => version.number}>
            {(version) => (
              <SheetRow
                title={label(version())}
                testID={`version-${version().number}`}
                trailing={version().number === current()?.number ? <Icon name="check" size={16} /> : undefined}
                onPress={() => pick(version().number)}
              />
            )}
          </Each>
        </Scroll>
      </Sheet>
      <ShareSheet
        open={sharing()}
        link={shareLink() ?? ""}
        onRevoke={revoke}
        onClose={() => sharing.set(false)}
      />
    </Page>
  );
}
