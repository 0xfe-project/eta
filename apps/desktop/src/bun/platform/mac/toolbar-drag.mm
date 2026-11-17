#import "toolbar-drag.h"

#import <WebKit/WebKit.h>
#import <objc/runtime.h>

#include <cmath>

namespace {
char kToolbarDragGuardKey;
constexpr NSTimeInterval kEntryPollInterval = 1.0 / 30.0;
constexpr NSTimeInterval kGuardedPollInterval = 1.0 / 120.0;

enum class DragPhase { Idle, Hover, Owned, OwnedCancelled, WaitForExit };

struct PointerSample {
  NSPoint screenPoint;
  NSUInteger buttons;
  BOOL windowAvailable;
  BOOL targetsWindow;
};

bool OwnsGesture(DragPhase phase) {
  return phase == DragPhase::Owned || phase == DragPhase::OwnedCancelled;
}

bool IsGuarded(DragPhase phase) {
  return phase == DragPhase::Hover || OwnsGesture(phase);
}

bool ValidBounds(double x, double y, double width, double height) {
  return std::isfinite(x) && std::isfinite(y) && std::isfinite(width) &&
         std::isfinite(height) && x >= 0 && y >= 0 && width > 0 &&
         height > 0 && x <= 1 && y <= 1 && width <= 1 - x &&
         height <= 1 - y;
}

WKWebView *FindWebView(NSView *view) {
  if ([view isKindOfClass:[WKWebView class]]) {
    return static_cast<WKWebView *>(view);
  }
  for (NSView *child in view.subviews) {
    WKWebView *found = FindWebView(child);
    if (found) return found;
  }
  return nil;
}

void OnMainWindow(void *pointer, void (^action)(NSWindow *)) {
  if (!pointer) return;
  NSWindow *window = (__bridge NSWindow *)pointer;
  if ([NSThread isMainThread]) {
    action(window);
  } else {
    // Retain the window until the queued operation has consumed the FFI pointer.
    dispatch_async(dispatch_get_main_queue(), ^{
      action(window);
    });
  }
}
}

@interface ETAToolbarDragGuard : NSObject {
  __weak NSWindow *_window;
  __weak WKWebView *_webView;
  NSRect _normalizedWebViewBounds;
  BOOL _hasBounds;
  BOOL _stopped;
  BOOL _originalMovable;
  BOOL _originalAcceptsMouseMovedEvents;
  DragPhase _phase;
  NSTimer *_timer;
  id _monitor;
  NSMutableArray *_notifications;
#if defined(ETA_TOOLBAR_DRAG_TESTING)
  BOOL _hasTestPointer;
  ETAToolbarDragTestPointer _testPointer;
#endif
}
- (instancetype)initWithWindow:(NSWindow *)window;
- (void)setBoundsX:(double)x y:(double)y width:(double)width height:(double)height;
- (void)refresh;
- (void)stop;
#if defined(ETA_TOOLBAR_DRAG_TESTING)
- (void)setTestPointer:(ETAToolbarDragTestPointer)pointer;
- (BOOL)isPolling;
#endif
@end

@implementation ETAToolbarDragGuard

