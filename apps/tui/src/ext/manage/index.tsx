import type { Extension } from "../../extensions/types";
import { manageCommands } from "./commands";
import { FollowLists } from "./follow-lists";
import { manageMessages } from "./messages";

const extension: Extension = {
  id: "manage",
  messages: manageMessages,
  commands: manageCommands,
  Background: FollowLists,
};

export default extension;
