import type { TaskDetailState } from "./task-detail-state";
import { View } from "nsh";
import { space } from "../../components/tokens";
import { useHost } from "../../services/host";
import { Question } from "../chat/approvals";
import { questionsOfRuns } from "../chat/question-row";

/**
 * The questions the task's runs asked that wait for an answer, as the chat's cards, over the
 * comment box next to the run that asked: a task's question is on no reply in the transcript, so
 * this is where it is answered.
 */
export function TaskQuestions(props: { state: TaskDetailState }) {
  const host = useHost();
  const asked = () =>
    questionsOfRuns(host.pending(), props.state.task()?.runs ?? []);
  return (
    <If when={asked().length}>
      <View style={{ gap: space[8], flexShrink: 0 }}>
        <Each of={asked()} key={(entry) => entry.id}>
          {(entry) => <Question item={entry()} />}
        </Each>
      </View>
    </If>
  );
}