- (instancetype)initWithWindow:(NSWindow *)window {
  self = [super init];
  if (!self) return nil;
  _window = window;
  _originalAcceptsMouseMovedEvents = window.acceptsMouseMovedEvents;
  window.acceptsMouseMovedEvents = YES;
  _phase = DragPhase::Idle;
  _notifications = [NSMutableArray array];
  __weak ETAToolbarDragGuard *weakSelf = self;
  _monitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:NSEventMaskMouseMoved |
                                           NSEventMaskLeftMouseDown |
                                           NSEventMaskLeftMouseDragged |
                                           NSEventMaskLeftMouseUp
      handler:^NSEvent *(NSEvent *event) {
        [weakSelf observeEvent:event];
        return event;
      }];

  NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
  for (NSNotificationName name in @[
         NSWindowDidResignKeyNotification, NSWindowWillMiniaturizeNotification
       ]) {
    [_notifications addObject:
        [center addObserverForName:name object:window queue:nil
                        usingBlock:^(NSNotification *) {
                          [weakSelf cancelHover];
                        }]];
  }
  for (NSNotificationName name in @[
         NSApplicationDidResignActiveNotification, NSApplicationDidHideNotification
       ]) {
    [_notifications addObject:
        [center addObserverForName:name object:NSApp queue:nil
                        usingBlock:^(NSNotification *) {
                          [weakSelf cancelHover];
                        }]];
  }
  for (NSNotificationName name in @[
         NSWindowDidBecomeKeyNotification, NSWindowDidDeminiaturizeNotification
       ]) {
    [_notifications addObject:
        [center addObserverForName:name object:window queue:nil
                        usingBlock:^(NSNotification *) {
                          [weakSelf resumeHover];
                        }]];
  }
  for (NSNotificationName name in @[
         NSApplicationDidBecomeActiveNotification, NSApplicationDidUnhideNotification
       ]) {
    [_notifications addObject:
        [center addObserverForName:name object:NSApp queue:nil
                        usingBlock:^(NSNotification *) {
                          [weakSelf resumeHover];
                        }]];
  }
  [_notifications addObject:
      [center addObserverForName:NSWindowDidChangeOcclusionStateNotification
                         object:window queue:nil
                     usingBlock:^(NSNotification *) {
                       [weakSelf refresh];
                     }]];
  [_notifications addObject:
      [center addObserverForName:NSWindowWillCloseNotification
                         object:window queue:nil
                     usingBlock:^(NSNotification *notification) {
                       [weakSelf stop];
                       objc_setAssociatedObject(notification.object,
                                                &kToolbarDragGuardKey, nil,
                                                OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                     }]];
  return self;
}

- (PointerSample)pointerSample {
#if defined(ETA_TOOLBAR_DRAG_TESTING)
  if (_hasTestPointer) {
    return {_testPointer.screenPoint, _testPointer.buttons,
            _testPointer.windowAvailable,
            _testPointer.windowAvailable &&
                [self targetsWindowAt:_testPointer.screenPoint]};
  }
#endif
  NSWindow *window = _window;
  NSPoint point = NSEvent.mouseLocation;
  BOOL available = window && window.isVisible && !window.isMiniaturized &&
                   !NSApp.isHidden;
  // A visible non-key (even inactive) window needs protection before activation.
  BOOL targets = available && [self targetsWindowAt:point];
  return {point, NSEvent.pressedMouseButtons, available, targets};
}

- (BOOL)targetsWindowAt:(NSPoint)point {
  if (![self containsScreenPoint:point]) return NO;
#if defined(ETA_TOOLBAR_DRAG_TESTING)
  if (_hasTestPointer) return _testPointer.windowIsTopmost;
#endif
  return [NSWindow windowNumberAtPoint:point belowWindowWithWindowNumber:0] ==
         _window.windowNumber;
}

- (BOOL)containsScreenPoint:(NSPoint)screenPoint {
  NSWindow *window = _window;
  if (!_hasBounds || !window || !std::isfinite(screenPoint.x) ||
      !std::isfinite(screenPoint.y)) {
    return NO;
  }
  WKWebView *webView = _webView;
  if (!webView || webView.window != window) {
    webView = FindWebView(window.contentView);
    _webView = webView;
  }
  if (!webView || webView.isHiddenOrHasHiddenAncestor) return NO;
  NSRect viewport = webView.bounds;
  if (!std::isfinite(viewport.size.width) ||
      !std::isfinite(viewport.size.height) ||
      viewport.size.width <= 0 || viewport.size.height <= 0) {
    return NO;
  }
  NSPoint point = [webView convertPoint:[window convertPointFromScreen:screenPoint]
                              fromView:nil];
  double x = (point.x - NSMinX(viewport)) / viewport.size.width;
  double y = (webView.isFlipped ? point.y - NSMinY(viewport)
                                : NSMaxY(viewport) - point.y) /
             viewport.size.height;
  return x >= NSMinX(_normalizedWebViewBounds) &&
         x < NSMaxX(_normalizedWebViewBounds) &&
         y >= NSMinY(_normalizedWebViewBounds) &&
         y < NSMaxY(_normalizedWebViewBounds);
}

