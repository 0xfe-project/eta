package config

import "testing"

func TestDefaultsFollowTheEnvironment(t *testing.T) {
	t.Setenv("AXP_SECRET_KEY", "k")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Dev || c.NATSURL != "nats://nats.axp.svc.cluster.local:4222" || c.RuntimeImage != "10.43.100.1:5000/axp-agent-runtime:production" || c.APIAddr != ":8000" {
		t.Fatalf("production defaults: %+v", c)
	}
	t.Setenv("AXP_DEV", "true")
	t.Setenv("AXP_NATS_URL", "nats://elsewhere:4222")
	if c, err = Load(); err != nil {
		t.Fatal(err)
	}
	if !c.Dev || c.NATSURL != "nats://elsewhere:4222" || c.RuntimeImage != "10.43.100.11:5000/axp-agent-runtime:dev" || c.SecretKey != "k" {
		t.Fatalf("development defaults with an override: %+v", c)
	}
}
