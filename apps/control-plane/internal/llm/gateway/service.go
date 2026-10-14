package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// Model is an entry of the catalog. Models stay listed after their last
// connection goes away (unavailable) so agents keep their selection and
// recover automatically when an account is connected again.
type Model struct {
	ID            string `json:"id"`
	Connector     string `json:"connector"`
	DisplayName   string `json:"display_name"`
	ContextWindow int    `json:"context_window,omitempty"`
	// Status is ModelAvailable, ModelDegraded or ModelUnavailable, from the
	// best account that serves the model.
	Status string `json:"status,omitempty"`
	// Available is whether requests are let through: a degraded model is.
	Available bool `json:"available"`
	// Reason explains a degraded or unavailable model; RetryAt is when it
	// recovers by itself, if it does.
	Reason  *ConnectionError `json:"reason,omitempty"`
	RetryAt *time.Time       `json:"retry_at,omitempty"`
}

// Service ties connectors, CPA's auth manager and the model catalog together.
type Service struct {
	connectors []Connector
	byID       map[string]Connector
	byProvider map[string]string
	auths      *coreauth.Manager
	registry   cliproxy.ModelRegistry
	mgmt       *http.Client
	mgmtURL    func(string) string

	catalogPath string
	mu          sync.Mutex
	catalog     map[string]Model
	logins      map[string]loginRef
	checks      map[string]check
	refreshing  *refreshCall
	now         func() time.Time
}

type loginRef struct {
	connector string
	expires   time.Time
}

type Config struct {
	Connectors    []Connector
	Auths         *coreauth.Manager
	Registry      cliproxy.ModelRegistry
	Management    *http.Client
	ManagementURL func(path string) string
	// CatalogPath persists every model seen so far.
	CatalogPath string
}

func NewService(cfg Config) *Service {
	s := &Service{
		connectors:  cfg.Connectors,
		byID:        map[string]Connector{},
		byProvider:  map[string]string{},
		auths:       cfg.Auths,
		registry:    cfg.Registry,
		mgmt:        cfg.Management,
		mgmtURL:     cfg.ManagementURL,
		catalogPath: cfg.CatalogPath,
		catalog:     map[string]Model{},
		logins:      map[string]loginRef{},
		checks:      map[string]check{},
		now:         time.Now,
	}
	for _, c := range cfg.Connectors {
		info := c.Info()
		s.byID[info.ID] = c
		s.byProvider[info.Provider] = info.ID
	}
	if raw, err := os.ReadFile(s.catalogPath); err == nil {
		var models []Model
		if json.Unmarshal(raw, &models) == nil {
			for _, m := range models {
				s.catalog[m.ID] = m
			}
		}
	}
	return s
}

func (s *Service) Connectors() []ConnectorInfo {
	out := make([]ConnectorInfo, 0, len(s.connectors))
	for _, c := range s.connectors {
		out = append(out, c.Info())
	}
	return out
}

