import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Override with FOREST_RANGER_DATA_DIR so tests/scripts never touch the real DB.
const DATA_DIR =
	process.env.FOREST_RANGER_DATA_DIR || join(homedir(), ".forest-ranger");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, "forest-ranger.db"), {
	create: true,
});

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

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
`);

// Migrate older DBs that predate added columns.
{
	const cmdCols = db
		.query<{ name: string }, []>("PRAGMA table_info(project_commands)")
		.all()
		.map((c) => c.name);
	if (!cmdCols.includes("dir")) {
		db.exec("ALTER TABLE project_commands ADD COLUMN dir TEXT NOT NULL DEFAULT ''");
	}
	if (!cmdCols.includes("run_target")) {
		db.exec(
			"ALTER TABLE project_commands ADD COLUMN run_target TEXT NOT NULL DEFAULT 'in-app'",
		);
	}

	const projCols = db
		.query<{ name: string }, []>("PRAGMA table_info(projects)")
		.all()
		.map((c) => c.name);
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

// --- prepared statements ---

const stmts = {
	listProjects: db.query<ProjectRow, []>(
		"SELECT * FROM projects ORDER BY COALESCE(last_opened_at, added_at) DESC",
	),
	getProject: db.query<ProjectRow, [string]>(
		"SELECT * FROM projects WHERE id = ?",
	),
	getProjectByPath: db.query<ProjectRow, [string]>(
		"SELECT * FROM projects WHERE path = ?",
	),
	insertProject: db.query(
		"INSERT INTO projects (id, name, path, added_at, last_opened_at) VALUES ($id, $name, $path, $addedAt, NULL)",
	),
	deleteProject: db.query("DELETE FROM projects WHERE id = $id"),
	touchProject: db.query(
		"UPDATE projects SET last_opened_at = $now WHERE id = $id",
	),
	setWorktreeDir: db.query(
		"UPDATE projects SET worktree_dir = $dir WHERE id = $id",
	),

	getWorktree: db.query<WorktreeRow, [string]>(
		"SELECT * FROM worktrees WHERE id = ?",
	),
	worktreesForProject: db.query<WorktreeRow, [string]>(
		"SELECT * FROM worktrees WHERE project_id = ?",
	),
	upsertWorktree: db.query(
		`INSERT INTO worktrees (id, project_id, path, last_opened_at, created_at)
		 VALUES ($id, $projectId, $path, NULL, $createdAt)
		 ON CONFLICT(id) DO NOTHING`,
	),
	touchWorktree: db.query(
		"UPDATE worktrees SET last_opened_at = $now WHERE id = $id",
	),
	pruneWorktrees: db.query(
		"DELETE FROM worktrees WHERE project_id = $projectId AND path NOT IN (SELECT value FROM json_each($keepPaths))",
	),

	getCommand: db.query<CommandRow, [string]>(
		"SELECT * FROM project_commands WHERE id = ?",
	),
	commandsForProject: db.query<CommandRow, [string]>(
		"SELECT * FROM project_commands WHERE project_id = ? ORDER BY sort, created_at",
	),
	maxCommandSort: db.query<{ max: number | null }, [string]>(
		"SELECT MAX(sort) AS max FROM project_commands WHERE project_id = ?",
	),
	insertCommand: db.query(
		`INSERT INTO project_commands (id, project_id, label, command, dir, run_target, sort, created_at)
		 VALUES ($id, $projectId, $label, $command, $dir, $runTarget, $sort, $createdAt)`,
	),
	updateCommand: db.query(
		"UPDATE project_commands SET label = $label, command = $command, dir = $dir, run_target = $runTarget WHERE id = $id",
	),
	deleteCommand: db.query("DELETE FROM project_commands WHERE id = $id"),
};

export const projectsRepo = {
	list: () => stmts.listProjects.all(),
	get: (id: string) => stmts.getProject.get(id) ?? null,
	getByPath: (path: string) => stmts.getProjectByPath.get(path) ?? null,
	insert: (row: { id: string; name: string; path: string; addedAt: number }) =>
		stmts.insertProject.run({
			$id: row.id,
			$name: row.name,
			$path: row.path,
			$addedAt: row.addedAt,
		} as never),
	remove: (id: string) => stmts.deleteProject.run({ $id: id } as never),
	touch: (id: string, now: number) =>
		stmts.touchProject.run({ $id: id, $now: now } as never),
	setWorktreeDir: (id: string, dir: string) =>
		stmts.setWorktreeDir.run({ $id: id, $dir: dir } as never),
};

export const worktreesRepo = {
	get: (id: string) => stmts.getWorktree.get(id) ?? null,
	forProject: (projectId: string) => stmts.worktreesForProject.all(projectId),
	upsert: (row: {
		id: string;
		projectId: string;
		path: string;
		createdAt: number;
	}) =>
		stmts.upsertWorktree.run({
			$id: row.id,
			$projectId: row.projectId,
			$path: row.path,
			$createdAt: row.createdAt,
		} as never),
	touch: (id: string, now: number) =>
		stmts.touchWorktree.run({ $id: id, $now: now } as never),
	/** Remove db rows for worktrees that no longer exist in git. */
	prune: (projectId: string, keepPaths: string[]) =>
		stmts.pruneWorktrees.run({
			$projectId: projectId,
			$keepPaths: JSON.stringify(keepPaths),
		} as never),
};

export const commandsRepo = {
	get: (id: string) => stmts.getCommand.get(id) ?? null,
	forProject: (projectId: string) => stmts.commandsForProject.all(projectId),
	insert: (row: {
		id: string;
		projectId: string;
		label: string;
		command: string;
		dir: string;
		runTarget: string;
		createdAt: number;
	}) => {
		const sort = (stmts.maxCommandSort.get(row.projectId)?.max ?? -1) + 1;
		stmts.insertCommand.run({
			$id: row.id,
			$projectId: row.projectId,
			$label: row.label,
			$command: row.command,
			$dir: row.dir,
			$runTarget: row.runTarget,
			$sort: sort,
			$createdAt: row.createdAt,
		} as never);
	},
	update: (
		id: string,
		label: string,
		command: string,
		dir: string,
		runTarget: string,
	) =>
		stmts.updateCommand.run({
			$id: id,
			$label: label,
			$command: command,
			$dir: dir,
			$runTarget: runTarget,
		} as never),
	remove: (id: string) => stmts.deleteCommand.run({ $id: id } as never),
};
