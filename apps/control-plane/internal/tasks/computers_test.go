package tasks

import (
	"github.com/akarachen/axp/apps/control-plane/internal/relay"
	"testing"
)

func TestRuntimeConnectionAndAvailability(t *testing.T) {
	device := "d"
	rt := &computerRuntimeRow{Kind: "paseo", DeviceID: &device}
	inst := relay.Instance{InstanceID: "paseo", Approved: true}
	state := &relay.State{Devices: []relay.Device{{ID: device, Online: true, Instances: []relay.Instance{inst}}}}
	got := runtimeState(rt, state, "")
	if got.State != "unavailable" || !got.ConnectorOnline {
		t.Fatalf("online connector without runtime: %+v", got)
	}
	state.Devices[0].Instances[0].Available = true
	if got := runtimeState(rt, state, ""); got.State != "online" {
		t.Fatalf("recovery: %+v", got)
	}
	state.Devices[0].Instances[0].Approved = false
	if got := runtimeState(rt, state, ""); got.State != "needs_approval" {
		t.Fatalf("approval: %+v", got)
	}
	state.Devices[0].Instances[0].Approved = true
	state.Devices[0].Online = false
	if got := runtimeState(rt, state, ""); got.State != "offline" || got.ConnectorOnline {
		t.Fatalf("offline: %+v", got)
	}
	if got := runtimeState(rt, nil, ""); got.State != "unknown" {
		t.Fatalf("relay failure must not imply offline: %+v", got)
	}
}
