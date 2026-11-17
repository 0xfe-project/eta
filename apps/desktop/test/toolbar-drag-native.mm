#import "../src/bun/platform/mac/toolbar-drag.h"

#import <WebKit/WebKit.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>

@interface ETADragTestWindow : NSWindow
@property(nonatomic, strong) NSEvent *receivedEvent;
@property(nonatomic) NSUInteger movableEnableCount;
@end

@implementation ETADragTestWindow
- (void)setMovable:(BOOL)movable {
  if (movable) self.movableEnableCount += 1;
  [super setMovable:movable];
}

- (void)sendEvent:(NSEvent *)event {
  self.receivedEvent = event;
}
@end

namespace {
int checks = 0;

void Check(bool condition, const char *message) {
  ++checks;
  if (!condition) {
    fprintf(stderr, "FAIL: %s\n", message);
    std::exit(1);
  }
}

struct Fixture {
  ETADragTestWindow *window;
  WKWebView *webView;

  Fixture(BOOL movable = YES, BOOL acceptsMouseMovedEvents = NO) {
    window = [[ETADragTestWindow alloc]
        initWithContentRect:NSMakeRect(100, 100, 640, 480)
                  styleMask:NSWindowStyleMaskTitled |
                            NSWindowStyleMaskClosable |
                            NSWindowStyleMaskMiniaturizable |
                            NSWindowStyleMaskResizable |
                            NSWindowStyleMaskFullSizeContentView
                    backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    NSView *container = [[NSView alloc] initWithFrame:NSMakeRect(41, 53, 550, 410)];
    [window.contentView addSubview:container];
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    webView = [[WKWebView alloc] initWithFrame:NSMakeRect(17, 29, 500, 350)
                               configuration:configuration];
    [container addSubview:webView];
    window.movable = movable;
    window.acceptsMouseMovedEvents = acceptsMouseMovedEvents;
    etaInstallToolbarDragGuard((__bridge void *)window);
    point(0.9, 0.8);
    bounds();
  }

  ~Fixture() {
    etaRemoveToolbarDragGuard((__bridge void *)window);
    [window close];
  }

  NSPoint screen(double x, double y) {
    NSRect viewport = webView.bounds;
    NSPoint local = NSMakePoint(
        NSMinX(viewport) + x * viewport.size.width,
        webView.isFlipped ? NSMinY(viewport) + y * viewport.size.height
                          : NSMaxY(viewport) - y * viewport.size.height);
    return [window convertPointToScreen:[webView convertPoint:local toView:nil]];
  }

  void point(double x, double y, NSUInteger buttons = 0,
             BOOL available = YES, BOOL targets = YES) {
    ETAToolbarDragTestSetPointer(window, {screen(x, y), buttons, available, targets});
  }

  void bounds(double x = 0.2, double y = 0.04, double width = 0.4,
              double height = 0.08) {
    etaSetToolbarDragBounds((__bridge void *)window, x, y, width, height);
  }

  void event(NSEventType type, double x, double y) {
    NSPoint location = [window convertPointFromScreen:screen(x, y)];
    NSEvent *event = [NSEvent mouseEventWithType:type location:location
                                 modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
                                  windowNumber:window.windowNumber context:nil
                                   eventNumber:1 clickCount:1 pressure:0];
    [NSApp postEvent:event atStart:YES];
    NSEventMask mask = static_cast<NSEventMask>(1) << type;
    NSEvent *queued = [NSApp nextEventMatchingMask:mask
                                       untilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]
                                          inMode:NSDefaultRunLoopMode dequeue:YES];
    Check(queued && queued.type == type && queued.eventNumber == 1,
          "the controlled NSEvent is dequeued from the application queue");
    window.receivedEvent = nil;
    [NSApp sendEvent:queued];
    Check(window.receivedEvent == queued, "the local monitor preserves event identity");
  }

