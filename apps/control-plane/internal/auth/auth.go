// Package auth is runtimes' credentials.
//
// A runtime's token is derived from its instance id and generation, so it
// stops working as soon as a new generation takes over; a routine run's from
// the run's id, and it works only while the run runs. Identity in request
// bodies is never trusted.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
)

func sign(secret []byte, message string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}

func RuntimeToken(secret []byte, instanceID string, generation int64) string {
	return sign(secret, fmt.Sprintf("runtime:%s:%d", instanceID, generation))
}

func RoutineToken(secret []byte, runID string) string {
	return sign(secret, "routine-run:"+runID)
}

// Matches compares tokens in constant time.
func Matches(token, expected string) bool {
	return hmac.Equal([]byte(token), []byte(expected))
}

// Bearer is the request's bearer token, or "".
func Bearer(r *http.Request) string {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return ""
	}
	return token
}
