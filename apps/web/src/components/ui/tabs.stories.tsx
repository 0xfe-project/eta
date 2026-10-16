import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

const meta = { title: "控件/Tabs", component: Tabs } satisfies Meta<
  typeof Tabs
>;
export default meta;
type Story = StoryObj<typeof meta>;

function Pair({
  variant = "default",
  orientation = "horizontal",
}: {
  variant?: "default" | "line";
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <Tabs defaultValue="open" orientation={orientation}>
      <TabsList variant={variant}>
        <TabsTrigger value="open">进行中</TabsTrigger>
        <TabsTrigger value="done">完成</TabsTrigger>
      </TabsList>
      <TabsContent value="open">进行中的内容</TabsContent>
    </Tabs>
  );
}

export const Default: Story = { name: "默认", render: () => <Pair /> };
export const Line: Story = {
  name: "线条",
  render: () => <Pair variant="line" />,
};
export const Vertical: Story = {
  name: "纵向",
  render: () => <Pair orientation="vertical" />,
};
