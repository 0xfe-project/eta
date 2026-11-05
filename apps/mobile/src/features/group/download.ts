import { Sharing } from "eta/native";
import { host } from "../../app/session";

/** Fetch a file behind the token and offer it to the phone: only the runtime's Rust can write one. */
export function saveArchive(url: string, name: string): Promise<void> {
  const token = host()?.token ?? "";
  return Sharing.download(url, name, token === "" ? null : token);
}
