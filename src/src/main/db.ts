import Database from "better-sqlite3";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Override with FOREST_RANGER_DATA_DIR so tests/scripts never touch the real DB.
const DATA_DIR =
	process.env.FOREST_RANGER_DATA_DIR || join(homedir(), ".forest-ranger");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, "forest-ranger.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
	CREATE TABLE IF NOT EXISTS projects (
		id             TEXT PRIMARY KEY,
		name           TEXT NOT NULL,
		path           TEXT NOT NULL UNIQUE,
		added_at       INTEGER NOT NULL,
		last_opened_at INTEGER,
		worktree_dir   TEXT
	);

	CREATE TABLE IF NOT EXISTS worktrees (
		id             TEXT PRIMARY KEY,
		project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		path           TEXT NOT NULL,
		last_opened_at INTEGER,
		created_at     INTEGER NOT NULL,
		UNIQUE(project_id, path)
	);

	CREATE TABLE IF NOT EXISTS project_commands (
		id         TEXT PRIMARY KEY,
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		label      TEXT NOT NULL,
		command    TEXT NOT NULL,
		dir        TEXT NOT NULL DEFAULT '',
		run_target TEXT NOT NULL DEFAULT 'in-app',
		sort       INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS integrations (
		type    TEXT PRIMARY KEY,
		enabled INTEGER NOT NULL DEFAULT 0,
		config  TEXT NOT NULL DEFAULT '{}'
	);
`);

// Migrate older DBs that predate added columns.
{
	const cmdCols = (
		db.prepare("PRAGMA table_info(project_commands)").all() as { name: string }[]
	).map((c) => c.name);
	if (!cmdCols.includes("dir")) {
		db.exec("ALTER TABLE project_commands ADD COLUMN dir TEXT NOT NULL DEFAULT ''");
	}
	if (!cmdCols.includes("run_target")) {
		db.exec(
			"ALTER TABLE project_commands ADD COLUMN run_target TEXT NOT NULL DEFAULT 'in-app'",
		);
	}

	const projCols = (
		db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]
	).map((c) => c.name);
	if (!projCols.includes("worktree_dir")) {
		db.exec("ALTER TABLE projects ADD COLUMN worktree_dir TEXT");
	}
}

// --- row shapes as stored ---

export type ProjectRow = {
	id: string;
	name: string;
	path: string;
	added_at: number;
	last_opened_at: number | null;
	worktree_dir: string | null;
};

export type WorktreeRow = {
	id: string;
	project_id: string;
	path: string;
	last_opened_at: number | null;
	created_at: number;
};

export type CommandRow = {
	id: string;
	project_id: string;
	label: string;
	command: string;
	dir: string;
	run_target: string;
	sort: number;
	created_at: number;
};

export type IntegrationRow = {
	type: string;
	enabled: number;
	config: string;
};

// --- prepared statements ---

const stmts = {
	listProjects: db.prepare(
		"SELECT * FROM projects ORDER BY COALESCE(last_opened_at, added_at) DESC",
	),
	getProject: db.prepare("SELECT * FROM projects WHERE id = ?"),
	getProjectByPath: db.prepare("SELECT * FROM projects WHERE path = ?"),
	insertProject: db.prepare(
		"INSERT INTO projects (id, name, path, added_at, last_opened_at) VALUES ($id, $name, $path, $addedAt, NULL)",
	),
	deleteProject: db.prepare("DELETE FROM projects WHERE id = $id"),
	touchProject: db.prepare(
		"UPDATE projects SET last_opened_at = $now WHERE id = $id",
	),
	setWorktreeDir: db.prepare(
		"UPDATE projects SET worktree_dir = $dir WHERE id = $id",
	),

	getWorktree: db.prepare("SELECT * FROM worktrees WHERE id = ?"),
	worktreesForProject: db.prepare("SELECT * FROM worktrees WHERE project_id = ?"),
	// Conflict on the natural key (project_id, path), not the surrogate id: the
	// id is derived from the path, so if the derivation ever changes we migrate
	// the existing row's id rather than crash on the UNIQUE(project_id, path)
	// constraint or orphan it under a stale id. last_opened_at/created_at are
	// preserved (only the id is rewritten).
	upsertWorktree: db.prepare(
		`INSERT INTO worktrees (id, project_id, path, last_opened_at, created_at)
		 VALUES ($id, $projectId, $path, NULL, $createdAt)
		 ON CONFLICT(project_id, path) DO UPDATE SET id = excluded.id`,
	),
	touchWorktree: db.prepare(
		"UPDATE worktrees SET last_opened_at = $now WHERE id = $id",
	),
	pruneWorktrees: db.prepare(
		"DELETE FROM worktrees WHERE project_id = $projectId AND path NOT IN (SELECT value FROM json_each($keepPaths))",
	),

	getCommand: db.prepare("SELECT * FROM project_commands WHERE id = ?"),
	commandsForProject: db.prepare(
		"SELECT * FROM project_commands WHERE project_id = ? ORDER BY sort, created_at",
	),
	maxCommandSort: db.prepare(
		"SELECT MAX(sort) AS max FROM project_commands WHERE project_id = ?",
	),
	insertCommand: db.prepare(
		`INSERT INTO project_commands (id, project_id, label, command, dir, run_target, sort, created_at)
		 VALUES ($id, $projectId, $label, $command, $dir, $runTarget, $sort, $createdAt)`,
	),
	updateCommand: db.prepare(
		"UPDATE project_commands SET label = $label, command = $command, dir = $dir, run_target = $runTarget WHERE id = $id",
	),
	deleteCommand: db.prepare("DELETE FROM project_commands WHERE id = $id"),

	listIntegrations: db.prepare("SELECT * FROM integrations"),
	getIntegration: db.prepare("SELECT * FROM integrations WHERE type = ?"),
	upsertIntegration: db.prepare(
		`INSERT INTO integrations (type, enabled, config) VALUES ($type, $enabled, $config)
		 ON CONFLICT(type) DO UPDATE SET enabled = $enabled, config = $config`,
	),
};

export const projectsRepo = {
	list: () => stmts.listProjects.all() as ProjectRow[],
	get: (id: string) => (stmts.getProject.get(id) as ProjectRow | undefined) ?? null,
	getByPath: (path: string) =>
		(stmts.getProjectByPath.get(path) as ProjectRow | undefined) ?? null,
	insert: (row: { id: string; name: string; path: string; addedAt: number }) =>
		stmts.insertProject.run({
			id: row.id,
			name: row.name,
			path: row.path,
			addedAt: row.addedAt,
		}),
	remove: (id: string) => stmts.deleteProject.run({ id }),
	touch: (id: string, now: number) => stmts.touchProject.run({ id, now }),
	setWorktreeDir: (id: string, dir: string) =>
		stmts.setWorktreeDir.run({ id, dir }),
};

export const worktreesRepo = {
	get: (id: string) =>
		(stmts.getWorktree.get(id) as WorktreeRow | undefined) ?? null,
	forProject: (projectId: string) =>
		stmts.worktreesForProject.all(projectId) as WorktreeRow[],
	upsert: (row: {
		id: string;
		projectId: string;
		path: string;
		createdAt: number;
	}) =>
		stmts.upsertWorktree.run({
			id: row.id,
			projectId: row.projectId,
			path: row.path,
			createdAt: row.createdAt,
		}),
	touch: (id: string, now: number) => stmts.touchWorktree.run({ id, now }),
	/** Remove db rows for worktrees that no longer exist in git. */
	prune: (projectId: string, keepPaths: string[]) =>
		stmts.pruneWorktrees.run({
			projectId,
			keepPaths: JSON.stringify(keepPaths),
		}),
};

export const commandsRepo = {
	get: (id: string) =>
		(stmts.getCommand.get(id) as CommandRow | undefined) ?? null,
	forProject: (projectId: string) =>
		stmts.commandsForProject.all(projectId) as CommandRow[],
	insert: (row: {
		id: string;
		projectId: string;
		label: string;
		command: string;
		dir: string;
		runTarget: string;
		createdAt: number;
	}) => {
		const max = (stmts.maxCommandSort.get(row.projectId) as { max: number | null })
			?.max;
		const sort = (max ?? -1) + 1;
		stmts.insertCommand.run({
			id: row.id,
			projectId: row.projectId,
			label: row.label,
			command: row.command,
			dir: row.dir,
			runTarget: row.runTarget,
			sort,
			createdAt: row.createdAt,
		});
	},
	update: (
		id: string,
		label: string,
		command: string,
		dir: string,
		runTarget: string,
	) => stmts.updateCommand.run({ id, label, command, dir, runTarget }),
	remove: (id: string) => stmts.deleteCommand.run({ id }),
};

export const integrationsRepo = {
	list: () => stmts.listIntegrations.all() as IntegrationRow[],
	get: (type: string) =>
		(stmts.getIntegration.get(type) as IntegrationRow | undefined) ?? null,
	upsert: (type: string, enabled: boolean, config: string) =>
		stmts.upsertIntegration.run({
			type,
			enabled: enabled ? 1 : 0,
			config,
		}),
};
