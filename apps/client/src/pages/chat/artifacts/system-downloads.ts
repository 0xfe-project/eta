import { Directories } from "nsh-directories";

/**
 * The platform's Downloads directory, when it names one.
 * HarmonyOS packaging replaces this file: that target has no `nsh-directories` build.
 */
export async function namedDownloadDir(): Promise<string | null | undefined> {
  try {
    if (await Directories.available())
      return (await Directories.userDirs())?.downloadDir;
  } catch {
    // Not granted or not readable.
  }
  return undefined;
}