  void notify(NSNotificationName name) {
    [[NSNotificationCenter defaultCenter] postNotificationName:name object:window];
  }
};

void TestHoverAndCoordinates() {
  Fixture f;
  Check(ETAToolbarDragTestIsPolling(f.window),
        "valid bounds poll for entry while the window is unguarded");
  Check(f.window.isMovable, "outside starts movable");
  Check(f.window.acceptsMouseMovedEvents, "install enables local mouse-move delivery");
  NSRect frame = f.window.frame;
  f.point(0.3, 0.06);
  Check(!f.window.isMovable, "hover prearms before a down event");
  Check(NSEqualRects(frame, f.window.frame), "prearming never changes the frame");
  Check((f.window.styleMask & NSWindowStyleMaskResizable) != 0,
        "prearming preserves the resizable style");
  Check([f.window standardWindowButton:NSWindowCloseButton].isEnabled,
        "prearming leaves the close button enabled");
  f.point(0.3, 0.03);
  Check(f.window.isMovable, "the top docking gap remains outside protection");
  f.point(0.199, 0.06);
  Check(f.window.isMovable, "a point left of the toolbar remains movable");
  f.bounds(0.25, 0.0625, 0.25, 0.0625);
  f.point(0.5, 0.09);
  Check(f.window.isMovable, "the right boundary is excluded");
  f.point(0.3, 0.125);
  Check(f.window.isMovable, "the bottom boundary is excluded");
  f.point(0.25, 0.0625);
  Check(!f.window.isMovable, "the top-left toolbar boundary is included");
  f.bounds();
  f.point(0.3, 0.06, 0, YES, NO);
  Check(f.window.isMovable, "an overlapping window prevents hover arming");
  f.point(0.3, 0.06, 0, NO);
  Check(f.window.isMovable, "unavailable windows do not prearm");
  f.point(0.3, 0.06);
  f.webView.hidden = YES;
  f.point(0.3, 0.06);
  Check(f.window.isMovable, "hidden web views do not supply hover bounds");
  f.webView.hidden = NO;
  f.point(0.3, 0.06);
  Check(!f.window.isMovable, "restoring the web view permits hover arming");
  f.point(0.9, 0.8);
  Check(f.window.isMovable, "pointer exit restores the original value");
  f.point(0.3, 0.06, 1);
  Check(f.window.isMovable, "a gesture beginning elsewhere cannot arm on entry");
  f.point(0.3, 0.06);
  Check(!f.window.isMovable, "button release permits prearming the next click");
  f.bounds(0.7, 0.5, 0.1, 0.1);
  Check(f.window.isMovable, "bounds updates immediately reconcile hover");
  f.bounds();
  Check(!f.window.isMovable, "bounds updates can prearm without mouse movement");
  etaInstallToolbarDragGuard((__bridge void *)f.window);
  f.point(0.9, 0.8);
  Check(f.window.isMovable, "repeated install does not overwrite the original value");
}

void TestOwnedGestureAndEvents() {
  Fixture f;
  f.point(0.3, 0.06);
  f.event(NSEventTypeLeftMouseDown, 0.3, 0.06);
  Check(!f.window.isMovable, "toolbar mouse-down owns the gesture");
  f.point(0.9, 0.8, 1);
  Check(!f.window.isMovable, "an owned gesture remains locked outside the toolbar");
  f.bounds(0.7, 0.5, 0.1, 0.1);
  Check(!f.window.isMovable, "valid geometry changes cannot release an owned hold");
  f.event(NSEventTypeLeftMouseDragged, 0.9, 0.8);
  Check(!f.window.isMovable, "drag delivery retains the lock");
  f.event(NSEventTypeLeftMouseUp, 0.9, 0.8);
  Check(f.window.isMovable, "a delivered mouse-up outside releases the lock");

  f.bounds();
  f.point(0.3, 0.06);
  f.event(NSEventTypeLeftMouseDown, 0.3, 0.06);
  f.point(0.3, 0.06, 1);
  NSUInteger enables = f.window.movableEnableCount;
  f.event(NSEventTypeLeftMouseUp, 0.3, 0.06);
  Check(!f.window.isMovable, "mouse-up inside remains prearmed for another click");
  Check(f.window.movableEnableCount == enables,
        "mouse-up inside never briefly enables server-side dragging");
  f.point(0.3, 0.06, 1);
  f.point(0.3, 0.06, 0);
  Check(!f.window.isMovable, "a polled mouse-up inside remains prearmed");
  Check(f.window.movableEnableCount == enables,
        "a polled mouse-up inside never briefly enables server-side dragging");
  f.point(0.3, 0.06, 0);
  f.event(NSEventTypeLeftMouseDown, 0.3, 0.06);
  f.point(0.9, 0.8, 1, YES, NO);
  Check(!f.window.isMovable, "out-of-window dragging remains owned");
  f.point(0.9, 0.8, 0, YES, NO);
  Check(f.window.isMovable, "polling recovers an up never delivered locally");

  f.point(0.9, 0.8);
  f.event(NSEventTypeMouseMoved, 0.3, 0.06);
  Check(!f.window.isMovable, "a delivered move uses its event location");
  f.point(0.3, 0.06, 1);
  f.point(0.9, 0.8, 1);
  Check(!f.window.isMovable, "polling captures a down missed by the monitor");
  f.point(0.9, 0.8);
  Check(f.window.isMovable, "polling releases a fully missed down-up sequence");
}

void TestClearBoundsAndBlur() {
  Fixture f;
  f.point(0.3, 0.06);
  f.event(NSEventTypeLeftMouseDown, 0.3, 0.06);
  f.point(0.3, 0.06, 1);
  f.bounds(0, 0, 0, 0);
  Check(!f.window.isMovable, "clearing geometry cannot unlock an owned hold");
  Check(ETAToolbarDragTestIsPolling(f.window),
        "release polling survives geometry clear during an owned hold");
  f.point(0.9, 0.8, 1, NO, NO);
  Check(!f.window.isMovable, "hiding after geometry clear retains the hold");
  f.point(0.9, 0.8, 0, NO, NO);
  Check(f.window.isMovable, "button release restores after geometry clear");
  Check(!ETAToolbarDragTestIsPolling(f.window),
        "release polling stops after invalidated geometry and release");

  f.bounds();
  f.point(0.3, 0.06);
  f.event(NSEventTypeLeftMouseDown, 0.3, 0.06);
  f.point(0.3, 0.06, 1);
  f.notify(NSWindowDidResignKeyNotification);
  Check(!f.window.isMovable, "focus loss cannot unlock an owned hold");
  f.point(0.3, 0.06, 1, NO, NO);
  Check(!f.window.isMovable, "unavailability cannot unlock a cancelled hold");
  f.point(0.3, 0.06, 0, NO, NO);
  Check(f.window.isMovable, "an observed button-up restores a blurred window");
  f.point(0.3, 0.06);
  Check(f.window.isMovable, "blur suppresses immediate rearming under a stationary pointer");
  f.point(0.9, 0.8);
  f.point(0.3, 0.06);
  Check(!f.window.isMovable, "a fresh entry prearms a non-key activation click");
  f.notify(NSWindowDidResignKeyNotification);
  Check(f.window.isMovable, "focus loss immediately releases hover without a hold");
  f.notify(NSWindowDidBecomeKeyNotification);
  Check(!f.window.isMovable, "activation reconciles hover");
  [[NSNotificationCenter defaultCenter]
      postNotificationName:NSApplicationDidResignActiveNotification object:NSApp];
  Check(f.window.isMovable, "application deactivation releases unowned hover");
  [[NSNotificationCenter defaultCenter]
      postNotificationName:NSApplicationDidBecomeActiveNotification object:NSApp];
  Check(!f.window.isMovable, "application activation reconciles hover");

  f.event(NSEventTypeLeftMouseDown, 0.3, 0.06);
  f.point(0.3, 0.06, 1);
  NSUInteger enables = f.window.movableEnableCount;
  f.notify(NSWindowDidResignKeyNotification);
  f.notify(NSWindowDidBecomeKeyNotification);
  Check(!f.window.isMovable, "focus restoration during a hold keeps protection");
  f.point(0.3, 0.06);
  Check(!f.window.isMovable, "release inside after focus restoration remains prearmed");
  Check(f.window.movableEnableCount == enables,
        "a focus round-trip never briefly enables dragging during an inside hold");
}

void TestUnavailableWindowPolling() {
  for (NSNotificationName notification in @[
         NSWindowDidDeminiaturizeNotification, NSApplicationDidUnhideNotification
       ]) {
    Fixture f;
    f.point(0.3, 0.06, 0, NO, NO);
    Check(!ETAToolbarDragTestIsPolling(f.window),
          "an unavailable window without an owned gesture stops polling");
    ETAToolbarDragTestSetPointer(f.window, {f.screen(0.3, 0.06), 0, YES, YES}, NO);
    [[NSNotificationCenter defaultCenter]
        postNotificationName:notification
                      object:[notification isEqualToString:NSApplicationDidUnhideNotification]
                                 ? static_cast<id>(NSApp) : f.window];
    Check(ETAToolbarDragTestIsPolling(f.window),
          "restoring window availability restarts polling without pointer movement");
    Check(!f.window.isMovable, "restoration prearms under a stationary toolbar pointer");
    f.event(NSEventTypeLeftMouseDown, 0.3, 0.06);
    f.point(0.3, 0.06, 1, NO, NO);
    Check(!f.window.isMovable, "unavailability preserves an owned gesture");
    Check(ETAToolbarDragTestIsPolling(f.window),
          "an unavailable window with an owned gesture keeps release polling");
    f.point(0.3, 0.06, 0, NO, NO);
    Check(f.window.isMovable, "release in an unavailable window restores movability");
    Check(!ETAToolbarDragTestIsPolling(f.window),
          "release stops polling in an unavailable window even with valid bounds");
  }
}

void TestBoundaryValidation() {
  Fixture f;
  f.point(0.3, 0.06);
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const double infinity = std::numeric_limits<double>::infinity();
  const double invalid[][4] = {
      {nan, 0, 0.2, 0.2}, {0, infinity, 0.2, 0.2},
      {0, 0, nan, 0.2}, {0, 0, 0.2, infinity},
      {-0.1, 0, 0.2, 0.2}, {0, -0.1, 0.2, 0.2},
      {0, 0, -1, 0.2}, {0, 0, 0.2, 0},
      {0.9, 0, 0.2, 0.2}, {0, 0.9, 0.2, 0.2},
      {2, 0, 0.2, 0.2}, {0, 2, 0.2, 0.2},
  };
  for (const auto &rect : invalid) {
    f.bounds();
    Check(!f.window.isMovable, "valid geometry prearms before a boundary check");
    f.bounds(rect[0], rect[1], rect[2], rect[3]);
    Check(f.window.isMovable, "invalid external geometry clears hover protection");
    Check(!ETAToolbarDragTestIsPolling(f.window),
          "invalid geometry stops polling without an owned hold");
  }
  f.bounds(0, 0, 1, 1);
  Check(!f.window.isMovable, "the complete normalized viewport is valid");
}

void TestRestorationAndIndependentWindows() {
  Fixture first;
  Fixture second(YES, YES);
  first.point(0.3, 0.06);
  Check(!first.window.isMovable && second.window.isMovable,
        "one window's hover does not affect another window");
  second.window.movable = NO;
  second.point(0.3, 0.06);
  second.point(0.9, 0.8);
  Check(!second.window.isMovable, "an original false movable value is preserved");
  Check(second.window.acceptsMouseMovedEvents,
        "an original true delivery flag remains true");
  first.point(0.3, 0.06, 1);
  etaRemoveToolbarDragGuard((__bridge void *)first.window);
  Check(first.window.isMovable, "explicit removal restores even an owned gesture");
  Check(!ETAToolbarDragTestIsInstalled(first.window), "removal clears associated state");
  Check(!first.window.acceptsMouseMovedEvents, "removal preserves the original false delivery flag");
  Check(ETAToolbarDragTestIsInstalled(second.window), "removal is isolated to one window");
  second.point(0.3, 0.06);
  etaRemoveToolbarDragGuard((__bridge void *)second.window);
  Check(!second.window.isMovable, "removal restores an original false movable value");
  Check(second.window.acceptsMouseMovedEvents, "removal preserves the original true delivery flag");
  etaRemoveToolbarDragGuard((__bridge void *)second.window);
  Check(!second.window.isMovable, "removal is idempotent");
  etaInstallToolbarDragGuard(nullptr);
  etaSetToolbarDragBounds(nullptr, 0, 0, 1, 1);
  etaRemoveToolbarDragGuard(nullptr);
}

void TestCloseAndTimerCleanup() {
  Fixture f;
  f.point(0.3, 0.06);
  f.event(NSEventTypeLeftMouseDown, 0.3, 0.06);
  f.point(0.3, 0.06, 1);
  [f.window close];
  Check(f.window.isMovable, "actual close releases an owned hold immediately");
  Check(!ETAToolbarDragTestIsInstalled(f.window), "actual close removes associated state");
  Check(!ETAToolbarDragTestIsPolling(f.window), "actual close removes the polling timer");
  f.notify(NSWindowDidBecomeKeyNotification);
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.025]];
  Check(f.window.isMovable, "removed notifications and timers cannot rearm a closed window");
}

