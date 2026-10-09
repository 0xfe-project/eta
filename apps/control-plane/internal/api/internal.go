package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/control"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/danielgtaylor/huma/v2"
)

// The internal runtime protocol, runtime -> control plane. Runtimes
// authenticate with their instance's token (Authorization: Bearer); fields
// a newer runtime sends that this does not know are ignored.

type Bearer struct {
	Authorization string `header:"Authorization" doc:"Bearer <the runtime's token>"`
}

func (b Bearer) token() string {
	token, _ := strings.CutPrefix(b.Authorization, "Bearer ")
	return token
}

type InstancePath struct {
	Bearer
	InstanceID string `path:"instance_id"`
}

type HeartbeatIn struct {
	_                struct{} `additionalProperties:"true"`
	Status           string   `json:"status"`
	ErrorCode        *string  `json:"error_code,omitempty" nullable:"true"`
	CurrentCommandID *string  `json:"current_command_id,omitempty" nullable:"true"`
	ThreadID         *string  `json:"thread_id,omitempty" nullable:"true"`
	ConfigVersion    int64    `json:"config_version,omitempty"`
	ProtocolVersion  *string  `json:"protocol_version,omitempty" nullable:"true"`
	SDKVersion       *string  `json:"sdk_version,omitempty" nullable:"true"`
	RuntimeVersion   *string  `json:"runtime_version,omitempty" nullable:"true"`
}

type SessionIn struct {
	_              struct{} `additionalProperties:"true"`
	ThreadID       string   `json:"thread_id" minLength:"1" maxLength:"100"`
	Resumed        bool     `json:"resumed,omitempty"`
	SDKVersion     *string  `json:"sdk_version,omitempty" nullable:"true"`
	RuntimeVersion *string  `json:"runtime_version,omitempty" nullable:"true"`
}

type EventIn struct {
	_             struct{}       `additionalProperties:"true"`
	SourceSeq     int64          `json:"source_seq"`
	SourceEventID string         `json:"source_event_id" maxLength:"100"`
	Type          string         `json:"type" maxLength:"64"`
	Payload       map[string]any `json:"payload"`
}

type EventsIn struct {
	_      struct{}  `additionalProperties:"true"`
	Events []EventIn `json:"events" maxItems:"100"`
}

type Acked struct {
	AckedSourceSeq int64 `json:"acked_source_seq"`
}

type ThreadOut struct {
	ThreadID string `json:"thread_id"`
}

type UploadOut struct {
	UploadURL string `json:"upload_url"`
}

func internalOp(id, method, path, summary string, status int, tag string) huma.Operation {
	return huma.Operation{
		OperationID: id, Method: method, Path: path, Summary: summary,
		DefaultStatus: status, Tags: []string{tag}, Errors: []int{400, 403, 404, 409, 422},
	}
}

func registerInternal(api huma.API, d *Deps) {
	p := d.Protocol
	instance := func(ctx context.Context, in InstancePath) (*chat.RuntimeRecord, error) {
		return p.Authenticate(ctx, in.InstanceID, in.token())
	}

	huma.Register(api, internalOp("heartbeat", http.MethodPost, "/internal/v1/runtime-instances/{instance_id}/heartbeat",
		"Report the runtime's status and extend its lease", 200, "runtime instances"),
		func(ctx context.Context, in *struct {
			InstancePath
			Body HeartbeatIn
		}) (*httpapi.Body[control.Lease], error) {
			runtime, err := instance(ctx, in.InstancePath)
			if err != nil {
				return nil, err
			}
			lease, err := p.Heartbeat(ctx, runtime, control.Heartbeat{Status: in.Body.Status, ErrorCode: in.Body.ErrorCode})
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[control.Lease]{Body: *lease}, nil
		})

	huma.Register(api, internalOp("registerSession", http.MethodPut, "/internal/v1/runtime-instances/{instance_id}/session",
		"Record the agent's Codex thread", 200, "runtime instances"),
		func(ctx context.Context, in *struct {
			InstancePath
			Body SessionIn
		}) (*httpapi.Body[ThreadOut], error) {
			runtime, err := instance(ctx, in.InstancePath)
			if err != nil {
				return nil, err
			}
			err = p.RegisterSession(ctx, runtime, control.Session{
				ThreadID: in.Body.ThreadID, Resumed: in.Body.Resumed,
				SDKVersion: in.Body.SDKVersion, RuntimeVersion: in.Body.RuntimeVersion,
			})
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[ThreadOut]{Body: ThreadOut{in.Body.ThreadID}}, nil
		})

	huma.Register(api, internalOp("postEvents", http.MethodPost, "/internal/v1/runtime-instances/{instance_id}/events",
		"Deliver the runtime's outbox events, in order", 200, "runtime instances"),
		func(ctx context.Context, in *struct {
			InstancePath
			Body EventsIn
		}) (*httpapi.Body[Acked], error) {
			runtime, err := instance(ctx, in.InstancePath)
			if err != nil {
				return nil, err
			}
			events := make([]chat.RuntimeEvent, len(in.Body.Events))
			for i, e := range in.Body.Events {
				events[i] = chat.RuntimeEvent{SourceSeq: e.SourceSeq, SourceEventID: e.SourceEventID, Type: e.Type, Payload: e.Payload}
			}
			acked, err := p.PostEvents(ctx, runtime, events)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[Acked]{Body: Acked{acked}}, nil
		})

	huma.Register(api, internalOp("snapshotUploadURL", http.MethodPost, "/internal/v1/runtime-instances/{instance_id}/snapshot",
		"Where to upload the agent's next snapshot", 200, "runtime instances"),
		func(ctx context.Context, in *InstancePath) (*httpapi.Body[UploadOut], error) {
			runtime, err := instance(ctx, *in)
			if err != nil {
				return nil, err
			}
			url, err := p.UploadURL(ctx, runtime)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[UploadOut]{Body: UploadOut{url}}, nil
		})

	huma.Register(api, internalOp("runtimeAuth", http.MethodGet, "/internal/v1/runtime-auth",
		"The runtime gateway's forward auth: which agent holds this runtime key (<instance id>.<token>)", 204, "runtime gateway"),
		func(ctx context.Context, in *Bearer) (*struct {
			AgentID string `header:"X-AXP-Agent-Id"`
		}, error) {
			agent, err := p.AgentFor(ctx, in.token())
			if err != nil {
				return nil, err
			}
			return &struct {
				AgentID string `header:"X-AXP-Agent-Id"`
			}{agent}, nil
		})

}
