// Ported from pi-mcp-adapter/host-managed.ts (MIT, see ../NOTICE): the `delivery` classification and the wording for a model.
/**
 * What a failed tool call tells the model about whether it ran.
 *
 * A call that failed after the request left may still have done its work, so the model is told not
 * to repeat it blindly. A call that never left (cancelled, connection already closed) is safe to
 * retry, and says so.
 */
import type { McpDelivery } from "./types";
import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/client";

/** The call failed with this delivery; the raw error stays as `cause`. */
export class DeliveryError extends Error {
  readonly delivery: McpDelivery;
  readonly protocolCode: number | undefined;

  constructor(
    delivery: McpDelivery,
    message: string,
    options: { cause?: unknown; protocolCode?: number } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "DeliveryError";
    this.delivery = delivery;
    this.protocolCode = options.protocolCode;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classifies an error thrown by `callTool`. Output-schema validation runs in this library, so a
 * `ProtocolError` here is a JSON-RPC error response from the server.
 */
export function classifyCallError(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error;
  if (error instanceof ProtocolError) {
    return new DeliveryError("server_error", error.message, {
      cause: error,
      protocolCode: error.code,
    });
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.InvalidResult) {
    return new DeliveryError("invalid_result", error.message, { cause: error });
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.NotConnected) {
    return new DeliveryError("not_sent", error.message, { cause: error });
  }
  return new DeliveryError("may_have_run", messageOf(error), { cause: error });
}

const UNKNOWN_OUTCOME = "Do not retry automatically; check its effects first.";

/** The sentence the model reads for a failed call. */
export function describeDelivery(
  error: DeliveryError,
  server: string,
  tool: string,
): string {
  const subject = `MCP tool "${tool}" on server "${server}"`;
  switch (error.delivery) {
    case "not_sent":
      return `${subject} was not run: the request was not sent (${error.message}). It is safe to retry.`;
    case "may_have_run":
      return `${subject} failed after the request was sent, so it may have run (${error.message}). ${UNKNOWN_OUTCOME}`;
    case "server_error": {
      const code =
        error.protocolCode === undefined
          ? ""
          : ` (JSON-RPC code ${error.protocolCode})`;
      return `MCP server "${server}" returned an error for tool "${tool}"${code}: ${error.message}`;
    }
    case "invalid_result":
      return `${subject} returned an invalid result, so it may have run (${error.message}). ${UNKNOWN_OUTCOME}`;
  }
}