- (void)transitionTo:(DragPhase)phase {
  NSWindow *window = _window;
  if (!IsGuarded(_phase) && IsGuarded(phase)) {
    _originalMovable = window.isMovable;
    window.movable = NO;
  } else if (IsGuarded(_phase) && !IsGuarded(phase)) {
    window.movable = _originalMovable;
  }
  _phase = phase;
}

- (void)updatePolling {
  BOOL needed = !_stopped &&
                (OwnsGesture(_phase) ||
                 (_hasBounds && [self pointerSample].windowAvailable));
  if (!needed) {
    [_timer invalidate];
    _timer = nil;
    return;
  }
  NSTimeInterval interval = IsGuarded(_phase) ? kGuardedPollInterval
                                             : kEntryPollInterval;
  if (_timer && _timer.timeInterval == interval) return;
  [_timer invalidate];
  // Local moves are the fast entry path. Slower idle polling also covers inactive
  // windows; faster guarded polling recovers exits and ups outside this process.
  // Entry and press before either source runs can still beat server pre-arming.
  __weak ETAToolbarDragGuard *weakSelf = self;
  _timer = [NSTimer timerWithTimeInterval:interval repeats:YES
                                  block:^(NSTimer *) {
                                    [weakSelf refresh];
                                  }];
  _timer.tolerance = 0.001;
  [[NSRunLoop mainRunLoop] addTimer:_timer forMode:NSRunLoopCommonModes];
}

- (void)reconcile:(PointerSample)sample {
  if (_stopped) return;
  BOOL inside = [self containsScreenPoint:sample.screenPoint];
  if (OwnsGesture(_phase)) {
    if (sample.buttons != 0) return;
    DragPhase releasedPhase = sample.windowAvailable &&
                              sample.targetsWindow && inside
                                  ? DragPhase::Hover : DragPhase::Idle;
    [self transitionTo:_phase == DragPhase::OwnedCancelled
                           ? DragPhase::WaitForExit : releasedPhase];
  }
  if (_phase == DragPhase::WaitForExit) {
    if (inside) {
      [self updatePolling];
      return;
    }
    [self transitionTo:DragPhase::Idle];
  }
  if (_phase == DragPhase::Hover && (sample.buttons & 1) != 0) {
    // The server may consume down before the local monitor sees it.
    [self transitionTo:DragPhase::Owned];
  } else if (!sample.windowAvailable) {
    [self transitionTo:DragPhase::Idle];
  } else if (sample.buttons == 0 && sample.targetsWindow && inside) {
    [self transitionTo:DragPhase::Hover];
  } else {
    [self transitionTo:DragPhase::Idle];
  }
  [self updatePolling];
}

- (void)refresh {
  [self reconcile:[self pointerSample]];
}

- (void)observeEvent:(NSEvent *)event {
  if (_stopped) return;
  NSWindow *window = _window;
  PointerSample sample = [self pointerSample];
  BOOL ownWindow = event.window == window;
  if (ownWindow) {
    sample.screenPoint = [window convertPointToScreen:event.locationInWindow];
    sample.targetsWindow = sample.windowAvailable &&
                           [self targetsWindowAt:sample.screenPoint];
  }
  if (event.type == NSEventTypeLeftMouseDown) {
    sample.buttons |= 1;
    if (ownWindow && sample.windowAvailable &&
        [self containsScreenPoint:sample.screenPoint]) {
      [self transitionTo:DragPhase::Owned];
      [self updatePolling];
      return;
    }
    if (!OwnsGesture(_phase)) [self transitionTo:DragPhase::Idle];
  } else if (event.type == NSEventTypeLeftMouseDragged) {
    sample.buttons |= 1;
  } else if (event.type == NSEventTypeLeftMouseUp) {
    sample.buttons &= ~static_cast<NSUInteger>(1);
  }
  [self reconcile:sample];
}

