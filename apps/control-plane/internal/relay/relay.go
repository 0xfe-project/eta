// Package relay is the control plane's client for the agenvo relay
// (vendor/agenvo, our fork AkaraChen/agenvo), which connects remote
// computers' coding runtimes (docs/architecture/tasks.md).
//
// The control plane holds the relay's administrator secret and uses its
// administrator API (Bearer: the secret), reached on the internal network,
// for everything: pairing approval, its devices' state, revocation, and
// runtime calls (POST /api/admin/call, the fork's addition: runtime_call as
// the relay's owner, without an MCP grant).
//
// The relay checks Host against its public origin, so every request carries
// the origin's host whatever address it is sent to.
package relay

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// ErrNotConfigured is every call when no relay is set up.
var ErrNotConfigured = errors.New("relay not configured")

// Fault is an outcome the relay or the runtime reported as an error.
type Fault struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	// The runtime's own error, when it rejected the call.
	Native json.RawMessage `json:"native,omitempty"`
}

func (f *Fault) Error() string {
	if len(f.Native) > 0 {
		return "relay: " + f.Code + ": " + f.Message + ": " + string(f.Native)
	}
	return "relay: " + f.Code + ": " + f.Message
}

// Outcome is a runtime call's result. Execution is accepted, rejected,
// not_started, starting or unknown; unknown means the write may or may not
// have happened, and must be checked against the native state, never
// repeated.
type Outcome struct {
	Execution string          `json:"execution"`
	Result    json.RawMessage `json:"result"`
	Error     *Fault          `json:"error"`
}

// Instance is an approved runtime on a paired device.
type Instance struct {
	InstanceID  string `json:"instanceId"`
	Kind        string `json:"kind"`
	Fingerprint string `json:"fingerprint"`
	Available   bool   `json:"available"`
	Approved    bool   `json:"approved"`
}

type Device struct {
	ID        string     `json:"id"`
	Label     string     `json:"label"`
	Revoked   bool       `json:"revoked"`
	Online    bool       `json:"online"`
	Instances []Instance `json:"instances"`
}

type Pairing struct {
	Code      string     `json:"code"`
	Digest    string     `json:"digest"`
	Label     string     `json:"label"`
	Instances []Instance `json:"instances"`
}

type State struct {
	Devices  []Device  `json:"devices"`
	Pairings []Pairing `json:"pairings"`
}

// Relay is what the control plane does with the relay.
type Relay interface {
	// Origin is the relay's public origin, which connectors pair with.
	Origin() string
	State(ctx context.Context) (*State, error)
	ApprovePairing(ctx context.Context, code, fingerprint string) (deviceID string, err error)
	// ApproveInstance approves a device's changed or added runtime.
	ApproveInstance(ctx context.Context, deviceID, instanceID, fingerprint string) error
	RevokeDevice(ctx context.Context, deviceID string) error
	Call(ctx context.Context, deviceID, instanceID, method string, params any) (*Outcome, error)
}

// Client is the relay at URL whose public origin is PublicOrigin.
type Client struct {
	URL          string
	PublicOrigin string
	Secret       string
	HTTP         *http.Client
}

// New is the relay client, or nil when no relay is configured. caFile, when
// set, is the only CA trusted for the relay (development's self-signed one).
func New(internalURL, origin, secret, caFile string) (*Client, error) {
	if internalURL == "" || origin == "" || secret == "" {
		return nil, nil
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, err
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("relay: no certificate in %s", caFile)
		}
		host, _, _ := strings.Cut(strings.TrimPrefix(origin, "https://"), ":")
		transport.TLSClientConfig = &tls.Config{RootCAs: pool, ServerName: host}
	}
	return &Client{
		URL: strings.TrimRight(internalURL, "/"), PublicOrigin: strings.TrimRight(origin, "/"), Secret: secret,
		HTTP: &http.Client{Transport: transport, Timeout: 30 * time.Second},
	}, nil
}

func (c *Client) Origin() string { return c.PublicOrigin }

func (c *Client) host() string { return strings.TrimPrefix(c.PublicOrigin, "https://") }

// send is one request to the relay, as its public origin.
func (c *Client) send(ctx context.Context, method, path string, body io.Reader, header http.Header) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.URL+path, body)
	if err != nil {
		return nil, nil, err
	}
	for k, v := range header {
		req.Header[k] = v
	}
	req.Host = c.host()
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	return resp, data, err
}

// --- administrator API ---------------------------------------------------------------

func (c *Client) admin(ctx context.Context, method, path string, in, out any) error {
	header := http.Header{"Authorization": {"Bearer " + c.Secret}}
	var body io.Reader
	if in != nil {
		data, _ := json.Marshal(in)
		body = bytes.NewReader(data)
		header.Set("Content-Type", "application/json")
		header.Set("Origin", c.PublicOrigin)
	}
	resp, data, err := c.send(ctx, method, path, body, header)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return outcomeError(resp.StatusCode, data)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

func outcomeError(status int, data []byte) error {
	var o Outcome
	if json.Unmarshal(data, &o) == nil && o.Error != nil {
		return o.Error
	}
	return fmt.Errorf("relay: HTTP %d: %s", status, bytes.TrimSpace(data))
}

func (c *Client) State(ctx context.Context) (*State, error) {
	var s State
	if err := c.admin(ctx, http.MethodGet, "/api/admin/state", nil, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func (c *Client) ApprovePairing(ctx context.Context, code, fingerprint string) (string, error) {
	var out struct {
		DeviceID string `json:"deviceId"`
	}
	err := c.admin(ctx, http.MethodPost, "/api/admin/pairings/approve", map[string]string{"code": code, "digest": fingerprint}, &out)
	return out.DeviceID, err
}

func (c *Client) ApproveInstance(ctx context.Context, deviceID, instanceID, fingerprint string) error {
	return c.admin(ctx, http.MethodPost, "/api/admin/instances/approve",
		map[string]string{"deviceId": deviceID, "instanceId": instanceID, "fingerprint": fingerprint}, nil)
}

func (c *Client) RevokeDevice(ctx context.Context, deviceID string) error {
	err := c.admin(ctx, http.MethodPost, "/api/admin/revoke", map[string]string{"kind": "device", "id": deviceID}, nil)
	var fault *Fault
	if errors.As(err, &fault) && fault.Code == "not_found" {
		return nil
	}
	return err
}

// --- runtime calls ------------------------------------------------------------------------

// Call is a runtime_call as the relay's owner: method on one approved
// instance. A transport failure on a write is reported as an unknown
// outcome.
func (c *Client) Call(ctx context.Context, deviceID, instanceID, method string, params any) (*Outcome, error) {
	if params == nil {
		params = map[string]any{}
	}
	var out Outcome
	if err := c.admin(ctx, http.MethodPost, "/api/admin/call", map[string]any{
		"deviceId": deviceID, "instanceId": instanceID, "method": method, "params": params,
	}, &out); err != nil {
		return nil, err
	}
	if out.Error != nil && out.Execution != "unknown" {
		return &out, out.Error
	}
	return &out, nil
}
