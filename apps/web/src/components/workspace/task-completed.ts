import { toast } from "sonner";
import { useTaskNav } from "./task-nav";

/** Clear only the detail selection, including on a direct visit. The root
 * toaster outlives either detail layout; never navigate out of the app. */
export function useTaskCompleted() {
  const [, setNav] = useTaskNav();
  return (merged: boolean) => {
    void setNav({ task: null }, { history: "replace" });
    toast.success(merged ? "PR 已合并，任务已完成" : "任务已完成", {
      position: "bottom-right",
    });
  };
}
