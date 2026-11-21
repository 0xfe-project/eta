import type { HostUpdate } from "./host-update";
import { View } from "nsh";
import { Button, Field, Label, Modal, row } from "../../../components";
import { uiText } from "../../../i18n";

export function UpdateSourceEditor(props: {
  update: HostUpdate;
  phone: boolean;
}) {
  const {
    editor,
    closeEditor,
    pending,
    token,
    source,
    draft,
    error,
    editable,
    save,
  } = props.update;

  return (
    <If when={editor()}>
      {(mode) => (
        <Modal
          title={
            mode() === "upstream"
              ? uiText("changeWhereUpdatesComeFrom")
              : uiText("setAccessToken")
          }
          phone={props.phone}
          width={448}
          blurBackdrop={false}
          overPhoneNavigation
          dismissible={!pending()}
          onClose={closeEditor}
        >
          <View style={{ padding: 16, gap: 12 }}>
            <Label
              variant="small"
              tone={mode() === "upstream" ? "amber" : "muted"}
            >
              {mode() === "upstream"
                ? uiText("theHostInstallsAndRunsCode")
                : uiText("theTokenIsStoredOnThe", { host: token()?.host })}
            </Label>
            <Field
              label={
                mode() === "upstream"
                  ? uiText("repositoryOrReleaseServer")
                  : uiText("accessToken")
              }
              placeholder={
                mode() === "upstream" ? source()?.fallback : undefined
              }
              masked={mode() === "token"}
              value={draft()}
              onChange={draft.set}
            />
            <If when={error()}>
              <Label variant="small" tone="red">
                {error()}
              </Label>
            </If>
            <View
              style={{
                ...row,
                flexWrap: "wrap",
                justifyContent: "flex-end",
                gap: 8,
              }}
            >
              <If
                when={mode() === "upstream" ? source()?.saved : token()?.saved}
              >
                <Button
                  label={
                    mode() === "upstream"
                      ? uiText("useDefault")
                      : uiText("removeToken")
                  }
                  disabled={!editable()}
                  onPress={() =>
                    mode() === "upstream"
                      ? void save("setUpstream", {})
                      : void save("setToken", {})
                  }
                />
                <View style={{ flex: 1 }} />
              </If>
              <Button
                label={uiText("cancel")}
                disabled={!!pending()}
                onPress={closeEditor}
              />
              <Button
                label={uiText("save")}
                tone="primary"
                disabled={!editable() || !draft().trim()}
                onPress={() =>
                  mode() === "upstream"
                    ? void save("setUpstream", { upstream: draft().trim() })
                    : void save("setToken", { token: draft().trim() })
                }
              />
            </View>
          </View>
        </Modal>
      )}
    </If>
  );
}
