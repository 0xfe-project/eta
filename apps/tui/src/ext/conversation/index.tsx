import type { Extension } from "../../extensions/types";
import { conversationCommands } from "./commands";
import { FollowConversationList } from "./follow-list";
import { CONVERSATION_VIEW } from "./kind";
import { conversationMessages } from "./messages";
import { useConversationStatus, useConversationTitle } from "./tab-label";
import { ConversationView } from "./view";

const extension: Extension = {
  id: "conversation",
  messages: conversationMessages,
  commands: conversationCommands,
  views: [
    {
      kind: CONVERSATION_VIEW,
      Component: ConversationView,
      useTitle: useConversationTitle,
      useStatus: useConversationStatus,
    },
  ],
  Background: FollowConversationList,
};

export default extension;
