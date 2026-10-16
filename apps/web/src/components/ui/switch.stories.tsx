import type { Meta, StoryObj } from "@storybook/react-vite";
import { Switch } from "./switch";

const meta = {
  title: "控件/Switch",
  component: Switch,
  args: { "aria-label": "开启" },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = { name: "关" };
export const On: Story = { name: "开", args: { defaultChecked: true } };
export const Disabled: Story = { name: "不可用", args: { disabled: true } };
