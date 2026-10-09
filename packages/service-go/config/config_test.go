package config

import (
	"testing"
	"time"
)

type settings struct {
	Addr    string        `env:"TEST_ADDR" default:":8000"`
	NATS    string        `env:"TEST_NATS" dev:"nats://dev:4222" prod:"nats://prod:4222"`
	Key     string        `env:"TEST_KEY" dev:"dev-key"`
	Debug   bool          `env:"TEST_DEBUG"`
	Workers int           `env:"TEST_WORKERS" default:"2"`
	Every   time.Duration `env:"TEST_EVERY" default:"500ms"`
	Ignored string
}

func TestDefaultsFollowTheEnvironment(t *testing.T) {
	t.Setenv("AXP_DEV", "")
	c, err := Load[settings]()
	if err != nil {
		t.Fatal(err)
	}
	if c != (settings{Addr: ":8000", NATS: "nats://prod:4222", Workers: 2, Every: 500 * time.Millisecond}) {
		t.Fatalf("production: %+v", c)
	}
	t.Setenv("AXP_DEV", "true")
	t.Setenv("TEST_NATS", "nats://elsewhere:4222")
	t.Setenv("TEST_DEBUG", "true")
	if c, err = Load[settings](); err != nil {
		t.Fatal(err)
	}
	if c.NATS != "nats://elsewhere:4222" || c.Key != "dev-key" || !c.Debug || c.Addr != ":8000" {
		t.Fatalf("development with overrides: %+v", c)
	}
	t.Setenv("TEST_WORKERS", "many")
	if _, err := Load[settings](); err == nil {
		t.Fatal("a bad int was accepted")
	}
}
