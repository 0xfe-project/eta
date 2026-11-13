import type { MessageView } from "@eta/client-contracts";
import type { CaptainReviewItem } from "./captain-review-model";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown";
import { agentName, useAgentList } from "@/queries/agents";
import { reviewItemsOf } from "./captain-review-model";
import { when } from "./routine-format";
import { StateMark } from "./state-mark";

type ReviewTone = "attention" | "danger" | "neutral" | "success";
type ReviewLabel =
  | "settled"
  | "blocked"
  | "stalled"
  | "inbox"
  | "decision"
  | "inboxPending"
  | "offline"
  | "stuck"
  | "taskStalled"
  | "taskBlocked"
  | "failure"
  | "failureFinal"
  | "reviewFailed"
  | "waiting"
  | "other";

const KINDS = {
  assignment_settled: { label: "settled", tone: "success" },
  assignment_blocked: { label: "blocked", tone: "attention" },
  assignment_stalled: { label: "stalled", tone: "attention" },
  assignment_inbox: { label: "inbox", tone: "attention" },
  inbox_decision: { label: "decision", tone: "attention" },
  inbox_pending: { label: "inboxPending", tone: "attention" },
  task_run_offline: { label: "offline", tone: "danger" },
  task_run_stuck: { label: "stuck", tone: "danger" },
  task_stalled: { label: "taskStalled", tone: "attention" },
  task_blocked: { label: "taskBlocked", tone: "attention" },
  task_failure: { label: "failure", tone: "danger" },
  task_failure_non_retryable: { label: "failureFinal", tone: "danger" },
  review_failed: { label: "reviewFailed", tone: "danger" },
  inbox_relay_waiting: { label: "waiting", tone: "attention" },
} satisfies Record<string, { label: ReviewLabel; tone: ReviewTone }>;

/**
 * A Captain review: the observations the platform's supervisor handed Captain, as one neutral card
 * like a task's. Nothing on it is Captain's colour, because Captain has none: an observation's
 * severity is a small square beside its label — error for what failed, warning for what needs a
 * person — and an ordinary one, such as work that settled, is drawn in grey and still drawn.
 */
export function CaptainReview({ message }: { message: MessageView }) {
  const { t: translateText } = useTranslation("captain");
  const { agents } = useAgentList();
  const reviews = reviewItemsOf(message);
  return (
    <section
      className="captain-review"
      aria-label={translateText("review.title")}
    >
      <header className="flex items-center gap-2 px-2.5 py-[5px] font-mono text-[10px] tracking-[0.08em] text-faint uppercase">
        <span className="task-fold-title flex-none">
          {translateText("review.title")}
        </span>
        <span className="min-w-0 truncate">
          {translateText("review.observations", { count: reviews.length })}
        </span>
        <time
          className="ml-auto shrink-0"
          dateTime={new Date(message.createdAt).toISOString()}
        >
          {when(message.createdAt)}
        </time>
      </header>

      {reviews.length === 0 ? (
        <div className="captain-review-empty">
          <p>{translateText("review.unparsed")}</p>
          <details className="captain-review-details">
            <summary>{translateText("review.technical")}</summary>
            <pre>{message.text}</pre>
          </details>
        </div>
      ) : (
        reviews.map((review) => (
          <ReviewCard
            key={review.id}
            review={review}
            // An item about no agent names none, rather than "a deleted agent".
            agent={
              typeof review.data.agentId === "string"
                ? agentName(agents, review.data.agentId)
                : ""
            }
          />
        ))
      )}
    </section>
  );
}

function ReviewCard({
  review,
  agent,
}: {
  review: CaptainReviewItem;
  agent: string;
}) {
  const { t: translateText } = useTranslation("captain");
  const known = KINDS[review.kind as keyof typeof KINDS];
  const label: ReviewLabel = known?.label ?? "other";
  const tone: ReviewTone = known?.tone ?? "neutral";
  // Only what failed and what needs a person are coloured; settled work is the normal case.
  const ordinary = tone !== "danger" && tone !== "attention";
  const context = contextOf(review, agent, translateText);
  return (
    <article className="captain-review-item" data-tone={tone}>
      <div className="mb-1 flex items-center gap-2 font-mono text-[10px] tracking-[0.08em] uppercase">
        <StateMark
          tone={
            tone === "danger"
              ? "error"
              : tone === "attention"
                ? "warning"
                : "neutral"
          }
          className={ordinary ? "text-muted-foreground" : "text-foreground"}
        >
          {translateText(`review.kinds.${label}`)}
        </StateMark>
        <code className="ml-auto text-faint normal-case tracking-normal">
          {review.kind}
        </code>
      </div>
      <div
        className={
          ordinary
            ? "captain-review-body text-muted-foreground"
            : "captain-review-body text-foreground"
        }
      >
        <Markdown>{review.body}</Markdown>
      </div>
      {context.length === 0 ? null : (
        <div className="captain-review-context">
          {context.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      )}
      <details className="captain-review-details">
        <summary>{translateText("review.technical")}</summary>
        <pre>{review.detail}</pre>
      </details>
    </article>
  );
}

function contextOf(
  review: CaptainReviewItem,
  agent: string,
  translateText: ReturnType<typeof useTranslation<"captain">>["t"],
): string[] {
  const values = new Set<string>();
  if (agent !== "") values.add(agent);
  if (typeof review.data.taskNumber === "number")
    values.add(
      translateText("review.taskNumber", {
        number: review.data.taskNumber,
      }),
    );
  if (typeof review.data.assignmentCount === "number")
    values.add(
      translateText("review.assignments", {
        count: review.data.assignmentCount,
      }),
    );
  else if (Array.isArray(review.data.assignmentIds))
    values.add(
      translateText("review.assignments", {
        count: review.data.assignmentIds.length,
      }),
    );
  if (
    typeof review.data.newAssignmentCount === "number" &&
    review.data.newAssignmentCount > 0
  )
    values.add(
      translateText("review.newAssignments", {
        count: review.data.newAssignmentCount,
      }),
    );
  if (Array.isArray(review.data.runIds))
    values.add(
      translateText("review.runs", { count: review.data.runIds.length }),
    );
  if (Array.isArray(review.data.runs)) {
    for (const run of review.data.runs) {
      if (
        typeof run === "object" &&
        run !== null &&
        typeof (run as { machineName?: unknown }).machineName === "string"
      )
        values.add((run as { machineName: string }).machineName);
    }
  }
  if (typeof review.data.interactionId === "string")
    values.add(translateText("review.inbox"));
  if (typeof review.data.userDecision === "object")
    values.add(translateText("review.userDecision"));
  return [...values];
}
