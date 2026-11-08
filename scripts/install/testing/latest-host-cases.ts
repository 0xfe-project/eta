/**
 * Which release an install without a version takes, as cases both install scripts run: the rule
 * is `Releases.latest()` in `packages/releases/src/releases.ts`, and each case says which part of
 * it decides.
 *
 * Every release body the fake server writes carries `"tag_name":"v9.9.9"` as text, so a script
 * that finds tags by searching the text takes a release that does not exist.
 */

export interface ListedTag {
  tag: string;
  draft?: boolean;
  /** What the release says it is; a tag with a `-` in it when not given. */
  prerelease?: boolean;
  /** The release notes; the fake server's text shaped like a parser's fields when not given. */
  notes?: string;
}

export interface LatestHostCase {
  name: string;
  /** The tag `releases/latest` answers with; none means 404. */
  latest?: string;
  /** The releases on the server, in the order the list gives them. */
  releases: ListedTag[];
  /** The tag whose files are installed, or `null` when the install fails for want of one. */
  installs: string | null;
  /** Whether the list (`releases?per_page=100`) is asked for. */
  listed: boolean;
  /** What in `latest()` makes this the answer. */
  why: string;
}

const DESKTOP = "desktop-v0.5.0";

export const LATEST_HOST_CASES: LatestHostCase[] = [
  {
    name: "the latest release is a host's",
    latest: "v0.3.0",
    releases: [{ tag: "v0.3.0" }, { tag: "v0.2.0" }],
    installs: "v0.3.0",
    listed: false,
    why: "a latest release with a host tag that is not a draft is the answer, without the list",
  },
  {
    name: "the latest release is a host's pre-release",
    latest: "v0.4.0-rc.1",
    releases: [{ tag: "v0.4.0-rc.1" }, { tag: "v0.3.0" }],
    installs: "v0.4.0-rc.1",
    listed: false,
    why: "HOST_TAG allows a suffix, and the latest release is checked for its tag and draft only",
  },
  {
    name: "the latest release is the desktop app's",
    latest: DESKTOP,
    releases: [{ tag: DESKTOP }, { tag: "v0.3.0" }, { tag: "v0.2.0" }],
    installs: "v0.3.0",
    listed: true,
    why: "a latest release whose tag is not a host's sends it to the list, where v0.3.0 is the highest",
  },
  {
    name: "there is no latest release",
    releases: [{ tag: "v0.3.0" }],
    installs: "v0.3.0",
    listed: true,
    why: "a 404 for the latest release sends it to the list",
  },
  {
    name: "the latest release is a draft",
    latest: "v0.9.0",
    releases: [{ tag: "v0.9.0", draft: true }, { tag: "v0.3.0" }],
    installs: "v0.3.0",
    listed: true,
    why: "a latest release that is a draft sends it to the list, which leaves drafts out",
  },
  {
    name: "v0.10.0 is newer than v0.9.9, listed after it",
    latest: DESKTOP,
    releases: [{ tag: DESKTOP }, { tag: "v0.9.9" }, { tag: "v0.10.0" }],
    installs: "v0.10.0",
    listed: true,
    why: "versions are ordered by number, part by part, not by their text or their place in the list",
  },
  {
    name: "v1.2.10 is newer than v1.2.9, listed before it",
    latest: DESKTOP,
    releases: [{ tag: DESKTOP }, { tag: "v1.2.10" }, { tag: "v1.2.9" }],
    installs: "v1.2.10",
    listed: true,
    why: "versions are ordered by number, part by part, not by their text or their place in the list",
  },
  {
    name: "a higher draft is passed over",
    latest: DESKTOP,
    releases: [
      { tag: DESKTOP },
      { tag: "v0.9.0", draft: true },
      { tag: "v0.3.0" },
    ],
    installs: "v0.3.0",
    listed: true,
    why: "isHostRelease leaves out a draft",
  },
  {
    name: "a higher pre-release is passed over",
    latest: DESKTOP,
    releases: [
      { tag: DESKTOP },
      { tag: "v0.4.0", prerelease: true },
      { tag: "v0.3.0" },
    ],
    installs: "v0.3.0",
    listed: true,
    why: "isHostRelease leaves out a release marked as a pre-release",
  },
  {
    name: "a higher tag with a suffix is passed over though it is not marked as a pre-release",
    latest: DESKTOP,
    releases: [
      { tag: DESKTOP },
      { tag: "v0.4.0-rc.1", prerelease: false },
      { tag: "v0.3.0" },
    ],
    installs: "v0.3.0",
    listed: true,
    why: "isHostRelease leaves out a tag with a `-` in it, whatever the release says",
  },
  {
    name: "tags that are not a host's are passed over",
    latest: DESKTOP,
    releases: [
      { tag: DESKTOP },
      { tag: "v2.0" },
      { tag: "v1.0.0.1" },
      { tag: "release-1.0.0" },
      { tag: "v0.3.0" },
    ],
    installs: "v0.3.0",
    listed: true,
    why: "HOST_TAG is v, then three numbers, then an optional suffix, and nothing else",
  },
  {
    name: "a tag that starts with a capital V is a host's",
    latest: DESKTOP,
    releases: [{ tag: DESKTOP }, { tag: "v0.3.0" }, { tag: "V0.4.0" }],
    installs: "V0.4.0",
    listed: true,
    why: "HOST_TAG ignores case, and the version is the tag without its first character",
  },
  {
    name: "notes that end with a backslash do not hide the releases after them",
    latest: DESKTOP,
    releases: [
      { tag: DESKTOP },
      { tag: "v0.2.0", notes: "C:\\" },
      { tag: "v0.3.0" },
    ],
    installs: "v0.3.0",
    listed: true,
    why: "a backslash that is escaped does not escape the quote after it, so the string ends there",
  },
  {
    name: "only pre-releases and the desktop app's: no host release",
    latest: DESKTOP,
    releases: [{ tag: DESKTOP }, { tag: "v0.4.0-rc.1", prerelease: true }],
    installs: null,
    listed: true,
    why: "with no release in the list that isHostRelease takes, latest() fails: has no host release (a v* tag)",
  },
  {
    name: "only the desktop app's, with a host tag in the release notes: no host release",
    latest: DESKTOP,
    releases: [{ tag: DESKTOP }],
    installs: null,
    listed: true,
    why: "the list has no host release; the v9.9.9 in the notes is text, not a release",
  },
];