void TestRunLoopPolling() {
  Fixture f;
  ETAToolbarDragTestSetPointer(f.window, {f.screen(0.3, 0.06), 0, YES, YES}, NO);
  Check(f.window.isMovable, "changing the hardware sample alone does not reconcile");
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.075]];
  Check(!f.window.isMovable, "the actual idle timer discovers entry without a move event");
  ETAToolbarDragTestSetPointer(f.window, {f.screen(0.9, 0.8), 1, YES, NO}, NO);
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.025]];
  f.bounds(0, 0, 0, 0);
  Check(!f.window.isMovable, "the actual guarded timer discovers an undelivered down");
  Check(ETAToolbarDragTestIsPolling(f.window), "a cleared owned hold keeps its release timer");
  ETAToolbarDragTestSetPointer(f.window, {f.screen(0.9, 0.8), 0, NO, NO}, NO);
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.025]];
  Check(f.window.isMovable, "the actual release timer discovers an undelivered up");
  Check(!ETAToolbarDragTestIsPolling(f.window), "the release timer stops after the cleared hold ends");
}
}

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    TestHoverAndCoordinates();
    TestOwnedGestureAndEvents();
    TestClearBoundsAndBlur();
    TestUnavailableWindowPolling();
    TestBoundaryValidation();
    TestRestorationAndIndependentWindows();
    TestCloseAndTimerCleanup();
    TestRunLoopPolling();
    printf("PASS: %d native toolbar drag checks. No windows shown; no system input sent.\n",
           checks);
  }
  return 0;
}
