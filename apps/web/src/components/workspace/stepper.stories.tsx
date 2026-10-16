import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stepper } from "./stepper";

const meta = {
  title: "流程/Stepper",
  component: Stepper,
  args: {
    label: "连接",
    steps: ["账号", "仓库", "完成"],
  },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Stepper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const First: Story = { name: "第一步", args: { step: 0 } };
export const Middle: Story = { name: "进行中", args: { step: 1 } };
export const Complete: Story = {
  name: "完成",
  args: { step: 2, complete: true },
};
