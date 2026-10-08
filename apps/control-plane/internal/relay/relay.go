// Package relay is the control plane's client for the agenvo relay
// (vendor/agenvo, unmodified), which connects remote computers' coding
// runtimes (docs/architecture/tasks.md).
//
// The relay has two surfaces, both reached on the internal network:
//
//   - its administrator API (Bearer: the administrator secret), for pairing
//     approval, its devices' state and revocation;
//   - its MCP endpoint, for runtime calls. That one only takes OAuth access
//     tokens, which the relay grants after its owner consents in a browser;
//     the control plane holds the administrator secret, so it signs in and
//     consents itself, once, and keeps refreshing the grant.
//
// The relay checks Host against its public origin, so every request carries
// the origin's host whatever address it is sent to.
package relay

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
	DB           *pgxpool.Pool
	HTTP         *http.Client
}

// New is the relay client, or nil when no relay is configured. caFile, when
// set, is the only CA trusted for the relay (development's self-signed one).
func New(internalURL, origin, secret, caFile string, db *pgxpool.Pool) (*Client, error) {
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
		URL: strings.TrimRight(internalURL, "/"), PublicOrigin: strings.TrimRight(origin, "/"), Secret: secret, DB: db,
		// Never follow redirects: consent answers with one to our callback.
		HTTP: &http.Client{
			Transport: transport, Timeout: 30 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
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

// --- MCP ----------------------------------------------------------------------------

// Call is the relay's runtime_call tool: method on one approved instance.
// A transport failure on a write is reported as an unknown outcome.
func (c *Client) Call(ctx context.Context, deviceID, instanceID, method string, params any) (*Outcome, error) {
	if params == nil {
		params = map[string]any{}
	}
	args := map[string]any{"deviceId": deviceID, "instanceId": instanceID, "method": method, "params": params}
	out, err := c.tool(ctx, "runtime_call", args)
	if err != nil {
		return nil, err
	}
	if out.Error != nil && out.Execution != "unknown" {
		return out, out.Error
	}
	return out, nil
}

func (c *Client) tool(ctx context.Context, name string, args any) (*Outcome, error) {
	for attempt := 0; ; attempt++ {
		token, err := c.accessToken(ctx, attempt > 0)
		if err != nil {
			return nil, err
		}
		body, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0", "id": 1, "method": "tools/call",
			"params": map[string]any{"name": name, "arguments": args},
		})
		resp, data, err := c.send(ctx, http.MethodPost, "/mcp", bytes.NewReader(body), http.Header{
			"Authorization":        {"Bearer " + token},
			"Content-Type":         {"application/json"},
			"Accept":               {"application/json, text/event-stream"},
			"Mcp-Protocol-Version": {"2025-06-18"},
		})
		if err != nil {
			return nil, err
		}
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
			continue
		}
		if resp.StatusCode >= 300 {
			return nil, fmt.Errorf("relay: MCP HTTP %d", resp.StatusCode)
		}
		return toolOutcome(resp.Header.Get("Content-Type"), data)
	}
}

// toolOutcome reads a tools/call answer (JSON or one SSE event): its text
// content is the relay's outcome.
func toolOutcome(contentType string, data []byte) (*Outcome, error) {
	if strings.Contains(contentType, "text/event-stream") {
		var last []byte
		for line := range bytes.SplitSeq(data, []byte("\n")) {
			if rest, ok := bytes.CutPrefix(line, []byte("data:")); ok {
				last = bytes.TrimSpace(rest)
			}
		}
		data = last
	}
	var rpc struct {
		Result *struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &rpc); err != nil {
		return nil, fmt.Errorf("relay: unreadable MCP answer: %w", err)
	}
	if rpc.Error != nil {
		return nil, errors.New("relay: " + rpc.Error.Message)
	}
	if rpc.Result == nil || len(rpc.Result.Content) == 0 {
		return nil, errors.New("relay: empty MCP answer")
	}
	var out Outcome
	if err := json.Unmarshal([]byte(rpc.Result.Content[0].Text), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// --- OAuth ----------------------------------------------------------------------------

// The redirect URI is never visited: consent answers with a redirect to it,
// and the code is read from that.
const callback = "http://127.0.0.1/axp-relay-callback"

type tokenRow struct {
	ClientID     string    `db:"client_id"`
	AccessToken  string    `db:"access_token"`
	RefreshToken string    `db:"refresh_token"`
	ExpiresAt    time.Time `db:"expires_at"`
}

func (c *Client) stored(ctx context.Context, db interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, lock bool) (*tokenRow, error) {
	sql := "SELECT client_id, access_token, refresh_token, expires_at FROM relay_token WHERE id = 1"
	if lock {
		sql += " FOR UPDATE"
	}
	rows, err := db.Query(ctx, sql)
	if err != nil {
		return nil, err
	}
	row, err := pgx.CollectOneRow(rows, pgx.RowToAddrOfStructByName[tokenRow])
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

// accessToken is a valid access token: the stored one, a refreshed one or a
// new grant. Refreshing happens under a lock, since the API and the
// controller share the grant and a refresh token works once.
func (c *Client) accessToken(ctx context.Context, stale bool) (string, error) {
	if !stale {
		row, err := c.stored(ctx, c.DB, false)
		if err != nil {
			return "", err
		}
		if row != nil && time.Until(row.ExpiresAt) > time.Minute {
			return row.AccessToken, nil
		}
	}
	var token string
	err := pgx.BeginFunc(ctx, c.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext('relay_token'))"); err != nil {
			return err
		}
		row, err := c.stored(ctx, tx, true)
		if err != nil {
			return err
		}
		if row != nil && !stale && time.Until(row.ExpiresAt) > time.Minute {
			token = row.AccessToken
			return nil
		}
		var fresh *tokenRow
		if row != nil {
			fresh, err = c.refresh(ctx, row)
		}
		if fresh == nil {
			if fresh, err = c.authorize(ctx); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, `INSERT INTO relay_token (id, client_id, access_token, refresh_token, expires_at)
			VALUES (1, $1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET client_id = $1, access_token = $2,
			refresh_token = $3, expires_at = $4`, fresh.ClientID, fresh.AccessToken, fresh.RefreshToken, fresh.ExpiresAt)
		token = fresh.AccessToken
		return err
	})
	return token, err
}

