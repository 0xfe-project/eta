import type {
  ProjectFileContent,
  ProjectResults,
  ProjectView,
} from "@eta/client-contracts";
import type { Layout } from "../../../components";
import { cleanup, effect, signal, View } from "nsh";
import {
  Button,
  colors,
  DetailSkeleton,
  dialogWidth,
  grow,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../../components";
import { EmptyState } from "../../../components/empty-state";
import { codeText } from "../../../components/eta-editor";
import { control, space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { problemText } from "../../../services/problem-text";
import { CopyButton } from "../../../ui";
import { fencedCode, formatFileSize, languageForPath } from "./format";

/** Desktop preview modal height. */
const previewHeight = "80%" as const;
/** Leading window read by the host for large text files (matches `MAX_PREVIEW_BYTES`). */
const maxPreviewBytes = 256 * 1024;

/** Read-only modal preview for one file inside a project. */
export function ProjectFilePreview(props: {
  project: ProjectView;
  path: string;
  layout: Layout;
  onMention?: (path: string) => void;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const phone = () => props.layout === "phone";
  const content = signal<ProjectFileContent | undefined>(undefined);
  const loading = signal(true);
  const error = signal<unknown>(undefined);
  const attempt = signal(0);

  effect(() => {
    const projectId = props.project.id;
    const path = props.path;
    void attempt();
    let active = true;
    cleanup(() => {
      active = false;
    });
    loading.set(true);
    error.set(undefined);
    content.set(undefined);
    void host
      .call<ProjectResults["readFile"]>("projects", "readFile", {
        projectId,
        path,
      })
      .then((result) => {
        if (!active) return;
        content.set(result);
        loading.set(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        error.set(cause);
        loading.set(false);
      });
  });

  const fileName = () => props.path.split("/").pop() ?? props.path;
  const subtitle = () => {
    const data = content();
    const parts = [props.path];
    if (data) parts.push(formatFileSize(data.size));
    return parts.join(" · ");
  };

  return (
    <Modal
      title={fileName()}
      subtitle={subtitle()}
      width={dialogWidth.xl}
      height={phone() ? "100%" : previewHeight}
      phone={phone()}
      phonePage={phone()}
      headerActions={
        <View style={{ ...row, gap: space[4] }}>
          <CopyButton
            value={props.path}
            label={uiText("filesCopyPath")}
            tooltip={uiText("filesCopyPath")}
            iconOnly={!phone()}
            tone="ghost"
            labelTone="muted"
            hoverTone="ink"
            size={control.md}
          />
          <If when={props.onMention}>
            <Button
              label={uiText("filesMention")}
              icon="chat"
              tone="plain"
              size={control.md}
              onPress={() => {
                props.onMention?.(props.path);
                props.onClose();
              }}
            />
          </If>
        </View>
      }
      onClose={props.onClose}
    >
      <If
        when={!loading() && !error() ? content() : undefined}
        else={
          <EmptyState
            size="page"
            status={loading() ? "loading" : "error"}
            loading={<DetailSkeleton label={uiText("fileLoading")} />}
            error={{
              title: uiText("fileLoadError"),
              description: error() ? problemText(error()) : undefined,
              retry: () => attempt.set(attempt() + 1),
            }}
            empty={{ title: uiText("fileEmpty") }}
            style={{ padding: space[16] }}
          />
        }
      >
        {(loaded) => (
          <If
            when={loaded().kind === "text"}
            else={
              <EmptyState
                size="page"
                status="empty"
                loading={null}
                error={null}
                empty={{
                  title: uiText("fileBinaryTitle"),
                  description: uiText("fileBinaryHint"),
                }}
                style={{ padding: space[16] }}
              />
            }
          >
            {() => {
              const textFile = () =>
                loaded() as Extract<ProjectFileContent, { kind: "text" }>;
              return (
                <View style={grow}>
                  <If
                    when={textFile().text.length > 0}
                    else={
                      <EmptyState
                        size="page"
                        status="empty"
                        loading={null}
                        error={null}
                        empty={{ title: uiText("fileEmpty") }}
                        style={{ padding: space[16] }}
                      />
                    }
                  >
                    <SmoothScroll style={grow}>
                      <View style={{ padding: space[12] }}>
                        <codeText.View
                          variant="small"
                          text={{
                            text: fencedCode(
                              textFile().text,
                              languageForPath(props.path),
                            ),
                          }}
                        />
                      </View>
                    </SmoothScroll>
                  </If>
                  <If when={textFile().truncated}>
                    <View
                      style={{
                        paddingHorizontal: space[12],
                        paddingVertical: space[8],
                        borderTopWidth: 1,
                        borderColor: c().border,
                        backgroundColor: c().surface,
                        flexShrink: 0,
                      }}
                    >
                      <Label variant="caption" tone="muted">
                        {uiText("fileTruncatedNotice", {
                          shown: formatFileSize(maxPreviewBytes),
                          total: formatFileSize(textFile().size),
                        })}
                      </Label>
                    </View>
                  </If>
                </View>
              );
            }}
          </If>
        )}
      </If>
    </Modal>
  );
}
