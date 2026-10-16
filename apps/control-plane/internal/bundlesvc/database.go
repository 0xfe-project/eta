package bundlesvc

import (
	"context"
	"net/url"
	"strings"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/jackc/pgx/v5"
)

// database makes sure the bundle has its database and role on the control
// plane's server, named after the control plane's database and the bundle
// (axp_bundle_memory), with pgvector, and returns its URL as the service
// reaches it (the server is on the host's network).
func (r *Reconciler) database(ctx context.Context, bundle string) (string, error) {
	admin, err := url.Parse(r.DatabaseURL)
	if err != nil {
		return "", err
	}
	name := strings.TrimPrefix(admin.Path, "/") + "_bundle_" + strings.ReplaceAll(bundle, "-", "_")
	password := auth.BundleSecret(r.Secret, "database:"+bundle)
	conn, err := pgx.Connect(ctx, r.DatabaseURL)
	if err != nil {
		return "", err
	}
	defer conn.Close(context.Background())
	role := pgx.Identifier{name}.Sanitize()
	var exists bool
	if err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)", name).Scan(&exists); err != nil {
		return "", err
	}
	verb := "CREATE"
	if exists {
		verb = "ALTER"
	}
	// The password is derived, so setting it again changes nothing.
	if _, err := conn.Exec(ctx, verb+" ROLE "+role+" LOGIN PASSWORD '"+password+"'"); err != nil {
		return "", err
	}
	if err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)", name).Scan(&exists); err != nil {
		return "", err
	}
	if !exists {
		if _, err := conn.Exec(ctx, "CREATE DATABASE "+role+" OWNER "+role); err != nil {
			return "", err
		}
	}
	own := *admin
	own.Path = "/" + name
	db, err := pgx.Connect(ctx, own.String())
	if err != nil {
		return "", err
	}
	defer db.Close(context.Background())
	if _, err := db.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS vector"); err != nil {
		return "", err
	}
	own.User = url.UserPassword(name, password)
	if port := own.Port(); port != "" {
		own.Host = r.Host + ":" + port
	} else {
		own.Host = r.Host
	}
	return own.String(), nil
}
