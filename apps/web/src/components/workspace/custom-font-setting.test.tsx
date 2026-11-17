import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { act } from "react";
import { customFontStack, watchCustomFont } from "@/lib/custom-font";
import { translate } from "@/lib/i18n";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { SettingsDialog } from "./settings-dialog";
import { useWorkspaceStore } from "./workspace-store";

// Settings → Appearance → Interface font: typed in, saved on leaving the field or Enter, refused
// with a reason when it is not one font name.

rstest.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useRouterState: (options?: { select?: (state: unknown) => unknown }) =>
    options?.select
      ? options.select({ location: { pathname: "/" } })
      : { location: { pathname: "/" } },
  useRouter: () => ({ navigate: () => undefined }),
  useNavigate: () => () => undefined,
  useLocation: (options?: { select?: (location: unknown) => unknown }) =>
    options?.select ? options.select({ pathname: "/" }) : { pathname: "/" },
}));

rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: undefined }),
  useOpenGroup: () => () => undefined,
}));

let stop: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ workspace: {} });
  stop = watchCustomFont();
});

afterEach(async () => {
  stop?.();
  useWorkspaceStore.setState({ workspace: {} });
  await cleanup();
  setWire(undefined);
  useWorkspaceStore.getState().setSettings({ open: false, section: "agents" });
});

async function open(section: "appearance" | "update") {
  const fake = buildProductHost({}, ["inbox"]).target(
    "inbox",
    { list: [], approvals: { tools: [] } },
    { eager: true },
  );
  fake.install();
  fake.hello();
  useWorkspaceStore.getState().setSettings({ open: true, section });
  await mount(
    <NuqsTestingAdapter>
      <SettingsDialog />
    </NuqsTestingAdapter>,
  );
  await flush();
}

function field() {
  const label = [...document.querySelectorAll("label")].find(
    (l) => l.textContent === translate("settings:appearance.customFont"),
  );
  const input = document.getElementById(label?.htmlFor ?? "");
  expect(input).toBeInstanceOf(HTMLInputElement);
  return input as HTMLInputElement;
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function leave(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

const sans = () =>
  document.documentElement.style.getPropertyValue("--font-sans");

describe("界面字体", () => {
  it("填了就用作界面字体，存到本地；清空回到默认", async () => {
    await open("appearance");
    const input = field();
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Eta Sans");

    await type(input, "  LXGW   WenKai ");
    await leave(input);
    expect(useWorkspaceStore.getState().workspace.customFont).toBe(
      "LXGW WenKai",
    );
    expect(input.value).toBe("LXGW WenKai");
    expect(sans()).toBe(customFontStack("LXGW WenKai"));
    expect(
      JSON.parse(localStorage.getItem("eta.workspace.v1") ?? "{}"),
    ).toMatchObject({ customFont: "LXGW WenKai" });

    await type(input, "");
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect("customFont" in useWorkspaceStore.getState().workspace).toBe(false);
    expect(sans()).toBe("");
  });

  it("非法输入不保存，说明原因", async () => {
    useWorkspaceStore.getState().setWorkspace({ customFont: "Inter" });
    await open("appearance");
    const input = field();
    expect(input.value).toBe("Inter");

    await type(input, "Inter; } body { background: url(x)");
    await leave(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      translate("settings:appearance.customFontInvalid"),
    );
    expect(useWorkspaceStore.getState().workspace.customFont).toBe("Inter");
    expect(sans()).toBe(customFontStack("Inter"));

    await type(input, "Inter Display");
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  it("更新页写出当前的自定义字体，没设就不写", async () => {
    await open("update");
    expect(
      document.querySelector('[data-testid="custom-font-note"]'),
    ).toBeNull();
    await act(async () =>
      useWorkspaceStore.getState().setWorkspace({ customFont: "Inter" }),
    );
    expect(
      document.querySelector('[data-testid="custom-font-note"]')?.textContent,
    ).toBe(translate("settings:update.customFont", { font: "Inter" }));
  });
});
