import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

const meta = { title: "控件/Tooltip", component: Tooltip } satisfies Meta<
  typeof Tooltip
>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  name: "打开",
  render: () => (
    <Tooltip open>
      <TooltipTrigger asChild>
        <Button variant="outline">悬停</Button>
      </TooltipTrigger>
      <TooltipContent>刷新</TooltipContent>
    </Tooltip>
  ),
};
