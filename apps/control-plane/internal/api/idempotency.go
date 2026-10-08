package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/apierr"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/store"
	"github.com/jackc/pgx/v5"
)

// Idempotency-Key handling for the product's POSTs. The handler runs in the
// transaction that records the key, so a stored response always corresponds
// to committed side effects. Errors roll back and do not consume the key.

const maxKeyLength = 255

// Keyed is the Idempotency-Key header of a POST.
type Keyed struct {
	IdempotencyKey string `header:"Idempotency-Key" doc:"Retrying with the same key returns the first response instead of doing it again."`
}

// Response is a response whose status depends on the request (a replay
// keeps the original one).
type Response[T any] struct {
	Status int
	Body   T
}

// handled is a handler's result: the status, the body and the id of the
// resource it is about.
type handled[T any] struct {
	status   int
	body     *T
	resource string
}

func requestHash(payload any) (string, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	// Through a generic value, so keys are sorted.
	var canonical any
	if err := json.Unmarshal(data, &canonical); err != nil {
		return "", err
	}
	data, err = json.Marshal(canonical)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

type stored struct {
	hash   string
	status int
	body   []byte
}

func lookup(ctx context.Context, db store.DB, method, path, key string) (*stored, error) {
	var s stored
	err := db.QueryRow(ctx, `SELECT request_hash, response_status, response_body FROM api_idempotency
		WHERE method = $1 AND canonical_path = $2 AND key = $3`, method, path, key).Scan(&s.hash, &s.status, &s.body)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &s, err
}

func replay[T any](s *stored, hash string) (*Response[T], error) {
	if s.hash != hash {
		return nil, apierr.New(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key 已用于不同的请求。")
	}
	out := &Response[T]{Status: s.status}
	if err := json.Unmarshal(s.body, &out.Body); err != nil {
		return nil, err
	}
	return out, nil
}

func idempotent[T any](ctx context.Context, d *Deps, key string, payload any, handler func(pgx.Tx) (handled[T], error)) (*Response[T], error) {
	key = strings.TrimSpace(key)
	if key == "" || len(key) > maxKeyLength {
		return nil, apierr.New(400, "IDEMPOTENCY_KEY_REQUIRED", "请求缺少有效的 Idempotency-Key。")
	}
	hash, err := requestHash(payload)
	if err != nil {
		return nil, err
	}
	request, _ := ctx.Value(requestKey).(requestInfo)
	if existing, err := lookup(ctx, d.DB, request.method, request.path, key); err != nil || existing != nil {
		if err != nil {
			return nil, err
		}
		return replay[T](existing, hash)
	}
	var result handled[T]
	err = store.InTx(ctx, d.DB, func(tx pgx.Tx) error {
		var err error
		if result, err = handler(tx); err != nil {
			return err
		}
		body, err := json.Marshal(result.body)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO api_idempotency (id, method, canonical_path, key, request_hash,
			response_status, response_body, resource_id, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			chat.NewID(), request.method, request.path, key, hash, result.status, body, result.resource, chat.Now())
		return err
	})
	if store.IsUniqueViolation(err) {
		// A concurrent request with the same key committed first.
		existing, lookupErr := lookup(ctx, d.DB, request.method, request.path, key)
		if lookupErr != nil || existing == nil {
			return nil, errors.Join(err, lookupErr)
		}
		return replay[T](existing, hash)
	}
	if err != nil {
		return nil, err
	}
	return &Response[T]{Status: result.status, Body: *result.body}, nil
}
