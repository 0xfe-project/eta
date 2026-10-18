/**
 * Scripts on a daemon's machine, as the SSH environment's transport.
 *
 * `SshEnvironment` is written against one thing: run a script on the far side and give back its
 * exit code and output. Over SSH that is a process; here it is a call over the link to the daemon,
 * which runs the script in its own shell. So a tool that reads files through an execution
 * environment (publishing an artifact) reads *the daemon's* files with no file protocol of its
 * own, and the environment's tests are the transport's tests.
 */
import type { SshResult, SshRunOptions, SshTransport } from "@eta/ssh";
import type { MachineLink } from "./hub";
import { Buffer } from "node:buffer";
import { LINK_LIMITS } from "@eta/client-contracts";
import { LinkError } from "@eta/daemon";

/** A script that sets no deadline of its own still gets one: the link bounds every call. */
const DEFAULT_SCRIPT_MS = 60_000;

export class LinkTransport implements SshTransport {
  readonly overSsh = false;
  readonly home: string;
  readonly #link: MachineLink;

  constructor(link: MachineLink, home: string) {
    this.#link = link;
    this.home = home;
  }

  async run(script: string, options: SshRunOptions = {}): Promise<SshResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SCRIPT_MS;
    const input =
      options.input === undefined
        ? undefined
        : Buffer.from(options.input).toString("base64");
    try {
      const result = await this.#link.daemon(
        "exec",
        {
          script,
          timeoutMs,
          ...(input === undefined ? {} : { inputBase64: input }),
        },
        {
          // The daemon enforces the script's own deadline; the call waits a little longer for
          // the answer to come back.
          timeoutMs: Math.min(timeoutMs + 5_000, LINK_LIMITS.runTimeoutMs),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      if (result.stdout !== "")
        options.onChunk?.({ stream: "stdout", chunk: result.stdout });
      if (result.stderr !== "")
        options.onChunk?.({ stream: "stderr", chunk: result.stderr });
      return result;
    } catch (error) {
      if (error instanceof LinkError && error.kind === "aborted") {
        // The cancel went to the daemon with the call, which stops the script over there.
        return { code: 143, stdout: "", stderr: "aborted", aborted: true };
      }
      if (error instanceof LinkError && error.kind === "timeout") {
        return { code: 124, stdout: "", stderr: "timeout", timedOut: true };
      }
      // A cut link or a refusal: the machine did not answer, which is a failure to run it.
      return {
        code: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close(): Promise<void> {
    // The link is the machine's, not this transport's.
  }
}