func (c *Client) form(ctx context.Context, path string, values url.Values, header http.Header) (*http.Response, []byte, error) {
	if header == nil {
		header = http.Header{}
	}
	header.Set("Content-Type", "application/x-www-form-urlencoded")
	header.Set("Origin", c.PublicOrigin)
	return c.send(ctx, http.MethodPost, path, strings.NewReader(values.Encode()), header)
}

func (c *Client) exchange(ctx context.Context, clientID string, values url.Values) (*tokenRow, error) {
	values.Set("client_id", clientID)
	values.Set("resource", c.PublicOrigin+"/mcp")
	resp, data, err := c.form(ctx, "/token", values, nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("relay: token HTTP %d: %s", resp.StatusCode, data)
	}
	var t struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, err
	}
	return &tokenRow{
		ClientID: clientID, AccessToken: t.AccessToken, RefreshToken: t.RefreshToken,
		ExpiresAt: time.Now().Add(time.Duration(t.ExpiresIn) * time.Second),
	}, nil
}

// refresh is nil, without an error, when the grant is gone (expired or
// revoked): a new one is needed.
func (c *Client) refresh(ctx context.Context, row *tokenRow) (*tokenRow, error) {
	fresh, err := c.exchange(ctx, row.ClientID, url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {row.RefreshToken},
	})
	if err != nil {
		return nil, nil
	}
	return fresh, nil
}

var handlePattern = regexp.MustCompile(`name="handle" value="([^"]+)"`)

// authorize registers a client and grants it access as the relay's owner:
// sign in with the administrator secret, consent, exchange the code.
func (c *Client) authorize(ctx context.Context) (*tokenRow, error) {
	registration, _ := json.Marshal(map[string]any{
		"client_name": "AXP control plane", "redirect_uris": []string{callback},
		"token_endpoint_auth_method": "none", "grant_types": []string{"authorization_code", "refresh_token"},
		"response_types": []string{"code"},
	})
	resp, data, err := c.send(ctx, http.MethodPost, "/register", bytes.NewReader(registration),
		http.Header{"Content-Type": {"application/json"}})
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("relay: register HTTP %d: %s", resp.StatusCode, data)
	}
	var client struct {
		ClientID string `json:"client_id"`
	}
	if err := json.Unmarshal(data, &client); err != nil {
		return nil, err
	}

	resp, _, err = c.form(ctx, "/login", url.Values{"secret": {c.Secret}, "next": {"/admin"}}, nil)
	if err != nil {
		return nil, err
	}
	session := ""
	for _, cookie := range resp.Cookies() {
		if strings.HasPrefix(cookie.Name, "__Host-agenvo") {
			session = cookie.Name + "=" + cookie.Value
		}
	}
	if session == "" {
		return nil, fmt.Errorf("relay: sign-in failed (HTTP %d)", resp.StatusCode)
	}
	defer func() {
		_, _, _ = c.form(context.WithoutCancel(ctx), "/logout", url.Values{}, http.Header{"Cookie": {session}})
	}()

	verifier := random()
	challenge := sha256.Sum256([]byte(verifier))
	query := url.Values{
		"response_type": {"code"}, "client_id": {client.ClientID}, "redirect_uri": {callback},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(challenge[:])},
		"code_challenge_method": {"S256"}, "state": {random()}, "scope": {"runtime:approved"},
		"resource": {c.PublicOrigin + "/mcp"},
	}.Encode()
	resp, data, err = c.send(ctx, http.MethodGet, "/authorize?"+query, nil, http.Header{"Cookie": {session}})
	if err != nil {
		return nil, err
	}
	match := handlePattern.FindSubmatch(data)
	if resp.StatusCode != http.StatusOK || match == nil {
		return nil, fmt.Errorf("relay: no consent page (HTTP %d)", resp.StatusCode)
	}
	resp, _, err = c.form(ctx, "/authorize?"+query, url.Values{"handle": {string(match[1])}, "decision": {"approve"}},
		http.Header{"Cookie": {session}})
	if err != nil {
		return nil, err
	}
	location, err := url.Parse(resp.Header.Get("Location"))
	if err != nil || location.Query().Get("code") == "" {
		return nil, fmt.Errorf("relay: consent not granted (HTTP %d)", resp.StatusCode)
	}
	return c.exchange(ctx, client.ClientID, url.Values{
		"grant_type": {"authorization_code"}, "code": {location.Query().Get("code")},
		"redirect_uri": {callback}, "code_verifier": {verifier},
	})
}

func random() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
