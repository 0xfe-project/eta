// Command ffi builds the gateway as a C shared library for the host's
// bun:ffi. Only three functions cross the boundary, all of them quick:
// LlmStart binds the loopback listener and returns, LlmStop ends it, LlmFree
// returns LlmStart's string. Model traffic and the account API go over that
// loopback listener, so a Go thread never calls back into the host.
//
// Build with `bun run --cwd packages/llm-gateway build`; the output extension
// is .so, .dylib, or .dll according to the platform.
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"os"
	"sync"
	"unsafe"

	"github.com/0xfe-project/eta/packages/llm-gateway/module"
)

type startConfig struct {
	StateDir  string         `json:"stateDir"`
	AccessKey string         `json:"accessKey"`
	CPAExtra  map[string]any `json:"cpaExtra,omitempty"`
}

var (
	mu      sync.Mutex
	cancel  context.CancelFunc
	stopped chan struct{}
)

func reply(v any) *C.char {
	raw, _ := json.Marshal(v)
	return C.CString(string(raw))
}

// LlmStart takes a JSON config and returns a JSON reply, {"port":n} or
// {"error":"..."}, in memory the caller frees with LlmFree. The gateway is
// serving on the port once the reply is read; /v1 answers 503 until the
// credentials are loaded.
//
//export LlmStart
func LlmStart(config *C.char) *C.char {
	mu.Lock()
	defer mu.Unlock()
	if cancel != nil {
		return reply(map[string]string{"error": "already started"})
	}
	var cfg startConfig
	if err := json.Unmarshal([]byte(C.GoString(config)), &cfg); err != nil {
		return reply(map[string]string{"error": "bad config: " + err.Error()})
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	m, err := module.Open(module.Options{StateDir: cfg.StateDir, AccessKey: cfg.AccessKey, CPAExtra: cfg.CPAExtra, Logger: logger})
	if err != nil {
		return reply(map[string]string{"error": err.Error()})
	}
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := m.Run(ctx); err != nil {
			logger.Error("LLM gateway stopped", "error", err)
		}
	}()
	cancel, stopped = stop, done
	return reply(map[string]int{"port": m.Addr().(*net.TCPAddr).Port})
}

// LlmStop stops the gateway and returns once its listener is closed.
//
//export LlmStop
func LlmStop() {
	mu.Lock()
	stop, done := cancel, stopped
	cancel, stopped = nil, nil
	mu.Unlock()
	if stop != nil {
		stop()
		<-done
	}
}

// LlmFree releases a string LlmStart returned.
//
//export LlmFree
func LlmFree(p *C.char) { C.free(unsafe.Pointer(p)) }

// main is required by the c-shared build and never runs.
func main() {}
