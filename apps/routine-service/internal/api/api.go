// Package api is the routine service's HTTP API, which the browser calls
// under /api/routines through the gateway: transport only, over the
// routines package.
package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/akarachen/axp/apps/routine-service/internal/routines"
	"github.com/akarachen/axp/packages/service-go/httpapi"
	"github.com/akarachen/axp/packages/service-go/idempotency"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const prefix = "/api/routines"

// Deps is what the operations use.
type Deps struct {
	DB       *pgxpool.Pool
	Routines *routines.Service
	// Revise revises a brief from committed feedback, in the background.
	Revise func(feedbackID string)
	// Docs serves the API's documentation page.
	Docs bool
}

type RoutineIn struct {
	Name     string            `json:"name" minLength:"1" maxLength:"100"`
	Brief    string            `json:"brief" minLength:"1" maxLength:"8000"`
	Model    string            `json:"model" minLength:"1" maxLength:"200"`
	Schedule routines.Schedule `json:"schedule"`
	Timezone string            `json:"timezone" minLength:"1" maxLength:"64"`
}

// RoutineUpdateIn is a partial update: only fields that are sent change.
type RoutineUpdateIn struct {
	Name     *string            `json:"name,omitempty" nullable:"true" minLength:"1" maxLength:"100"`
	Brief    *string            `json:"brief,omitempty" nullable:"true" minLength:"1" maxLength:"8000"`
	Model    *string            `json:"model,omitempty" nullable:"true" minLength:"1" maxLength:"200"`
	Schedule *routines.Schedule `json:"schedule,omitempty"`
	Timezone *string            `json:"timezone,omitempty" nullable:"true" minLength:"1" maxLength:"64"`
	Enabled  *bool              `json:"enabled,omitempty" nullable:"true"`
}

type FeedbackIn struct {
	Text string `json:"text" minLength:"1" maxLength:"4000"`
}

type RoutineList struct {
	Routines []routines.RoutineSummary `json:"routines"`
}

type RoutinePath struct {
	RoutineID string `path:"routine_id"`
}

var documented = []int{400, 404, 409, 422, 503}

func op(id, method, path, summary string, status int) huma.Operation {
	return httpapi.Op(id, method, prefix+"/v1"+path, summary, status, documented, "routines")
}

// New is the API.
func New(d *Deps) *httpapi.API {
	api := httpapi.New(httpapi.Config{Title: "AXP Routines", Version: "0.1.0", Prefix: prefix, Docs: d.Docs})
	httpapi.AddHealth(api, prefix+"/health", "routine-service")
	s := d.Routines

	huma.Register(api, op("listRoutines", http.MethodGet, "/routines", "Every routine, with its last runs in summary", 200),
		func(ctx context.Context, _ *struct{}) (*httpapi.Body[RoutineList], error) {
			list, err := s.List(ctx, d.DB)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[RoutineList]{Body: RoutineList{list}}, nil
		})

	huma.Register(api, op("getRoutine", http.MethodGet, "/routines/{routine_id}",
		"A routine with its briefs, and its recent runs with their reports and feedback", 200),
		func(ctx context.Context, in *RoutinePath) (*httpapi.Body[routines.Routine], error) {
			r, err := s.Get(ctx, d.DB, in.RoutineID)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[routines.Routine]{Body: *r}, nil
		})

	huma.Register(api, op("createRoutine", http.MethodPost, "/routines", "Create a routine", 201),
		func(ctx context.Context, in *struct {
			idempotency.Keyed
			Body RoutineIn
		}) (*idempotency.Response[routines.Routine], error) {
			return idempotency.Do(ctx, d.DB, in.IdempotencyKey, in.Body, func(tx pgx.Tx) (idempotency.Result[routines.Routine], error) {
				r, err := s.Create(ctx, tx, routines.Input(in.Body))
				if err != nil {
					return idempotency.Result[routines.Routine]{}, err
				}
				return idempotency.Created(r, r.ID), nil
			})
		})

	huma.Register(api, op("updateRoutine", http.MethodPatch, "/routines/{routine_id}",
		"Change a routine; only the fields sent change", 200),
		func(ctx context.Context, in *struct {
			RoutinePath
			Body RoutineUpdateIn
		}) (*httpapi.Body[routines.Routine], error) {
			b := in.Body
			r, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*routines.Routine, error) {
				return s.Update(ctx, tx, in.RoutineID, routines.Changes{
					Name: b.Name, Brief: b.Brief, Model: b.Model, Schedule: b.Schedule, Timezone: b.Timezone, Enabled: b.Enabled,
				})
			})
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[routines.Routine]{Body: *r}, nil
		})

	huma.Register(api, op("deleteRoutine", http.MethodDelete, "/routines/{routine_id}", "Delete a routine and its history", 204),
		func(ctx context.Context, in *RoutinePath) (*struct{}, error) {
			return nil, pg.InTx(ctx, d.DB, func(tx pgx.Tx) error { return s.Delete(ctx, tx, in.RoutineID) })
		})

	huma.Register(api, op("runRoutine", http.MethodPost, "/routines/{routine_id}/run", "Run a routine now", 202),
		func(ctx context.Context, in *RoutinePath) (*httpapi.Body[routines.Routine], error) {
			r, err := s.RunNow(ctx, d.DB, in.RoutineID)
			if err != nil {
				return nil, err
			}
			return &httpapi.Body[routines.Routine]{Body: *r}, nil
		})

	huma.Register(api, op("restoreBrief", http.MethodPost, "/routines/{routine_id}/briefs/{version}/restore",
		"Make an earlier brief the current one", 200),
		func(ctx context.Context, in *struct {
			idempotency.Keyed
			RoutinePath
			Version int `path:"version"`
		}) (*idempotency.Response[routines.Routine], error) {
			return idempotency.Do(ctx, d.DB, in.IdempotencyKey, struct{}{}, func(tx pgx.Tx) (idempotency.Result[routines.Routine], error) {
				r, err := s.RestoreBrief(ctx, tx, in.RoutineID, in.Version)
				if err != nil {
					return idempotency.Result[routines.Routine]{}, err
				}
				return idempotency.OK(r, r.ID), nil
			})
		})

	huma.Register(api, op("addFeedback", http.MethodPost, "/routines/{routine_id}/runs/{run_id}/feedback",
		"Give feedback on a run; it revises the brief", 201),
		func(ctx context.Context, in *struct {
			idempotency.Keyed
			RoutinePath
			RunID string `path:"run_id"`
			Body  FeedbackIn
		}) (*idempotency.Response[routines.Feedback], error) {
			out, err := idempotency.Do(ctx, d.DB, in.IdempotencyKey, in.Body, func(tx pgx.Tx) (idempotency.Result[routines.Feedback], error) {
				f, err := s.AddFeedback(ctx, tx, in.RoutineID, in.RunID, strings.TrimSpace(in.Body.Text))
				if err != nil {
					return idempotency.Result[routines.Feedback]{}, err
				}
				return idempotency.Created(f, f.ID), nil
			})
			if err == nil && d.Revise != nil {
				d.Revise(out.Body.ID)
			}
			return out, err
		})
	return api
}
