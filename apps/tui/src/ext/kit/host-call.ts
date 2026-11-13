import { useRef, useState } from "react";
import { useLocale } from "../../i18n/react";
import { callErrorText } from "./errors";

export interface HostCall {
  /** A call is running; for drawing. */
  busy: boolean;
  /** Why the last call failed, in the user's language; or what the caller set. */
  error: string | undefined;
  setError: (error: string | undefined) => void;
  /**
   * Starts `task` unless a call is already running, also one started by an earlier key of the same
   * read. Clears the error; on failure sets it from `callErrorText`. Returns whether it started.
   */
  run: <T>(task: () => Promise<T>, onDone?: (value: T) => void) => boolean;
}

/** One call to the host at a time from a layer, with its busy mark and its failure. */
export function useHostCall(): HostCall {
  const locale = useLocale();
  // Keys read together are handled before a re-render, so the state alone cannot stop a second one.
  const runningRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const finish = () => {
    runningRef.current = false;
    setBusy(false);
  };

  const run = <T>(task: () => Promise<T>, onDone?: (value: T) => void) => {
    if (runningRef.current) return false;
    runningRef.current = true;
    setBusy(true);
    setError(undefined);
    let answer: Promise<T>;
    try {
      answer = task();
    } catch (failure) {
      answer = Promise.reject(failure);
    }
    answer.then(
      (value) => {
        finish();
        onDone?.(value);
      },
      (failure: unknown) => {
        finish();
        setError(callErrorText(failure, locale));
      },
    );
    return true;
  };

  return { busy, error, setError, run };
}
