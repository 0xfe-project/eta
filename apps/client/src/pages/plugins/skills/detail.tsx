import type {
  SkillFileContent,
  SkillFileEntry,
  SkillFileResults,
  SkillSummary,
} from "@eta/client-contracts";
import type { ScrollRef, ViewRef } from "nsh";
import type { Layout } from "../../../components";
import type { SkillReadingPosition } from "./reader";
import { cleanup, effect, openUrl, signal, untracked, View } from "nsh";
import {
  Button,
  colors,
  DetailSkeleton,
  grow,
  Header,
  Icon,
  Label,
  row,
  SmoothScroll,
} from "../../../components";
import { EmptyState } from "../../../components/empty-state";
import { dotSize } from "../../../components/status-dot";
import { control, icon, space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { problemText } from "../../../services/problem-text";
import { SkillFileTree } from "./file-tree";
import { SkillFile, skillFileLink } from "./reader";

export type SkillCall = <T>(
  action: string,
  input: Record<string, unknown>,
) => Promise<T>;

export function SkillDetail(props: {
  skill: SkillSummary;
  call: SkillCall;
  layout: Layout;
  location: string;
  scope: string;
  onClose: () => void;
}) {
  const c = colors();
  const handle = signal("");
  const files = signal<SkillFileEntry[]>([]);
  const file = signal<SkillFileContent>();
  const fileName = signal("");
  const directory = signal("");
  const showFiles = signal(false);
  const metadata = signal(false);
  const history = signal<{ path: string; y: number; metadata: boolean }[]>([]);
  const position = signal<SkillReadingPosition>();
  const scroll = signal<ScrollRef>();
  const contentStart = signal<ViewRef>();
  const failure = signal<unknown>(undefined);
  const reading = signal(false);
  const retry = signal(0);
  const openDiagnostics = signal<string[]>([]);
  const phone = () => props.layout === "phone";
  const tablet = () => props.layout === "tablet";
  let request = 0;
  let linkRequest = 0;
  let scrollY = 0;
  function showError(error: unknown) {
    failure.set(error ?? new Error("failed"));
  }

  effect(() => {
    const skill = props.skill.path;
    const call = props.call;
    retry();
    let active = true;
    let opened: string | undefined;
    cleanup(() => {
      active = false;
      request++;
      if (opened) void call("close", { detail: opened }).catch(() => {});
    });
    request++;
    handle.set("");
    files.set([]);
    file.set(undefined);
    fileName.set("");
    directory.set("");
    metadata.set(false);
    history.set([]);
    position.set(undefined);
    scrollY = 0;
    reading.set(false);
    failure.set(undefined);
    openDiagnostics.set([]);
    void call<SkillFileResults["open"]>("open", { skill }).then(
      (result) => {
        opened = result.detail;
        if (active) {
          openDiagnostics.set(result.diagnostics);
          handle.set(opened);
        } else void call("close", { detail: opened }).catch(() => {});
      },
      (error) => {
        if (active) showError(error);
      },
    );
  });

  effect(() => {
    const detail = handle();
    const path = directory();
    files.set([]);
    if (!detail) return;
    const call = props.call;
    let active = true;
    cleanup(() => {
      active = false;
    });
    void (async () => {
      try {
        let offset: number | null = 0;
        const entries: SkillFileEntry[] = [];
        do {
          const result: SkillFileResults["directory"] = await call(
            "directory",
            { detail, path, offset },
          );
          if (!active) return;
          entries.push(...result.entries);
          offset = result.next;
        } while (offset !== null);
        files.set(entries);
        if (!path && !untracked(fileName)) void read("SKILL.md");
      } catch (error) {
        if (active) showError(error);
      }
    })();
  });

  async function read(
    path: string,
    target: SkillReadingPosition = { kind: "offset", y: 0 },
    expandedMetadata = false,
  ) {
    const detail = handle();
    if (!detail) return;
    const version = ++request;
    file.set(undefined);
    fileName.set(path);
    metadata.set(expandedMetadata);
    position.set(undefined);
    scrollY = target.kind === "offset" ? target.y : 0;
    failure.set(undefined);
    reading.set(true);
    try {
      const result = await props.call<SkillFileContent>("read", {
        detail,
        path,
      });
      if (version === request) {
        file.set(result);
        position.set(target);
      }
    } catch (error) {
      if (version === request) showError(error);
    } finally {
      if (version === request) reading.set(false);
    }
  }

  const preview = () => {
    const content = file();
    return content?.kind === "text" ? content.preview : undefined;
  };
  const loadingSkill = () => !failure() && (reading() || !handle());
  const reloading = loadingSkill;
  const refresh = () => retry.update((count) => count + 1);
  const reload = () => (
    <Button
      label={uiText("skillReloadReader")}
      icon="refresh"
      spinIcon
      busy={reloading()}
      iconOnly
      iconSize={icon.md}
      tone={tablet() ? "plain" : "ghost"}
      style={tablet() ? undefined : { marginLeft: space[8] }}
      onPress={refresh}
    />
  );
  const crumbs = () => [props.location, props.scope].join("  /  ");
  async function resource(path: string) {
    return props.call<SkillFileContent>("read", { detail: handle(), path });
  }
  async function followFileLink(url: string, focusTarget?: ViewRef) {
    if (!file()) return;
    const navigation = ++linkRequest;
    if (/^https?:\/\//i.test(url)) {
      void openUrl(url).catch(showError);
      return;
    }
    const source = fileName();
    const link = skillFileLink(source, url);
    if (!link) return;
    const target: SkillReadingPosition =
      link.heading === undefined
        ? { kind: "offset", y: 0 }
        : { kind: "heading", heading: link.heading };
    if (link.path === source) {
      position.set(target);
      return;
    }
    const sourceRequest = request;
    const [preview, origin, focused] = await Promise.all([
      scroll()?.measure(),
      contentStart()?.measure(),
      focusTarget?.measure(),
    ]).catch(() => []);
    if (navigation !== linkRequest || sourceRequest !== request) return;
    // Tab can scroll to a link before the scroll event reaches the reader.
    let y =
      preview && origin
        ? Math.max(0, preview.pagePosition.y - origin.pagePosition.y)
        : scrollY;
    if (preview && origin && focused) {
      const fromTop = focused.pagePosition.y - preview.pagePosition.y;
      const viewerHeight = preview.bounds.size.height;
      const linkHeight = focused.bounds.size.height;
      if (fromTop < 0 || fromTop + linkHeight > viewerHeight) {
        // Fast Tab/Enter can leave an older focus scroll in flight. Return to the link that opened the file.
        y = Math.max(0, y + fromTop - (viewerHeight - linkHeight) / 2);
      }
    }
    history.update((entries) => [
      ...entries,
      { path: source, y, metadata: metadata() },
    ]);
    directory.set(link.path.split("/").slice(0, -1).join("/"));
    void read(link.path, target);
  }
  function previousFile() {
    const prior = history().at(-1);
    if (!prior) {
      props.onClose();
      return;
    }
    history.update((entries) => entries.slice(0, -1));
    showFiles.set(false);
    directory.set(prior.path.split("/").slice(0, -1).join("/"));
    void read(prior.path, { kind: "offset", y: prior.y }, prior.metadata);
  }
  function toggleFiles() {
    if (showFiles()) position.set({ kind: "offset", y: scrollY });
    showFiles.set(!showFiles());
  }
  async function scrollToHeading(anchor: ViewRef, isCurrent: () => boolean) {
    const start = contentStart();
    const preview = scroll();
    if (!start || !preview) return;
    const [target, origin] = await Promise.all([
      anchor.measure(),
      start.measure(),
    ]);
    if (!isCurrent() || !target || !origin) return;
    // An inline text marker sits on the first line's baseline. Leave the heading above it visible.
    preview.scrollTo({
      y: Math.max(0, target.pagePosition.y - origin.pagePosition.y - 36),
      animated: false,
    });
    position.set(undefined);
  }
  const previousButton = (iconOnly = false) => (
    <If when={history().length}>
      <Button
        label={uiText("skillPreviousFile")}
        icon="back"
        iconOnly={iconOnly}
        tone="ghost"
        onPress={previousFile}
      />
    </If>
  );
  const diagnostics = () => {
    const content = file();
    return [
      ...new Set([
        ...props.skill.diagnostics,
        ...openDiagnostics(),
        ...(content?.kind === "text" ? content.diagnostics : []),
      ]),
    ];
  };

  const filePreview = () => (
    <SmoothScroll
      ref={scroll.set}
      style={grow}
      scrollbar={false}
      onScroll={({ offset }) => {
        if (file()) scrollY = offset.y;
      }}
    >
      <View
        ref={contentStart.set}
        style={{ padding: space[12], gap: space[12] }}
      >
        <If when={preview()?.metadata}>
          <View
            style={{
              gap: space[4],
              paddingBottom: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <View
              role="button"
              accessibilityLabel={uiText("metadata")}
              accessibilityState={{ expanded: metadata() }}
              onPress={() => metadata.set(!metadata())}
              style={{
                ...row,
                gap: space[4],
                alignSelf: "flex-start",
                cursor: "pointer",
              }}
            >
              <Icon name={metadata() ? "down" : "right"} size={icon.sm} />
              <Label variant="small">{uiText("metadata")}</Label>
            </View>
            <If when={metadata()}>
              <View style={{ paddingLeft: space[16], gap: space[2] }}>
                <Each of={preview()!.metadata!.split("\n")}>
                  {(line) => (
                    <Label variant="caption" tone="muted">
                      {line()}
                    </Label>
                  )}
                </Each>
              </View>
            </If>
          </View>
        </If>
        <If
          when={file()}
          else={
            <EmptyState
              size="page"
              status={
                failure() !== undefined
                  ? "error"
                  : loadingSkill()
                    ? "loading"
                    : "empty"
              }
              loading={
                <DetailSkeleton
                  label={uiText("loadingSkill")}
                  style={{ padding: 0, paddingTop: space[8] }}
                />
              }
              error={{
                title: uiText("skillDidNotLoadFile", {
                  name: fileName() || props.skill.name,
                }),
                description: problemText(failure()),
                problem: failure(),
                retry: refresh,
              }}
              empty={{ title: uiText("selectAFile") }}
              width="narrow"
              style={{ paddingHorizontal: 0, paddingVertical: space[8] }}
            />
          }
        >
          {(content) => (
            <SkillFile
              content={content()}
              path={fileName()}
              position={position()}
              onLink={(url, focusTarget) =>
                void followFileLink(url, focusTarget)
              }
              onOffset={(y) => scroll()?.scrollTo({ y, animated: false })}
              onHeading={(anchor, active) =>
                void scrollToHeading(anchor, active)
              }
              read={resource}
            />
          )}
        </If>
      </View>
    </SmoothScroll>
  );

  const diagnosticList = () => (
    <If when={diagnostics().length}>
      <View
        accessibilityLabel={uiText("skillDiagnostics")}
        style={{
          paddingHorizontal: phone() ? 0 : tablet() ? space[12] : space[24],
          paddingTop: tablet() ? space[12] : 0,
          paddingBottom: phone() || tablet() ? 0 : space[8],
          gap: space[4],
        }}
      >
        <Each of={diagnostics()} key={(message) => message}>
          {(message) => (
            // A small warning mark beside foreground text: red or warning
            // stays a status mark, never the message.
            <View style={{ ...row, alignItems: "flex-start", gap: space[8] }}>
              <View
                style={{
                  width: dotSize,
                  height: dotSize,
                  marginTop: space[4],
                  flexShrink: 0,
                  backgroundColor: c().warning,
                }}
              />
              <Label variant="small" style={{ flex: 1, minWidth: 0 }}>
                {message()}
              </Label>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
  const fileBox = () => (
    <View
      style={{
        ...grow,
        ...row,
        alignItems: "stretch",
        marginHorizontal: phone() ? 0 : tablet() ? space[12] : space[24],
        marginTop: tablet() ? space[12] : 0,
        marginBottom: phone() ? 0 : tablet() ? space[12] : space[16],
        borderWidth: 1,
        borderColor: c().border,
      }}
    >
      <If when={!phone() || showFiles()}>
        <SkillFileTree
          layout={props.layout}
          directory={directory()}
          files={files()}
          selected={fileName()}
          onDirectory={directory.set}
          onRead={(path) => {
            history.set([]);
            showFiles.set(false);
            void read(path);
          }}
        />
      </If>
      <If when={!phone() || !showFiles()}>{filePreview()}</If>
    </View>
  );

  return (
    <View style={grow}>
      <If when={phone()}>
        <Header title={props.skill.name} layout="phone" onBack={previousFile} />
      </If>
      <If when={tablet()}>
        <Header title={props.skill.name} layout="tablet" inset={space[16]}>
          <Label
            variant="small"
            tone="muted"
            style={{ flex: 1 }}
          >{`${props.scope} · ${props.location}`}</Label>
          {previousButton(true)}
          {reload()}
        </Header>
      </If>
      <If when={!tablet() && !phone()}>
        <View
          style={{
            paddingHorizontal: space[24],
            paddingBottom: space[8],
            gap: space[8],
          }}
        >
          <View style={{ ...row, gap: space[8] }}>
            <Button
              label={uiText("skillBackToList")}
              tone="ghost"
              onPress={props.onClose}
            />
            {previousButton()}
          </View>
          <View style={{ ...row, gap: space[4], minHeight: space[24] }}>
            <Label variant="small" tone="muted">{`${crumbs()}  /`}</Label>
            <Label variant="small" weight={weight.strong}>
              {props.skill.name}
            </Label>
            {reload()}
          </View>
        </View>
      </If>
      <If
        when={phone()}
        else={
          <>
            {diagnosticList()}
            {fileBox()}
          </>
        }
      >
        {/* Phone: one column of the breadcrumb, the diagnostics, the Files
            toggle and the file, 8pt apart. */}
        <View
          style={{
            ...grow,
            paddingHorizontal: space[16],
            paddingVertical: space[12],
            gap: space[8],
          }}
        >
          <View style={{ ...row, height: space[16] }}>
            <Label variant="small" tone="muted" style={{ flex: 1 }}>
              {crumbs()}
            </Label>
            {reload()}
          </View>
          {diagnosticList()}
          <View
            role="button"
            accessibilityLabel={uiText("files")}
            accessibilityState={{ expanded: showFiles() }}
            onPress={toggleFiles}
            style={{
              ...row,
              height: control.md,
              gap: space[4],
              alignSelf: "flex-start",
              paddingHorizontal: space[12],
              borderWidth: 1,
              borderColor: showFiles() ? c().ink : c().strong,
              backgroundColor: showFiles() ? c().selected : undefined,
              cursor: "pointer",
            }}
          >
            <Icon name="folder" size={icon.sm} />
            <Label variant="small">{uiText("files")}</Label>
            <If when={!showFiles() && fileName()}>
              <Label variant="caption" tone="muted">
                {fileName()}
              </Label>
            </If>
          </View>
          {fileBox()}
        </View>
      </If>
    </View>
  );
}
