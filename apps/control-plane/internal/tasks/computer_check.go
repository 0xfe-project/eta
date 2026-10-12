package tasks

import (
	"context"
	"fmt"
	"time"

	"github.com/akarachen/axp/packages/service-go/jsontime"
	"github.com/akarachen/axp/packages/service-go/pg"
)

// Checks are observations, never guarantees that an agent will start. No
// check creates an agent or workspace, and no observation gates assignment.
type ProviderCheck struct {
	Provider string `json:"provider"`
	State    string `json:"state" enum:"unchecked,unavailable,discovered"`
	Reason   string `json:"reason"`
}
type RuntimeCheck struct {
	Kind      string          `json:"kind"`
	Providers []ProviderCheck `json:"providers"`
	Error     *string         `json:"error" nullable:"true"`
}
type ComputerCheck struct {
	CheckedAt jsontime.Time  `json:"checked_at"`
	Runtimes  []RuntimeCheck `json:"runtimes"`
}

func (s *Service) CheckComputer(ctx context.Context, db pg.DB, id string) (*ComputerCheck, error) {
	c, err := computer(ctx, db, id)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	state, err := s.relayState(ctx)
	if err != nil {
		return nil, relayUnreachable(err)
	}
	rows, err := pg.All[computerRuntimeRow](ctx, db, "SELECT * FROM computer_runtime WHERE computer_id = $1 ORDER BY kind", c.ID)
	if err != nil {
		return nil, err
	}
	out := &ComputerCheck{Runtimes: []RuntimeCheck{}}
	for _, rt := range rows {
		check := RuntimeCheck{Kind: rt.Kind, Providers: []ProviderCheck{}}
		current := runtimeState(rt, state, "")
		reason := map[string]string{"offline": "connector 离线", "unavailable": "connector 在线，运行时服务未启动或不可用", "waiting": "尚未配对", "pairing": "需要批准配对", "needs_approval": "运行时有变化，需要重新批准", "unknown": "运行时状态未知"}[current.State]
		for _, p := range rt.Providers {
			check.Providers = append(check.Providers, ProviderCheck{Provider: p, State: "unchecked", Reason: "没有可靠的只读启动检查"})
		}
		if current.State != "online" {
			for i := range check.Providers {
				check.Providers[i].State = "unavailable"
				check.Providers[i].Reason = reason
			}
		} else if rt.Kind == "paseo" {
			var list struct {
				Providers []struct {
					Provider  string  `json:"provider"`
					Available *bool   `json:"available"`
					Error     *string `json:"error"`
				} `json:"providers"`
				Error *string `json:"error"`
			}
			err := (agents{s.Relay}).call(ctx, target{*rt.DeviceID, rt.Kind}, "paseo.providers.list", map[string]any{}, &list)
			if err == nil && list.Error != nil {
				err = fmt.Errorf("%s", *list.Error)
			}
			if err == nil && list.Providers == nil {
				err = fmt.Errorf("Paseo 没有返回 provider 检查结果")
			}
			if err != nil {
				message := err.Error()
				check.Error = &message
			} else {
				// Full-access execution supports these providers only. Include missing
				// ones so users can see failures omitted by the install-time report.
				check.Providers = []ProviderCheck{}
				for _, p := range []string{"codex", "claude"} {
					observed := ProviderCheck{Provider: p, State: "unchecked", Reason: "原生检查未返回此 provider"}
					for _, native := range list.Providers {
						if native.Provider != p {
							continue
						}
						if native.Available == nil {
							observed.Reason = "原生检查没有返回可用状态"
						} else if *native.Available {
							observed.State = "discovered"
							observed.Reason = "原生发现可用；实际启动未检查"
						} else {
							observed.State = "unavailable"
							observed.Reason = "原生检查报告不可用"
							if native.Error != nil && *native.Error != "" {
								observed.Reason = *native.Error
							}
						}
					}
					check.Providers = append(check.Providers, observed)
				}
			}
		}
		out.Runtimes = append(out.Runtimes, check)
	}
	out.CheckedAt = jsontime.From(time.Now())
	return out, nil
}
