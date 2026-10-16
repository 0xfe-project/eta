/**
 * The database as a cordis service: `inject: ["db"]` is how a module gets at its tables.
 *
 * The handle is opened and migrated before the service is constructed (that work is async, and a
 * constructor is not), so by the time anything can inject this, the schema is there.
 */
import type { Database } from "bun:sqlite";
import type { Context } from "cordis";
import { Service } from "cordis";
import { schemaVersion } from "./migrations";

export interface DbServiceOptions {
  /** Where the file is, for a log line or a backup script. */
  path: string;
  handle: Database;
  /** The migrations this run applied; empty when the database was already up to date. */
  applied: readonly string[];
}

export class DbService extends Service {
  static readonly provide = "db";

  /** The file. */
  readonly path: string;
  /** The open handle. Tables are the modules' business; this is only the connection. */
  readonly handle: Database;
  /** What this run applied — a supervisor wants to see an empty list the second time. */
  readonly applied: readonly string[];

  constructor(ctx: Context, options: DbServiceOptions) {
    super(ctx, "db");
    this.path = options.path;
    this.handle = options.handle;
    this.applied = options.applied;
  }

  /**
   * The last migration that ran. Own arrow property, not a prototype method: cordis hands out
   * a *view* of a service, and a prototype method on that view resolves `this` to the view.
   */
  readonly schema: () => string | undefined = () => schemaVersion(this.handle);
}
