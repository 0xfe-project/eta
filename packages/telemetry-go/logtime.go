package telemetry

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"
)

// logTimestamps sends envelopes with each log's timestamp in seconds since
// the epoch, as Sentry's protocol documents it. sentry-go (0.50) writes
// RFC 3339 text, which Rustrak (0.16) does not read: it drops the logs. Every
// other item passes unchanged.
type logTimestamps struct{ next http.RoundTripper }

func (t logTimestamps) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Body != nil {
		body, err := io.ReadAll(r.Body)
		_ = r.Body.Close()
		if err != nil {
			return nil, err
		}
		body = numericLogTimes(body)
		r = r.Clone(r.Context())
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
	}
	return t.next.RoundTrip(r)
}

// numericLogTimes rewrites an envelope: a header line, then items, each a
// header line and a payload of the header's length. Anything it cannot read
// is returned as it is.
func numericLogTimes(envelope []byte) []byte {
	header, rest, ok := bytes.Cut(envelope, []byte("\n"))
	if !ok {
		return envelope
	}
	out := append(append([]byte{}, header...), '\n')
	for len(rest) > 0 {
		line, after, _ := bytes.Cut(rest, []byte("\n"))
		var item map[string]any
		if json.Unmarshal(line, &item) != nil {
			return envelope
		}
		length, hasLength := item["length"].(float64)
		var payload []byte
		if hasLength {
			if int(length) > len(after) {
				return envelope
			}
			payload, rest = after[:int(length)], after[int(length):]
			rest = bytes.TrimPrefix(rest, []byte("\n"))
		} else {
			payload, rest, _ = bytes.Cut(after, []byte("\n"))
		}
		if item["type"] == "log" {
			if converted, ok := convertLogTimes(payload); ok {
				payload = converted
				if hasLength {
					item["length"] = len(payload)
					line, _ = json.Marshal(item)
				}
			}
		}
		out = append(append(append(append(out, line...), '\n'), payload...), '\n')
	}
	return out
}

func convertLogTimes(payload []byte) ([]byte, bool) {
	var container struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if json.Unmarshal(payload, &container) != nil {
		return nil, false
	}
	for _, log := range container.Items {
		var text string
		if json.Unmarshal(log["timestamp"], &text) != nil {
			continue // already a number
		}
		at, err := time.Parse(time.RFC3339Nano, text)
		if err != nil {
			continue
		}
		seconds := float64(at.UnixMicro()) / 1e6
		log["timestamp"] = json.RawMessage(strconv.FormatFloat(seconds, 'f', 6, 64))
	}
	converted, err := json.Marshal(container)
	return converted, err == nil
}
