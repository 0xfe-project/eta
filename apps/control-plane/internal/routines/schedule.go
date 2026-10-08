package routines

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/apierr"
	"github.com/danielgtaylor/huma/v2"
	"github.com/robfig/cron/v3"
)

// Schedule is when a routine runs, in one of the browser's shapes. NATS
// fires it (as six-field cron, with seconds); the same cron tells the browser
// when it runs next.
type Schedule struct {
	Kind string
	// daily and weekly: "HH:MM".
	Time string
	// weekly: 0 is Sunday, as in cron.
	Days []int
	// hourly: every this many hours.
	Every int
	// cron: five fields.
	Cron string
}

type DailySchedule struct {
	Kind string `json:"kind" enum:"daily"`
	Time string `json:"time" pattern:"^([01]\\d|2[0-3]):[0-5]\\d$"`
}

type WeeklySchedule struct {
	Kind string `json:"kind" enum:"weekly"`
	Days []int  `json:"days" minItems:"1" maxItems:"7" doc:"0 is Sunday, as in cron."`
	Time string `json:"time" pattern:"^([01]\\d|2[0-3]):[0-5]\\d$"`
}

type HourlySchedule struct {
	Kind  string `json:"kind" enum:"hourly"`
	Every int    `json:"every" enum:"1,2,3,4,6,8,12"`
}

type CronSchedule struct {
	Kind string `json:"kind" enum:"cron"`
	Cron string `json:"cron" maxLength:"100"`
}

func (s Schedule) MarshalJSON() ([]byte, error) {
	switch s.Kind {
	case "daily":
		return json.Marshal(DailySchedule{s.Kind, s.Time})
	case "weekly":
		return json.Marshal(WeeklySchedule{s.Kind, s.Days, s.Time})
	case "hourly":
		return json.Marshal(HourlySchedule{s.Kind, s.Every})
	default:
		return json.Marshal(CronSchedule{s.Kind, s.Cron})
	}
}

func (s *Schedule) UnmarshalJSON(data []byte) error {
	var raw struct {
		Kind  string `json:"kind"`
		Time  string `json:"time"`
		Days  []int  `json:"days"`
		Every int    `json:"every"`
		Cron  string `json:"cron"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*s = Schedule(raw)
	return nil
}

func (Schedule) Schema(r huma.Registry) *huma.Schema {
	shapes := map[string]reflect.Type{
		"daily":  reflect.TypeFor[DailySchedule](),
		"weekly": reflect.TypeFor[WeeklySchedule](),
		"hourly": reflect.TypeFor[HourlySchedule](),
		"cron":   reflect.TypeFor[CronSchedule](),
	}
	schema := &huma.Schema{Discriminator: &huma.Discriminator{PropertyName: "kind", Mapping: map[string]string{}}}
	for _, kind := range []string{"daily", "weekly", "hourly", "cron"} {
		ref := r.Schema(shapes[kind], true, "")
		schema.OneOf = append(schema.OneOf, ref)
		schema.Discriminator.Mapping[kind] = ref.Ref
	}
	return schema
}

// Weekly days are 0-6; JSON Schema checks each shape, this the days' range.
func (s Schedule) check() error {
	for _, d := range s.Days {
		if d < 0 || d > 6 {
			return apierr.New(422, "VALIDATION_ERROR", "请求参数无效。")
		}
	}
	return nil
}

var parser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)

// Cron5 is the schedule as five-field cron.
func (s Schedule) Cron5() string {
	switch s.Kind {
	case "cron":
		return strings.TrimSpace(s.Cron)
	case "hourly":
		return fmt.Sprintf("0 */%d * * *", s.Every)
	}
	hh, mm, _ := strings.Cut(s.Time, ":")
	h, _ := strconv.Atoi(hh)
	m, _ := strconv.Atoi(mm)
	days := "*"
	if s.Kind == "weekly" {
		sorted := slices.Clone(s.Days)
		slices.Sort(sorted)
		sorted = slices.Compact(sorted)
		parts := make([]string, len(sorted))
		for i, d := range sorted {
			parts[i] = strconv.Itoa(d)
		}
		days = strings.Join(parts, ",")
	}
	return fmt.Sprintf("%d %d * * %s", m, h, days)
}

func location(timezone string) (*time.Location, error) {
	if timezone == "" || timezone == "Local" {
		return nil, fmt.Errorf("invalid time zone %q", timezone)
	}
	return time.LoadLocation(timezone)
}

// Validate checks the time zone and the cron.
func Validate(s Schedule, timezone string) error {
	if err := s.check(); err != nil {
		return err
	}
	if _, err := location(timezone); err != nil {
		return apierr.New(422, "INVALID_TIMEZONE", "时区无效。")
	}
	// The time zone is the routine's, never the expression's.
	if _, err := parser.Parse(s.Cron5()); err != nil || strings.Contains(s.Cron5(), "TZ=") {
		return apierr.New(422, "INVALID_SCHEDULE", "cron 表达式无效。")
	}
	return nil
}

// NextRun is when the schedule fires next after after.
func NextRun(s Schedule, timezone string, after time.Time) (time.Time, error) {
	loc, err := location(timezone)
	if err != nil {
		return time.Time{}, err
	}
	schedule, err := parser.Parse(s.Cron5())
	if err != nil {
		return time.Time{}, err
	}
	return schedule.Next(after.In(loc)), nil
}

// Describe is the schedule in words.
func Describe(s Schedule) string {
	switch s.Kind {
	case "daily":
		return "每天 " + s.Time
	case "weekly":
		names := []rune("日一二三四五六")
		sorted := slices.Clone(s.Days)
		slices.Sort(sorted)
		sorted = slices.Compact(sorted)
		parts := make([]string, len(sorted))
		for i, d := range sorted {
			parts[i] = string(names[d])
		}
		return "每周" + strings.Join(parts, "、") + " " + s.Time
	case "hourly":
		if s.Every == 1 {
			return "每小时"
		}
		return fmt.Sprintf("每 %d 小时", s.Every)
	}
	return "cron " + s.Cron
}
