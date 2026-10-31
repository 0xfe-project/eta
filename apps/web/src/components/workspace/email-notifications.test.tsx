import type { EmailThreadView } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import {
  newEtaMailThreads,
  useEtaMailNotifications,
} from "./email-notifications";

const mocks = rstest.hoisted(() => ({
  navigate: rstest.fn(),
  toast: rstest.fn(),
}));

rstest.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

rstest.mock("sonner", () => ({ toast: mocks.toast }));

const thread = (
  fields: Partial<EmailThreadView> & Pick<EmailThreadView, "id">,
): EmailThreadView => ({
  accountId: "mail-1",
  peer: "sender@example.com",
  subject: "[eta-mp] Test",
  status: "new",
  unread: true,
  messageCount: 1,
  incomingCount: 1,
  outgoingCount: 0,
  lastMessageAt: 1,
  lastMessage: "Test",
  rootMessageId: null,
  latestMessageId: null,
  ...fields,
});

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  mocks.navigate.mockClear();
  mocks.toast.mockClear();
});

describe("ETA mail notifications", () => {
  it("does not announce mail present on the first load", () => {
    expect(newEtaMailThreads(new Map(), [thread({ id: "m1" })], false)).toEqual(
      [],
    );
  });

  it("announces only new ETA mail that arrived", () => {
    const previous = new Map([
      [
        "existing",
        { lastMessageAt: 1, incomingCount: 1 as number | undefined },
      ],
    ]);
    const updated = thread({
      id: "existing",
      incomingCount: 2,
      messageCount: 2,
      lastMessageAt: 2,
    });
    const ordinary = thread({
      id: "ordinary",
      subject: "Ordinary mail",
      lastMessageAt: 3,
    });
    expect(
      newEtaMailThreads(previous, [updated, ordinary], true).map(
        (item) => item.id,
      ),
    ).toEqual(["existing"]);
  });

  it("ignores outgoing ETA activity", () => {
    const previous = new Map([
      ["m1", { lastMessageAt: 1, incomingCount: 1 as number | undefined }],
    ]);
    const sent = thread({
      id: "m1",
      incomingCount: 1,
      outgoingCount: 1,
      messageCount: 2,
      lastMessageAt: 2,
      unread: false,
    });
    expect(newEtaMailThreads(previous, [sent], true)).toEqual([]);
  });

  it("shows a toast when a new ETA mail arrives", async () => {
    const host = buildProductHost({}, ["email"]).target(
      "email",
      {
        accounts: [],
        threads: [],
        proposals: [],
        stats: { unread: 0, pendingProposals: 0 },
      },
      { eager: true },
    );
    host.install();
    host.hello();
    const Probe = () => {
      useEtaMailNotifications();
      return null;
    };
    await mount(<Probe />);

    host.set("email", {
      threads: [thread({ id: "eta-1", subject: "[eta-mp] New mail" })],
      stats: { unread: 1, pendingProposals: 0 },
    });
    await flush();

    expect(mocks.toast).toHaveBeenCalledWith(
      "收到新的 ETA 邮件",
      expect.objectContaining({
        description: "sender@example.com · [eta-mp] New mail",
      }),
    );
  });
});
