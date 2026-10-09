package pg

import (
	"embed"
	"io/fs"
)

//go:embed migrations/*.sql
var embedded embed.FS

// framework is the tables the framework's own packages keep in every
// service's database.
var framework, _ = fs.Sub(embedded, "migrations")
