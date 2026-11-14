import type { EmailThreadView } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { useEtaMailNotifications } from "./email-notifications";

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

/** The hook mounted over an email target that starts with `threads`; `set` is the next push. */
async function watch(threads: EmailThreadView[]) {
  const host = buildProductHost({}, ["email"]).target(
    "email",
    {
      accounts: [],
      threads,
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
  await flush();
  return async (next: EmailThreadView[]) => {
    host.set("email", {
      threads: next,
      stats: { unread: 1, pendingProposals: 0 },
    });
    await flush();
  };
}

/** The subjects of the mail a toast was raised for. */
const announced = () =>
  mocks.toast.mock.calls.map(
    (call) => (call[1] as { description: string }).description,
  );

describe("ETA mail notifications", () => {
  it("does not announce mail present on the first load", async () => {
    await watch([thread({ id: "m1" })]);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("announces only new ETA mail that arrived", async () => {
    const set = await watch([thread({ id: "existing", lastMessageAt: 1 })]);
    await set([
      thread({
        id: "existing",
        subject: "[eta-mp] Updated",
        incomingCount: 2,
        messageCount: 2,
        lastMessageAt: 2,
      }),
      thread({ id: "ordinary", subject: "Ordinary mail", lastMessageAt: 3 }),
    ]);
    expect(announced()).toEqual(["sender@example.com · [eta-mp] Updated"]);
  });

  it("ignores outgoing ETA activity", async () => {
    const set = await watch([thread({ id: "m1" })]);
    await set([
      thread({
        id: "m1",
        incomingCount: 1,
        outgoingCount: 1,
        messageCount: 2,
        lastMessageAt: 2,
        unread: false,
      }),
    ]);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("shows a toast when a new ETA mail arrives", async () => {
    const set = await watch([]);
    await set([thread({ id: "eta-1", subject: "[eta-mp] New mail" })]);
    expect(mocks.toast).toHaveBeenCalledWith(
      "收到新的 ETA 邮件",
      expect.objectContaining({
        description: "sender@example.com · [eta-mp] New mail",
      }),
    );
  });
});
