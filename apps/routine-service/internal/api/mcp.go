package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/akarachen/axp/apps/routine-service/internal/routines"
	"github.com/akarachen/axp/packages/service-go/apierr"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The routines plugin's MCP server: chat agents list routines, read their
// runs, create them and change them, for the user who asked in the chat. The
// runtime gateway authenticates the runtime, checks that its agent has the
// plugin, and passes it on as X-AXP-Agent-Id (apps/gateway/runtime.caddy,
// /routines); nothing else reaches this route.

type routineRef struct {
	Routine string `json:"routine" jsonschema:"the routine's id, from list_routines"`
}

type runRef struct {
	routineRef
	Run string `json:"run" jsonschema:"the run's id, from get_routine"`
}

type scheduleIn struct {
	Kind  string `json:"kind" jsonschema:"daily, weekly, hourly or cron"`
	Time  string `json:"time,omitempty" jsonschema:"HH:MM (24-hour), for daily and weekly"`
	Days  []int  `json:"days,omitempty" jsonschema:"for weekly: the weekdays, 0 is Sunday"`
	Every int    `json:"every,omitempty" jsonschema:"for hourly: every this many hours (1, 2, 3, 4, 6, 8 or 12)"`
	Cron  string `json:"cron,omitempty" jsonschema:"for cron: five fields (minute hour day month weekday)"`
}

func (s *scheduleIn) schedule() *routines.Schedule {
	if s == nil {
		return nil
	}
	return &routines.Schedule{Kind: s.Kind, Time: s.Time, Days: s.Days, Every: s.Every, Cron: s.Cron}
}

type createRoutineIn struct {
	Name     string     `json:"name" jsonschema:"a short name, e.g. 科技日报"`
	Brief    string     `json:"brief" jsonschema:"what each run does and reports, in the user's words and language; it runs without anyone to ask"`
	Schedule scheduleIn `json:"schedule"`
	Timezone string     `json:"timezone" jsonschema:"an IANA time zone, e.g. Asia/Shanghai (the user's)"`
	Model    string     `json:"model,omitempty" jsonschema:"the model id to run it with; by default the one the user's latest routine runs with"`
}

type updateRoutineIn struct {
	routineRef
	Name     *string     `json:"name,omitempty"`
	Brief    *string     `json:"brief,omitempty" jsonschema:"the whole new brief; it becomes a new version (the user can restore older ones)"`
	Schedule *scheduleIn `json:"schedule,omitempty"`
	Timezone *string     `json:"timezone,omitempty"`
	Enabled  *bool       `json:"enabled,omitempty" jsonschema:"false pauses it"`
	Model    *string     `json:"model,omitempty"`
}

type routineListOut struct {
	Routines []routines.RoutineSummary `json:"routines"`
}

// mcpError is what the agent sees: the product message.
func mcpError(err error) error {
	var product *apierr.Error
	if errors.As(err, &product) {
		return errors.New(product.Message)
	}
	return err
}

func routinesMCP(d *Deps) http.Handler {
	s := d.Routines
	srv := mcp.NewServer(&mcp.Implementation{Name: "routines"}, nil)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "list_routines",
		Description: "The user's routines (agents that run on a schedule and leave a report): schedule, whether enabled, the next run and the last runs' status and title.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
		list, err := s.List(ctx, d.DB)
		return nil, &routineListOut{list}, mcpError(err)
	})
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "get_routine",
		Description: "One routine in full: its brief and earlier versions, its handoff note, and its recent runs with their reports and the user's feedback.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in routineRef) (*mcp.CallToolResult, any, error) {
		r, err := s.Get(ctx, d.DB, in.Routine)
		return nil, r, mcpError(err)
	})
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "get_run",
		Description: "One recent run of a routine: its report (or error) and the user's feedback on it.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in runRef) (*mcp.CallToolResult, any, error) {
		r, err := s.Get(ctx, d.DB, in.Routine)
		if err != nil {
			return nil, nil, mcpError(err)
		}
		for _, run := range r.Runs {
			if run.ID == in.Run {
				return nil, run, nil
			}
		}
		return nil, nil, errors.New("no such recent run")
	})
	mcp.AddTool(srv, &mcp.Tool{
		Name: "create_routine",
		Description: "Create a routine for the user: it runs on its schedule, does what its brief says and leaves a report " +
			"the user reads in AXP. Use it when the user asks for something done regularly (\"every morning...\").",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in createRoutineIn) (*mcp.CallToolResult, any, error) {
		r, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*routines.Routine, error) {
			model := in.Model
			if model == "" {
				if err := tx.QueryRow(ctx, "SELECT model FROM routine ORDER BY updated_at DESC LIMIT 1").Scan(&model); err != nil {
					if errors.Is(err, pgx.ErrNoRows) {
						return nil, errors.New("pass a model: the user has no routine yet to take one from")
					}
					return nil, err
				}
			}
			return s.Create(ctx, tx, routines.Input{
				Name: in.Name, Brief: in.Brief, Model: model, Schedule: *in.Schedule.schedule(), Timezone: in.Timezone,
			})
		})
		return nil, r, mcpError(err)
	})
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "update_routine",
		Description: "Change a routine: its name, brief (a new version), schedule, time zone, model, or pause it; only the fields given change.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in updateRoutineIn) (*mcp.CallToolResult, any, error) {
		r, err := pg.InTxValue(ctx, d.DB, func(tx pgx.Tx) (*routines.Routine, error) {
			return s.Update(ctx, tx, in.Routine, routines.Changes{
				Name: in.Name, Brief: in.Brief, Model: in.Model, Schedule: in.Schedule.schedule(),
				Timezone: in.Timezone, Enabled: in.Enabled,
			})
		})
		return nil, r, mcpError(err)
	})
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "run_routine",
		Description: "Run a routine now, as if its schedule fired; its report shows up in AXP when it finishes.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in routineRef) (*mcp.CallToolResult, any, error) {
		r, err := s.RunNow(ctx, d.DB, in.Routine)
		return nil, r, mcpError(err)
	})

	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, &mcp.StreamableHTTPOptions{
		Stateless: true, JSONResponse: true,
		// Reached through the runtime gateway; the network is the trust boundary.
		DisableLocalhostProtection: true,
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-AXP-Agent-Id") == "" {
			http.Error(w, "only for agents, through the runtime gateway", http.StatusForbidden)
			return
		}
		handler.ServeHTTP(w, r)
	})
}
