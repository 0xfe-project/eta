import { afterEach, expect, it } from "@rstest/core";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.render(null));
});

function Editors({ preventRestore = false }: { preventRestore?: boolean }) {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        设置
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          onCloseAutoFocus={
            preventRestore ? (event) => event.preventDefault() : undefined
          }
        >
          <DialogTitle>设置</DialogTitle>
          <button type="button" onClick={() => setNested(true)}>
            新建智能体
          </button>
          <Dialog open={nested} onOpenChange={setNested}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>新建智能体</DialogTitle>
              <input aria-label="名称" />
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>
    </>
  );
}

async function open(button: HTMLButtonElement) {
  await act(async () => {
    button.focus();
    button.click();
  });
}
async function escape() {
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  // Radix restores focus after its unmount cleanup.
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
}

it("returns to each actual opener when triggerless nested dialogs close", async () => {
  await act(async () => root.render(<Editors />));
  const settings = container.querySelector("button")!;
  await open(settings);
  const create = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((button) => button.textContent === "新建智能体")!;
  await open(create);
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  await escape();
  expect(document.activeElement).toBe(create);
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await escape();
  expect(document.activeElement).toBe(settings);
});

it("preserves caller-controlled focus restoration", async () => {
  await act(async () => root.render(<Editors preventRestore />));
  const settings = container.querySelector("button")!;
  await open(settings);
  await escape();
  expect(document.activeElement).not.toBe(settings);
});

it("keeps ordinary Radix triggers working", async () => {
  await act(async () =>
    root.render(
      <Dialog>
        <DialogTrigger>打开</DialogTrigger>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>测试</DialogTitle>
          <input aria-label="名称" />
        </DialogContent>
      </Dialog>,
    ),
  );
  const trigger = container.querySelector("button")!;
  await open(trigger);
  await escape();
  expect(document.activeElement).toBe(trigger);
});