// Connections lists credentials of every known connector.
func (s *Service) Connections() []Connection {
	now := s.now()
	var out []Connection
	for _, a := range s.auths.List() {
		connector, ok := s.byProvider[strings.ToLower(a.Provider)]
		if !ok {
			continue
		}
		out = append(out, s.withCheck(normalize(a, connector, now), a))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Connector != out[j].Connector {
			return out[i].Connector < out[j].Connector
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out
}

func (s *Service) connection(id string) (Connection, error) {
	for _, c := range s.Connections() {
		if c.ID == id {
			return c, nil
		}
	}
	return Connection{}, ErrNotFound
}

// SetEnabled enables or disables a connection through CPA's management API.
func (s *Service) SetEnabled(ctx context.Context, id string, enabled bool) (Connection, error) {
	c, err := s.connection(id)
	if err != nil {
		return c, err
	}
	body, _ := json.Marshal(map[string]any{"name": c.fileName, "disabled": !enabled})
	if err := s.manage(ctx, http.MethodPatch, "/auth-files/status", body); err != nil {
		return c, err
	}
	return s.connection(id)
}

// Delete removes a connection and its credential file.
func (s *Service) Delete(ctx context.Context, id string) error {
	c, err := s.connection(id)
	if err != nil {
		return err
	}
	return s.manage(ctx, http.MethodDelete, "/auth-files?name="+url.QueryEscape(c.fileName), nil)
}

// Models returns the catalog with each model's current status: the best of
// the accounts that serve it, so one account's trouble does not hide a
// model another account still serves.
func (s *Service) Models() []Model {
	now := s.now()
	conns := s.Connections()
	connByID := map[string]Connection{}
	worst := map[string]Connection{} // per connector, the most actionable problem
	for _, c := range conns {
		connByID[c.ID] = c
		if c.State != StateActive && severity(c.State) > severity(worst[c.Connector].State) {
			worst[c.Connector] = c
		}
	}

	type status struct {
		state   string
		reason  *ConnectionError
		retryAt *time.Time
	}
	best := map[string]status{}
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for _, a := range s.auths.List() {
		connector, ok := s.byProvider[strings.ToLower(a.Provider)]
		if !ok {
			continue
		}
		conn, ok := connByID[a.ID]
		if !ok {
			continue
		}
		name := s.byID[connector].Info().DisplayName
		for _, info := range s.registry.GetModelsForClient(a.ID) {
			if info == nil || info.ID == "" || !chatModel(info) {
				continue
			}
			m := Model{
				ID:            info.ID,
				Connector:     connector,
				DisplayName:   firstNonEmpty(info.DisplayName, info.Name, info.ID),
				ContextWindow: firstPositive(info.ContextLength, info.InputTokenLimit),
			}
			if old, ok := s.catalog[m.ID]; !ok || old != m {
				s.catalog[m.ID] = m
				changed = true
			}
			state, reason, retryAt := modelStatus(a, conn, m.ID, name, now)
			if prev, ok := best[m.ID]; !ok || modelRank(state) > modelRank(prev.state) {
				best[m.ID] = status{state, reason, retryAt}
			}
		}
	}
	if changed {
		s.saveCatalogLocked()
	}

	out := make([]Model, 0, len(s.catalog))
	for _, m := range s.catalog {
		st, ok := best[m.ID]
		if !ok {
			// No account serves it: none is connected, or they all are down.
			w := worst[m.Connector]
			st = status{ModelUnavailable, connectionReason(s.connectorName(m.Connector), w), w.RetryAt}
			if w.State == StateDegraded {
				st.state = ModelDegraded
			}
		}
		m.Status, m.Reason, m.RetryAt = st.state, st.reason, st.retryAt
		m.Available = st.state != ModelUnavailable
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Connector != out[j].Connector {
			return out[i].Connector < out[j].Connector
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func (s *Service) connectorName(id string) string {
	if c, ok := s.byID[id]; ok {
		return c.Info().DisplayName
	}
	return "该服务"
}

func modelRank(state string) int {
	switch state {
	case ModelAvailable:
		return 2
	case ModelDegraded:
		return 1
	}
	return 0
}

func severity(state string) int {
	switch state {
	case StateNeedsLogin:
		return 5
	case StateError:
		return 4
	case StateRateLimited:
		return 3
	case StateDegraded:
		return 2
	case StateDisabled:
		return 1
	}
	return 0
}

// chatModel drops image/video/embedding models, which agents cannot use.
func chatModel(info *cliproxy.ModelInfo) bool {
	id := strings.ToLower(info.ID)
	for _, s := range []string{"image", "video", "embedding", "tts", "whisper", "imagine", "auto-review"} {
		if strings.Contains(id, s) {
			return false
		}
	}
	return true
}

func (s *Service) saveCatalogLocked() {
	models := make([]Model, 0, len(s.catalog))
	for _, m := range s.catalog {
		models = append(models, m)
	}
	sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })
	raw, _ := json.MarshalIndent(models, "", "  ")
	tmp := s.catalogPath + ".tmp"
	if os.WriteFile(tmp, raw, 0o600) == nil {
		_ = os.Rename(tmp, s.catalogPath)
	}
}

// --- Logins ------------------------------------------------------------------

func (s *Service) StartLogin(ctx context.Context, connectorID string, in LoginInput) (*LoginSession, error) {
	c, ok := s.byID[connectorID]
	if !ok {
		return nil, ErrNotFound
	}
	sess, err := c.StartLogin(ctx, in)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for id, ref := range s.logins {
		if now.After(ref.expires.Add(time.Hour)) {
			delete(s.logins, id)
		}
	}
	s.logins[sess.ID] = loginRef{connector: connectorID, expires: sess.ExpiresAt}
	return sess, nil
}

func (s *Service) login(id string) (Connector, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ref, ok := s.logins[id]
	if !ok {
		return nil, ErrNotFound
	}
	return s.byID[ref.connector], nil
}

func (s *Service) PollLogin(ctx context.Context, id string) (*LoginSession, error) {
	c, err := s.login(id)
	if err != nil {
		return nil, err
	}
	return c.PollLogin(ctx, id)
}

func (s *Service) SubmitLogin(ctx context.Context, id string, in LoginInput) error {
	c, err := s.login(id)
	if err != nil {
		return err
	}
	return c.SubmitLogin(ctx, id, in)
}

func (s *Service) CancelLogin(ctx context.Context, id string) error {
	c, err := s.login(id)
	if err != nil {
		return err
	}
	err = c.CancelLogin(ctx, id)
	s.mu.Lock()
	delete(s.logins, id)
	s.mu.Unlock()
	return err
}

// --- CPA management API -------------------------------------------------------

func (s *Service) manage(ctx context.Context, method, path string, body []byte) error {
	return Manage(ctx, s.mgmt, s.mgmtURL(path), method, body, nil)
}

// Manage calls CPA's management API and decodes a JSON response into out.
func Manage(ctx context.Context, client *http.Client, url, method string, body []byte, out any) error {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		return fmt.Errorf("CPA management %s %s: %d %s", method, url, res.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func firstPositive(values ...int) int {
	for _, v := range values {
		if v > 0 {
			return v
		}
	}
	return 0
}
