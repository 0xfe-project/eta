import { host } from "../app/session";
import { httpUrl } from "../wire/native-socket";

/** The host hands out addresses relative to itself (`/preview/…`, `/share/…`). Absolute ones pass. */
export function hostUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return httpUrl(host()?.address ?? "", url);
}
