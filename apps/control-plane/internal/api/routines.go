package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/routines"
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
)

// The routines API: the web client's 定时 tab.

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
	Routines []routines.Routine `json:"routines"`
}

type RoutinePath struct {
	RoutineID string `path:"routine_id"`
}

func routineOp(id, method, path, summary string, status int) huma.Operation {
	o := op(id, method, path, summary, status, "routines")
	o.Errors = []int{400, 404, 409, 422, 503}
	return o
}

func registerRoutines(api huma.API, d *Deps) {
	s := d.Routines

	huma.Register(api, routineOp("listRoutines", http.MethodGet, "/api/v1/routines",
		"Every routine with its recent runs", 200),
		func(ctx context.Context, _ *struct{}) (*body[RoutineList], error) {
			list, err := s.List(ctx, d.DB)
			if err != nil {
				return nil, err
			}
			return &body[RoutineList]{RoutineList{list}}, nil
		})

	huma.Register(api, routineOp("createRoutine", http.MethodPost, "/api/v1/routines", "Create a routine", 201),
		func(ctx context.Context, in *struct{ Body RoutineIn }) (*body[routines.Routine], error) {
			routine, err := inTx(ctx, d, func(tx pgx.Tx) (*routines.Routine, error) {
				return s.Create(ctx, tx, routines.Input(in.Body))
			})
			if err != nil {
				return nil, err
			}
			return &body[routines.Routine]{*routine}, nil
		})

	huma.Register(api, routineOp("updateRoutine", http.MethodPatch, "/api/v1/routines/{routine_id}",
		"Change a routine; only the fields sent change", 200),
		func(ctx context.Context, in *struct {
			RoutinePath
			Body RoutineUpdateIn
		}) (*body[routines.Routine], error) {
			b := in.Body
			routine, err := inTx(ctx, d, func(tx pgx.Tx) (*routines.Routine, error) {
				return s.Update(ctx, tx, in.RoutineID, routines.Changes{
					Name: b.Name, Brief: b.Brief, Model: b.Model, Schedule: b.Schedule, Timezone: b.Timezone, Enabled: b.Enabled,
				})
			})
			if err != nil {
				return nil, err
			}
			return &body[routines.Routine]{*routine}, nil
		})

	huma.Register(api, routineOp("deleteRoutine", http.MethodDelete, "/api/v1/routines/{routine_id}",
		"Delete a routine and its history", 204),
		func(ctx context.Context, in *RoutinePath) (*struct{}, error) {
			_, err := inTx(ctx, d, func(tx pgx.Tx) (struct{}, error) {
				return struct{}{}, s.Delete(ctx, tx, in.RoutineID)
			})
			return nil, err
		})

	huma.Register(api, routineOp("runRoutine", http.MethodPost, "/api/v1/routines/{routine_id}/run",
		"Run a routine now", 202),
		func(ctx context.Context, in *RoutinePath) (*body[routines.Routine], error) {
			routine, err := s.RunNow(ctx, d.DB, in.RoutineID)
			if err != nil {
				return nil, err
			}
			return &body[routines.Routine]{*routine}, nil
		})

	huma.Register(api, routineOp("restoreBrief", http.MethodPost, "/api/v1/routines/{routine_id}/briefs/{version}/restore",
		"Make an earlier brief the current one", 200),
		func(ctx context.Context, in *struct {
			RoutinePath
			Version int `path:"version"`
		}) (*body[routines.Routine], error) {
			routine, err := inTx(ctx, d, func(tx pgx.Tx) (*routines.Routine, error) {
				return s.RestoreBrief(ctx, tx, in.RoutineID, in.Version)
			})
			if err != nil {
				return nil, err
			}
			return &body[routines.Routine]{*routine}, nil
		})

	huma.Register(api, routineOp("addFeedback", http.MethodPost, "/api/v1/routines/{routine_id}/runs/{run_id}/feedback",
		"Give feedback on a run; it revises the brief", 201),
		func(ctx context.Context, in *struct {
			RoutinePath
			RunID string `path:"run_id"`
			Body  FeedbackIn
		}) (*body[routines.Feedback], error) {
			feedback, err := inTx(ctx, d, func(tx pgx.Tx) (*routines.Feedback, error) {
				return s.AddFeedback(ctx, tx, in.RoutineID, in.RunID, strings.TrimSpace(in.Body.Text))
			})
			if err != nil {
				return nil, err
			}
			return &body[routines.Feedback]{*feedback}, nil
		})
}
