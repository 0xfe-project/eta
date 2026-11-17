#pragma once

#ifdef __cplusplus
extern "C" {
#endif

void etaInstallToolbarDragGuard(void *window);
void etaSetToolbarDragBounds(void *window, double x, double y, double width,
                             double height);
void etaRemoveToolbarDragGuard(void *window);

#ifdef __cplusplus
}
#endif

#if defined(ETA_TOOLBAR_DRAG_TESTING) && defined(__OBJC__)
#import <AppKit/AppKit.h>

struct ETAToolbarDragTestPointer {
  NSPoint screenPoint;
  NSUInteger buttons;
  BOOL windowAvailable;
  BOOL windowIsTopmost;
};
void ETAToolbarDragTestSetPointer(NSWindow *window,
                                ETAToolbarDragTestPointer pointer,
                                BOOL refresh = YES);
BOOL ETAToolbarDragTestIsInstalled(NSWindow *window);
BOOL ETAToolbarDragTestIsPolling(NSWindow *window);
#endif
