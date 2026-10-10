// Package idempotency makes a POST safe to retry: a request with the same
// Idempotency-Key header gets the first response instead of running again.
//
// The operation runs in the transaction that records the key, so a stored
// response always corresponds to committed side effects; an error rolls back
// and does not use up the key. Keys live in the service's database
// (api_idempotency, created by pg.Migrate).
//
// Requests with the same key take turns, so two at once never both run the
// operation. Once it starts it finishes, even if the client goes away: it
// may have done something the database cannot roll back (published a
// command), so it runs on Do's context, which keeps the request's values but
// not its cancellation.
//
//	huma.Register(api, op, func(ctx context.Context, in *struct {
//		idempotency.Keyed
//		Body RoutineIn
//	}) (*idempotency.Response[Routine], error) {
//		return idempotency.Do(ctx, pool, in.IdempotencyKey, in.Body, func(ctx context.Context, tx pgx.Tx) (idempotency.Result[Routine], error) {
//			r, err := s.Create(ctx, tx, in.Body)
//			return idempotency.Created(r, r.ID), err
//		})
//	})
package idempotency

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maxKeyLength = 255

// Keyed is the Idempotency-Key header of a POST.
type Keyed struct {
	IdempotencyKey string `header:"Idempotency-Key" doc:"Retrying with the same key returns the first response instead of doing it again."`
}

// Response is an operation's output whose status depends on the request (a
// replay keeps the original one).
type Response[T any] struct {
	Status int
	Body   T
}

// Result is what the operation did: the status, the body and the id of the
// resource it is about.
type Result[T any] struct {
	Status   int
	Body     *T
	Resource string
}

// Created is a 201 with body, about resource.
func Created[T any](body *T, resource string) Result[T] { return Result[T]{201, body, resource} }

// OK is a 200 with body, about resource.
func OK[T any](body *T, resource string) Result[T] { return Result[T]{200, body, resource} }

// Timeout bounds an operation, which the client leaving does not cancel.
const Timeout = time.Minute

// Do runs fn once per key: in a transaction, unless a request with the key
// was answered already, whose response it returns. The same key with a
// different payload is refused. fn gets the context to work with: ctx
// without its cancellation, bounded by Timeout.
func Do[T any](ctx context.Context, pool *pgxpool.Pool, key string, payload any,
	fn func(context.Context, pgx.Tx) (Result[T], error)) (*Response[T], error) {
	key = strings.TrimSpace(key)
	if key == "" || len(key) > maxKeyLength {
		return nil, apierr.New(400, "IDEMPOTENCY_KEY_REQUIRED", "请求缺少有效的 Idempotency-Key。")
	}
	hash, err := requestHash(payload)
	if err != nil {
		return nil, err
	}
	var method, path string
	if r := httpapi.Request(ctx); r != nil {
		method, path = r.Method, r.URL.Path
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), Timeout)
	defer cancel()
	var out *Response[T]
	err = pg.InTx(ctx, pool, func(tx pgx.Tx) error {
		// Held until commit: a request with the same key waits here, then
		// finds this one's response.
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
			"idempotency "+method+" "+path+" "+key); err != nil {
			return err
		}
		existing, err := lookup(ctx, tx, method, path, key)
		if err != nil {
			return err
		}
		if existing != nil {
			out, err = replay[T](existing, hash)
			return err
		}
		result, err := fn(ctx, tx)
		if err != nil {
			return err
		}
		body, err := json.Marshal(result.Body)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO api_idempotency (id, method, canonical_path, key, request_hash,
			response_status, response_body, resource_id, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			pg.NewID(), method, path, key, hash, result.Status, body, result.Resource, pg.Now()); err != nil {
			return err
		}
		out = &Response[T]{Status: result.Status, Body: *result.Body}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
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

func lookup(ctx context.Context, db pg.DB, method, path, key string) (*stored, error) {
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
