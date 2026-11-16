/**
 * What `drive.ts` reads off the page's update button, apart from the run so a test can hold it:
 * apps/eta/test/upgrade-e2e.test.ts.
 */

/** `upgrade.check`, as any build since the button answers it. */
export interface Check {
  blocked: string | null;
  latest: string | null;
  /**
   * The pre-release switch. A build from before it has no such field; anything that is not a yes
   * or a no is read the same way, `null` included, rather than as a switch to turn on.
   */
  prerelease?: boolean | null;
}

/** Whether the build has the switch under Settings → Update at all. */
export const hasPrereleaseSwitch = (check: Check): boolean =>
  typeof check.prerelease === "boolean";
