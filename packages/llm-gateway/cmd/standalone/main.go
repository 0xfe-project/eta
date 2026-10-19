// Command standalone runs the gateway as its own process, for when it should
// not live inside the host (the same code the c-shared library carries).
//
//	ETA_LLM_ACCESS_KEY=... ETA_LLM_STATE_DIR=./state ETA_LLM_ADDR=127.0.0.1:0 standalone
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/0xfe-project/eta/packages/llm-gateway/module"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	m, err := module.Open(module.Options{
		StateDir:  os.Getenv("ETA_LLM_STATE_DIR"),
		AccessKey: os.Getenv("ETA_LLM_ACCESS_KEY"),
		Addr:      os.Getenv("ETA_LLM_ADDR"),
		Logger:    logger,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "llm-gateway:", err)
		os.Exit(1)
	}
	fmt.Println(m.Addr().String())
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := m.Run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "llm-gateway:", err)
		os.Exit(1)
	}
}
