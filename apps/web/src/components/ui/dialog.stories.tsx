import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";

const meta = { title: "控件/Dialog", component: Dialog } satisfies Meta<
  typeof Dialog
>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  name: "打开",
  render: () => (
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建智能体</DialogTitle>
          <DialogDescription>给它一个名字，然后开始。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline">取消</Button>
          <Button>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};
