/**
 * Printing an artifact from the app's dialog.
 *
 * The dialog shows a version in a sandboxed frame with an opaque origin, so the app cannot call
 * the frame's `print()` itself. Instead every HTML page under `/preview/` ends with this listener:
 * when the frame's parent posts exactly `{ type: "eta:print" }`, the page prints itself, as it is
 * now (after whatever the user did in it), and the browser's dialog offers "Save as PDF". The
 * sandbox already allows it (`allow-modals`).
 *
 * The listener does nothing else: it answers no one, reads nothing and sends nothing, and it
 * ignores every other message and every other sender, so the page's own messages and listeners are
 * untouched. It is appended at the very end of the bytes, after the page's own markup, which
 * leaves the page's encoding, `<base>`, scripts and routing as they were (the HTML parser puts a
 * trailing script into `<body>`). A page whose own CSP forbids inline scripts keeps it out, and
 * then the button does nothing.
 */

export const PRINT_MESSAGE = "eta:print";

export const PRINT_LISTENER = `<script>addEventListener("message",function(e){var d=e.data;if(e.source===parent&&parent!==window&&d!==null&&typeof d==="object"&&d.type===${JSON.stringify(PRINT_MESSAGE)})print()})</script>`;

const LISTENER_BYTES = new TextEncoder().encode(PRINT_LISTENER);

const isHtml = (response: Response): boolean =>
  /^text\/html\b/i.test(response.headers.get("content-type") ?? "");

/** A page with the listener at its end; anything that is not a page, unchanged. */
export async function withPrintListener(response: Response): Promise<Response> {
  if (!response.ok || !isHtml(response)) return response;
  const page = new Uint8Array(await response.arrayBuffer());
  const body = new Uint8Array(page.length + LISTENER_BYTES.length);
  body.set(page);
  body.set(LISTENER_BYTES, page.length);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, headers });
}
