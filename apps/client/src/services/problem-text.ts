import { WireError } from "@eta/client-contracts/wire";
import { uiText } from "../i18n";

// What the user reads when something fails (#378): never the raw message ("connection closed",
// "not connected", ECONNRESET, a status code, a stack). The raw text goes to the console and is
// kept as the problem's detail (Details in an empty state, the global error bar's Details).

/** The raw text of a failure, as it came: for the console and Details only. */
export function problemDetail(problem: unknown): string {
  if (problem === undefined || problem === null || problem === "") return "";
  if (problem instanceof Error) return problem.message || problem.name;
  return String(problem);
}

/** Text a host or a runtime wrote for people: a sentence, not a code, a stack or a dump. */
function readable(text: string): boolean {
  if (text.length > 240 || text.includes("\n")) return false;
  if (/\b(?:E[A-Z]{3,}|[A-Za-z]*Error|undefined|null|NaN)\b/.test(text))
    return false;
  if (/(?:^|\s)at\s.+:\d+|[{}[\]<>]|\bHTTP\s?\d{3}\b|\b[45]\d\d\b/.test(text))
    return false;
  if (/[\u3400-\u9FFF]/.test(text)) return true;
  // A host's own words ("disk full", "the plugin name is taken"): starting with a letter and more
  // than one word. A lone token ("boom", "EACCES") reads as a code.
  return /^\p{L}/u.test(text.trim()) && text.trim().split(/\s+/).length >= 2;
}

/** Whether the failure is the connection's: no host to ask, or it went away mid-call. */
function offlineProblem(problem: unknown): boolean {
  if (problem instanceof WireError && problem.code === "disconnected")
    return true;
  const text = problemDetail(problem);
  return /not connected|connection (?:closed|lost|refused|reset)|socket|ECONN|ENOTCONN|EPIPE|network|fetch failed|failed to fetch|connect to an eta host first/i.test(
    text,
  );
}

/** Whether the failure is a wait that ran out. */
function timeoutProblem(problem: unknown): boolean {
  if (problem instanceof WireError && problem.code === "timeout") return true;
  return /timed? ?out|ETIMEDOUT|deadline/i.test(problemDetail(problem));
}

/**
 * A failure in the user's words: the connection, a wait that ran out, a host's own sentence as it
 * wrote it, or a plain "it did not go through" for a code, a stack or anything else raw. Where a
 * failure is caught, `logProblem` keeps the raw text in the console.
 */
export function problemText(problem: unknown): string {
  const raw = problemDetail(problem);
  if (raw === "") return "";
  if (offlineProblem(problem)) return uiText("problemOffline");
  if (timeoutProblem(problem)) return uiText("problemTimeout");
  return readable(raw) ? raw : uiText("problemOther");
}

/** Whether `problemText` says something other than the raw text: Details then has the original. */
export function problemHasDetail(problem: unknown): boolean {
  const raw = problemDetail(problem);
  return (
    raw !== "" &&
    (offlineProblem(problem) || timeoutProblem(problem) || !readable(raw))
  );
}

/** Keep a failure's raw text where a developer looks for it (the console and dev log). */
export function logProblem(problem: unknown): void {
  const raw = problemDetail(problem);
  if (raw) console.warn("[eta]", raw);
}

/**
 * Only what adds to a reason already shown ("The run failed."): the host's own words, or the
 * connection or a timeout; nothing for a raw code, which goes to the console instead.
 */
export function problemReason(problem: unknown): string {
  if (!problemHasDetail(problem)) return problemText(problem);
  logProblem(problem);
  const raw = problemDetail(problem);
  return readable(raw) || offlineProblem(problem) || timeoutProblem(problem)
    ? problemText(problem)
    : "";
}
