// Package config reads a service's settings from the environment into a
// struct whose fields declare where each comes from:
//
//	type Config struct {
//		Addr    string `env:"AXP_API_ADDR" default:":8000"`
//		NATSURL string `env:"AXP_NATS_URL" dev:"nats://nats.axp-dev.svc.cluster.local:4222" prod:"nats://nats.axp.svc.cluster.local:4222"`
//	}
//
// A set variable wins; otherwise the field gets `dev` in development
// (AXP_DEV=true, which only scripts/dev.sh sets) or `prod` in production,
// then `default`. Development's defaults are the cluster's development services or
// loopback; production's are the cluster's Services (deploy/k3s). Fields are
// strings, bools, ints or durations.
package config

import (
	"fmt"
	"os"
	"reflect"
	"strconv"
	"time"
)

// Dev reports whether this is development.
func Dev() bool { return os.Getenv("AXP_DEV") == "true" }

// Load reads T from the environment.
func Load[T any]() (T, error) {
	var c T
	value := reflect.ValueOf(&c).Elem()
	if value.Kind() != reflect.Struct {
		return c, fmt.Errorf("config: %T is not a struct", c)
	}
	environment := "prod"
	if Dev() {
		environment = "dev"
	}
	for i := range value.NumField() {
		field := value.Type().Field(i)
		name := field.Tag.Get("env")
		if name == "" {
			continue
		}
		raw, ok := os.LookupEnv(name)
		if !ok || raw == "" {
			raw, ok = field.Tag.Lookup(environment)
		}
		if !ok {
			raw = field.Tag.Get("default")
		}
		if raw == "" {
			continue
		}
		if err := set(value.Field(i), raw); err != nil {
			return c, fmt.Errorf("config: %s: %w", name, err)
		}
	}
	return c, nil
}

var durationType = reflect.TypeFor[time.Duration]()

func set(field reflect.Value, raw string) error {
	switch {
	case field.Type() == durationType:
		d, err := time.ParseDuration(raw)
		if err != nil {
			return err
		}
		field.SetInt(int64(d))
	case field.Kind() == reflect.String:
		field.SetString(raw)
	case field.Kind() == reflect.Bool:
		b, err := strconv.ParseBool(raw)
		if err != nil {
			return err
		}
		field.SetBool(b)
	case field.Kind() == reflect.Int:
		n, err := strconv.Atoi(raw)
		if err != nil {
			return err
		}
		field.SetInt(int64(n))
	default:
		return fmt.Errorf("unsupported type %s", field.Type())
	}
	return nil
}
