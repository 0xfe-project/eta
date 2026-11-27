import type { MessageView } from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import { cleanup, List, mount, signal, Text, View } from "nsh";
import { Button } from "../../src/components";
import {
  createQuoteSelection,
  QuoteSelectionOverlay,
} from "../../src/pages/chat/quote-selection";

const reply: MessageView = {
  id: "reply-1",
  conversationId: "conv-1",
  seq: 1,
  kind: "message",
  author: "agent",
  agentId: "Ada",
  text: "Quoted reply line",
  thinking: "",
  status: "done",
  revision: 1,
  mentions: [],
  rootMessageId: null,
  replyToId: null,
  data: {},
  createdAt: 0,
  updatedAt: 0,
};

const emptySelection = {
  text: "",
  start: 0,
  read: () => "",
};

const scrollItems = Array.from({ length: 24 }, (_, index) => ({
  id: `row-${index}`,
  label: `Row ${index}`,
}));

function QuoteOverlayFixture() {
  const quoted = signal("");
  const quoteCount = signal(0);
  let replyAnchor: ViewRef | undefined;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => {
    if (clearTimer !== undefined) clearTimeout(clearTimer);
  });

  const controller = createQuoteSelection({
    phone: () => false,
    onQuote: (_conversationId, text) => {
      quoted.set(text);
      quoteCount.update((count) => count + 1);
    },
  });
  cleanup(() => controller.dispose());

  function selectReply() {
    clearScheduled = false;
    controller.select(
      reply,
      {
        text: "Quoted reply line",
        start: 0,
        pageBounds: {
          origin: { x: 100, y: 200 },
          size: { width: 160, height: 24 },
        },
        read: () => "Quoted reply line",
      },
      replyAnchor,
    );
  }

  let clearScheduled = false;
  function scheduleAsyncClear() {
    if (!controller.current() || clearScheduled) return;
    clearScheduled = true;
    if (clearTimer !== undefined) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      clearTimer = undefined;
      clearScheduled = false;
      controller.select(reply, emptySelection, replyAnchor);
    }, 10);
  }

  const fixtureController = {
    ...controller,
    select(...args: Parameters<typeof controller.select>) {
      clearScheduled = false;
      controller.select(...args);
    },
    pressStart() {
      controller.pressStart();
      scheduleAsyncClear();
    },
  };

  return (
    <View
      style={{ flex: 1, padding: 16, gap: 12 }}
      // Simulates web Player.pointerDown clearing selection asynchronously whenever
      // a pointer goes down while text is selected.
      onTouchStartCapture={scheduleAsyncClear}
    >
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button label="Select reply" onPress={selectReply} />
        <View
          testID="outside-area"
          role="button"
          accessibilityLabel="Outside"
          onPress={() => {}}
          style={{ padding: 8 }}
        >
          <Text>Outside</Text>
        </View>
      </View>
      <View
        ref={(node) => {
          replyAnchor = node;
        }}
        style={{ padding: 12 }}
      >
        <Text>Quoted reply line</Text>
      </View>
      <List
        testID="timeline-list"
        style={{ height: 180 }}
        each={scrollItems}
        keyExtractor={(item) => item.id}
        onScroll={() => controller.dismiss()}
      >
        {(item) => (
          <View style={{ height: 36, justifyContent: "center" }}>
            <Text>{item().label}</Text>
          </View>
        )}
      </List>
      <Text>{`quoted:${quoted()}`}</Text>
      <Text>{`count:${quoteCount()}`}</Text>
      <QuoteSelectionOverlay controller={fixtureController} />
    </View>
  );
}

mount(QuoteOverlayFixture);
