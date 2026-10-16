import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/ui/button";
import { PageHeader } from "./app-shell";

const meta = {
  title: "布局/PageHeader",
  component: PageHeader,
} satisfies Meta<typeof PageHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Title: Story = {
  name: "标题",
  args: { title: "任务" },
};

export const WithAction: Story = {
  name: "带操作",
  args: { title: "任务", children: <Button size="sm">新建</Button> },
};
