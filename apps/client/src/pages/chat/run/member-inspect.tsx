import type { MessageView } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { colors, grow, Label, row } from "../../../components";
import { AgentFace } from "../../../components/agent-face";
import { CloseButton } from "../../../components/navigation-buttons";
import {
  avatar,
  control,
  icon,
  space,
  weight,
} from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { Segmented } from "../../tasks/segmented";
import { MemberContext } from "./member-context";
import { MemberRun } from "./member-run";

type InspectTab = "trace" | "context";

/**
 * A member's Inspect: its latest run (Trace, what it did) and its session's context (Context,
 * what it has to work with). Trace is where it opens, every time: it is what the button was for
 * before Context existed, and a remembered tab would open a reader on a prompt dump they did not
 * ask for this time.
 */
export function MemberInspect(props: {
  session: string;
  agentId: string;
  phone: boolean;
  reply?: MessageView;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const tab = signal<InspectTab>("trace");
  const tabs = () => (
    <View testID="inspect-tabs">
      <Segmented
        options={[
          { value: "trace", label: uiText("inspectTrace") },
          { value: "context", label: uiText("inspectContext") },
        ]}
        value={tab()}
        height={props.phone ? control.touch : control.sm}
        paddingHorizontal={props.phone ? space[16] : space[8]}
        onChange={tab.set}
      />
    </View>
  );
  return (
    <View style={grow}>
      {/* On a phone the page header holds the title and Back; the tabs sit under it. */}
      <If when={props.phone}>
        <View
          style={{
            ...row,
            paddingHorizontal: space[16],
            paddingTop: space[12],
            flexShrink: 0,
          }}
        >
          {tabs()}
        </View>
      </If>
      <If
        when={tab() === "context"}
        else={
          <MemberRun
            session={props.session}
            agentId={props.agentId}
            phone={props.phone}
            reply={props.reply}
            tabs={props.phone ? undefined : tabs()}
            onClose={props.onClose}
          />
        }
      >
        <If when={!props.phone}>
          <View
            style={{
              ...row,
              height: control.md,
              gap: space[8],
              marginTop: space[12],
              marginBottom: space[8],
              paddingHorizontal: space[12],
              flexShrink: 0,
            }}
          >
            <AgentFace id={props.agentId} size={avatar.sm} />
            <Label
              variant="small"
              weight={weight.regular}
              lines={1}
              style={grow}
            >
              {host.agent(props.agentId)?.name ?? uiText("agent")}
            </Label>
            {tabs()}
            <CloseButton
              size={control.sm}
              iconSize={icon.md}
              style={{ marginRight: -space[4] }}
              onPress={props.onClose}
            />
          </View>
        </If>
        <View
          style={{
            ...grow,
            borderTopWidth: props.phone ? 0 : 1,
            borderColor: c().border,
          }}
        >
          <MemberContext
            session={props.session}
            agentId={props.agentId}
            phone={props.phone}
          />
        </View>
      </If>
    </View>
  );
}
