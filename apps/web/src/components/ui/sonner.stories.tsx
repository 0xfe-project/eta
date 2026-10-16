import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { toast } from "sonner";
import { Toaster } from "./sonner";

const meta = { title: "控件/Toaster", component: Toaster } satisfies Meta<
  typeof Toaster
>;
export default meta;
type Story = StoryObj<typeof meta>;

function Notice({
  kind,
  message,
}: {
  kind: "success" | "info" | "warning" | "error";
  message: string;
}) {
  useEffect(() => {
    toast[kind](message, { id: kind, duration: Infinity });
  }, [kind, message]);
  return <Toaster />;
}

export const Success: Story = {
  name: "成功",
  render: () => <Notice kind="success" message="已保存" />,
};
export const Info: Story = {
  name: "提示",
  render: () => <Notice kind="info" message="正在同步" />,
};
export const Warning: Story = {
  name: "警告",
  render: () => <Notice kind="warning" message="模型不可用" />,
};
export const ErrorNotice: Story = {
  name: "失败",
  render: () => <Notice kind="error" message="没有保存" />,
};
