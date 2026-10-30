/**
 * Repo overlay: adds a personal instruction file for the repository a session
 * runs in, next to the repository's own AGENTS.md.
 *
 * The repository is named after its origin URL, which every worktree shares,
 * so the overlay follows the repo whatever the folder name or worktree depth.
 * Without an origin, the name of the main checkout folder is used.
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "repo-overlay";
const SETTINGS_KEY = "repoOverlay";
const GIT_TIMEOUT_MS = 2000;

export interface Config {
	dir: string;
	aliases: Record<string, string[]>;
}

export interface Repo {
	slug?: string;
	name: string;
}

export type Git = (args: string[], cwd: string) => Promise<string | undefined>;

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export function loadConfig(settingsPath = join(agentDir(), "settings.json")): Config {
	const fallback: Config = { dir: join(agentDir(), "repo-overlays"), aliases: {} };
	let raw: unknown;
	try {
		raw = (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)[SETTINGS_KEY];
	} catch {
		return fallback;
	}
	if (!raw || typeof raw !== "object") return fallback;
	const { dir, aliases } = raw as Partial<Config>;
	return {
		dir: typeof dir === "string" && dir ? expandHome(dir) : fallback.dir,
		aliases: aliases && typeof aliases === "object" ? aliases : {},
	};
}

export function repoFromUrl(url: string): Repo | undefined {
	let path = url.trim();
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(.*)$/i.exec(path);
	const scpLike = /^(?:[^@/]+@)?[^/:]+:(.+)$/.exec(path);
	if (withScheme) path = withScheme[1];
	else if (scpLike) path = scpLike[1];
	const segments = path.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
	const name = segments.at(-1);
	return name ? { slug: segments.join("/"), name } : undefined;
}

export function matches(pattern: string, value: string): boolean {
	const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
	return new RegExp(`^${source}$`, "i").test(value);
}

export function overlayName(repo: Repo, aliases: Config["aliases"]): string {
	const target = repo.slug ?? repo.name;
	for (const [alias, patterns] of Object.entries(aliases)) {
		if (Array.isArray(patterns) && patterns.some((pattern) => typeof pattern === "string" && matches(pattern, target))) {
			return alias;
		}
	}
	return repo.name;
}

export const git: Git = (args, cwd) =>
	new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
			resolve(error ? undefined : stdout.trim() || undefined);
		});
	});

export async function resolveRepo(cwd: string, run: Git = git): Promise<Repo | undefined> {
	const url = await run(["config", "--get", "remote.origin.url"], cwd);
	const fromUrl = url ? repoFromUrl(url) : undefined;
	if (fromUrl) return fromUrl;
	const commonDir = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	if (!commonDir) return undefined;
	const main = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
	return { name: basename(main).replace(/\.git$/, "") };
}

export default function repoOverlay(pi: ExtensionAPI) {
	let overlay: { name: string; path: string } | undefined;
	let status = "no overlay yet";
	let isStatusShown = false;
	let cached: { path: string; mtimeMs: number; content: string } | undefined;

	const read = (path: string): string | undefined => {
		try {
			const { mtimeMs } = statSync(path);
			if (cached?.path !== path || cached.mtimeMs !== mtimeMs) {
				cached = { path, mtimeMs, content: readFileSync(path, "utf8") };
			}
			return cached.content.trim() ? cached.content : undefined;
		} catch {
			cached = undefined;
			return undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		overlay = undefined;
		const repo = await resolveRepo(ctx.cwd);
		if (!repo) {
			status = "no overlay: the working directory is not in a git repository";
			return;
		}
		const config = loadConfig();
		const name = overlayName(repo, config.aliases);
		const path = join(config.dir, `${name}.md`);
		if (!read(path)) {
			status = `no overlay: ${path} is missing or empty`;
			return;
		}
		overlay = { name, path };
		status = `loaded ${path}`;
		ctx.ui.setStatus(EXTENSION_ID, `overlay: ${name}`);
		isStatusShown = true;
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!isStatusShown) return;
		isStatusShown = false;
		ctx.ui.setStatus(EXTENSION_ID, undefined);
	});

	pi.on("before_agent_start", (event) => {
		const current = overlay;
		if (!current) return;
		const files = event.systemPromptOptions.contextFiles;
		// A session without any context file runs that way on purpose (pi -nc,
		// subagents launched without them): the overlay stays out too.
		if (files.length === 0 || files.some((file) => file.path === current.path)) return;
		const content = read(current.path);
		if (content) files.push({ path: current.path, content });
	});

	pi.registerCommand(EXTENSION_ID, {
		description: "Show which repo overlay this session loaded",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Repo overlay: ${status}`, "info");
		},
	});
}
