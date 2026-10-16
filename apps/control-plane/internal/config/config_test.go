package config

import "testing"

func TestDefaultsFollowTheEnvironment(t *testing.T) {
	t.Setenv("AXP_SECRET_KEY", "k")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Dev || c.NATSURL != "nats://127.0.0.1:24222" || c.RuntimeImage != "axp-agent-runtime:production" || c.APIAddr != "127.0.0.1:24000" {
		t.Fatalf("production defaults: %+v", c)
	}
	if at, _ := c.AtAllocHost(c.NATSURL); at != "nats://172.26.64.1:24222" {
		t.Fatalf("at the bridge's gateway: %s", at)
	}
	t.Setenv("AXP_DEV", "true")
	t.Setenv("AXP_NATS_URL", "nats://elsewhere:4222")
	t.Setenv("AXP_SECRET_KEY", "k")
	if c, err = Load(); err != nil {
		t.Fatal(err)
	}
	if !c.Dev || c.NATSURL != "nats://elsewhere:4222" || c.RuntimeImage != "axp-agent-runtime:dev" || c.SecretKey != "k" {
		t.Fatalf("development defaults: %+v", c)
	}
}