- (void)setBoundsX:(double)x y:(double)y width:(double)width height:(double)height {
  if (_stopped) return;
  _hasBounds = ValidBounds(x, y, width, height);
  _normalizedWebViewBounds =
      _hasBounds ? NSMakeRect(x, y, width, height) : NSZeroRect;
  [self refresh];
}

- (void)cancelHover {
  if (_stopped) return;
  BOOL heldWhileArmed = _phase == DragPhase::Hover &&
                       ([self pointerSample].buttons & 1) != 0;
  [self transitionTo:OwnsGesture(_phase) || heldWhileArmed
                         ? DragPhase::OwnedCancelled : DragPhase::WaitForExit];
  [self updatePolling];
}

- (void)resumeHover {
  if (_stopped) return;
  if (_phase == DragPhase::OwnedCancelled) [self transitionTo:DragPhase::Owned];
  if (_phase == DragPhase::WaitForExit) [self transitionTo:DragPhase::Idle];
  [self refresh];
}

- (void)stop {
  if (_stopped) return;
  [self transitionTo:DragPhase::Idle];
  _stopped = YES;
  [self updatePolling];
  _window.acceptsMouseMovedEvents = _originalAcceptsMouseMovedEvents;
  if (_monitor) [NSEvent removeMonitor:_monitor];
  _monitor = nil;
  for (id token in _notifications) {
    [[NSNotificationCenter defaultCenter] removeObserver:token];
  }
  [_notifications removeAllObjects];
}

- (void)dealloc {
  [_timer invalidate];
  if (_monitor) [NSEvent removeMonitor:_monitor];
  for (id token in _notifications) {
    [[NSNotificationCenter defaultCenter] removeObserver:token];
  }
}

#if defined(ETA_TOOLBAR_DRAG_TESTING)
- (void)setTestPointer:(ETAToolbarDragTestPointer)pointer {
  _testPointer = pointer;
  _hasTestPointer = YES;
}

- (BOOL)isPolling {
  return _timer.isValid;
}
#endif
@end

extern "C" void etaInstallToolbarDragGuard(void *pointer) {
  OnMainWindow(pointer, ^(NSWindow *window) {
    ETAToolbarDragGuard *guard =
        objc_getAssociatedObject(window, &kToolbarDragGuardKey);
    if (!guard) {
      guard = [[ETAToolbarDragGuard alloc] initWithWindow:window];
      objc_setAssociatedObject(window, &kToolbarDragGuardKey, guard,
                               OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    [guard refresh];
  });
}

extern "C" void etaSetToolbarDragBounds(void *pointer, double x, double y,
                                       double width, double height) {
  OnMainWindow(pointer, ^(NSWindow *window) {
    ETAToolbarDragGuard *guard =
        objc_getAssociatedObject(window, &kToolbarDragGuardKey);
    [guard setBoundsX:x y:y width:width height:height];
  });
}

extern "C" void etaRemoveToolbarDragGuard(void *pointer) {
  OnMainWindow(pointer, ^(NSWindow *window) {
    ETAToolbarDragGuard *guard =
        objc_getAssociatedObject(window, &kToolbarDragGuardKey);
    [guard stop];
    objc_setAssociatedObject(window, &kToolbarDragGuardKey, nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  });
}

#if defined(ETA_TOOLBAR_DRAG_TESTING)
void ETAToolbarDragTestSetPointer(NSWindow *window,
                                ETAToolbarDragTestPointer pointer, BOOL refresh) {
  ETAToolbarDragGuard *guard =
      objc_getAssociatedObject(window, &kToolbarDragGuardKey);
  [guard setTestPointer:pointer];
  if (refresh) [guard refresh];
}

BOOL ETAToolbarDragTestIsInstalled(NSWindow *window) {
  return objc_getAssociatedObject(window, &kToolbarDragGuardKey) != nil;
}

BOOL ETAToolbarDragTestIsPolling(NSWindow *window) {
  ETAToolbarDragGuard *guard =
      objc_getAssociatedObject(window, &kToolbarDragGuardKey);
  return guard.isPolling;
}
#endif
