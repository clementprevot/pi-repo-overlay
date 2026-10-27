import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import repoOverlay, { loadConfig, matches, overlayName, repoFromUrl, resolveRepo } from "../index.ts";

const root = mkdtempSync(join(tmpdir(), "repo-overlay-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
}

function initRepo(path: string, origin?: string): void {
	mkdirSync(path, { recursive: true });
	git(path, "init", "--quiet");
	if (origin) git(path, "remote", "add", "origin", origin);
	git(path, "commit", "--quiet", "--allow-empty", "-m", "init");
}

test("repoFromUrl reads scp-like, ssh, https and local URLs", () => {
	assert.deepEqual(repoFromUrl("git@example.com:acme/widgets.git"), { slug: "acme/widgets", name: "widgets" });
	assert.deepEqual(repoFromUrl("https://example.com/acme/widgets"), { slug: "acme/widgets", name: "widgets" });
	assert.deepEqual(repoFromUrl("ssh://git@example.com:2222/acme/widgets.git/"), { slug: "acme/widgets", name: "widgets" });
	assert.deepEqual(repoFromUrl("https://example.com/group/sub/widgets.git"), { slug: "group/sub/widgets", name: "widgets" });
	assert.deepEqual(repoFromUrl("/srv/git/widgets.git"), { slug: "srv/git/widgets", name: "widgets" });
	assert.equal(repoFromUrl("   "), undefined);
});

test("matches treats * as any run of characters except a slash", () => {
	assert.equal(matches("acme/pi-*", "acme/pi-widgets"), true);
	assert.equal(matches("acme/pi-*", "ACME/pi-widgets"), true);
	assert.equal(matches("acme/pi-*", "acme/tools/pi-widgets"), false);
	assert.equal(matches("acme/tooling", "acme/tooling-extra"), false);
	assert.equal(matches("acme/a.b", "acme/aXb"), false);
});

test("overlayName prefers the first matching alias, then the repo name", () => {
	const aliases = { shared: ["acme/pi-*", "acme/tooling"], other: ["acme/*"] };
	assert.equal(overlayName({ slug: "acme/pi-widgets", name: "pi-widgets" }, aliases), "shared");
	assert.equal(overlayName({ slug: "acme/tooling", name: "tooling" }, aliases), "shared");
	assert.equal(overlayName({ slug: "acme/widgets", name: "widgets" }, aliases), "other");
	assert.equal(overlayName({ slug: "other/widgets", name: "widgets" }, aliases), "widgets");
	assert.equal(overlayName({ name: "local-only" }, aliases), "local-only");
});

test("loadConfig falls back to defaults and expands ~", () => {
	const missing = loadConfig(join(root, "missing.json"));
	assert.match(missing.dir, /repo-overlays$/);
	assert.deepEqual(missing.aliases, {});

	const settings = join(root, "settings.json");
	writeFileSync(settings, JSON.stringify({ repoOverlay: { dir: "~/notes/repos", aliases: { shared: ["acme/*"] } } }));
	assert.deepEqual(loadConfig(settings), { dir: join(homedir(), "notes/repos"), aliases: { shared: ["acme/*"] } });
});

test("resolveRepo names a deep worktree after the origin URL, not the folders", async () => {
	const main = join(root, "checkout-with-another-name");
	initRepo(main, "git@example.com:acme/widgets.git");
	const worktree = join(root, "worktrees", "a", "b", "c");
	git(main, "worktree", "add", "--quiet", worktree);
	assert.deepEqual(await resolveRepo(worktree), { slug: "acme/widgets", name: "widgets" });
});

test("resolveRepo falls back to the main checkout folder without an origin", async () => {
	const main = join(root, "local-only");
	initRepo(main);
	const worktree = join(root, "local-worktrees", "deep", "tree");
	git(main, "worktree", "add", "--quiet", worktree);
	assert.deepEqual(await resolveRepo(worktree), { name: "local-only" });
});

test("resolveRepo returns undefined outside a git repository", async () => {
	const plain = join(root, "plain");
	mkdirSync(plain);
	assert.equal(await resolveRepo(plain), undefined);
});

type Handler = (event: unknown, ctx: unknown) => unknown;

async function startSession(cwd: string, agentDir: string) {
	const handlers = new Map<string, Handler>();
	const statuses: Array<[string, string | undefined]> = [];
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler), registerCommand: () => {} };
	const ctx = { cwd, ui: { setStatus: (key: string, text?: string) => statuses.push([key, text]), notify: () => {} } };
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		repoOverlay(pi as never);
		await handlers.get("session_start")?.({}, ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
	const beforeAgentStart = (contextFiles: Array<{ path: string; content: string }>) =>
		handlers.get("before_agent_start")?.({ systemPromptOptions: { contextFiles } }, ctx);
	return { statuses, beforeAgentStart };
}

test("the extension adds the overlay to the context files once", async () => {
	const agentDir = join(root, "agent");
	const overlays = join(root, "overlays");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(overlays, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ repoOverlay: { dir: overlays } }));
	writeFileSync(join(overlays, "gadgets.md"), "Use the staging cluster.\n");
	const repo = join(root, "gadgets-checkout");
	initRepo(repo, "https://example.com/acme/gadgets.git");

	const session = await startSession(repo, agentDir);
	assert.deepEqual(session.statuses, [["repo-overlay", "overlay: gadgets"]]);

	const contextFiles = [{ path: "/repo/AGENTS.md", content: "Repo rules" }];
	session.beforeAgentStart(contextFiles);
	session.beforeAgentStart(contextFiles);
	assert.equal(contextFiles.length, 2);
	assert.equal(contextFiles[1].path, join(overlays, "gadgets.md"));
	assert.match(contextFiles[1].content, /staging cluster/);

	const noContextFiles: Array<{ path: string; content: string }> = [];
	session.beforeAgentStart(noContextFiles);
	assert.equal(noContextFiles.length, 0);
});

test("the extension stays silent when the repo has no overlay", async () => {
	const agentDir = join(root, "agent-empty");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ repoOverlay: { dir: join(root, "no-overlays") } }));
	const repo = join(root, "bare-checkout");
	initRepo(repo, "git@example.com:acme/bare.git");

	const session = await startSession(repo, agentDir);
	assert.deepEqual(session.statuses, []);
	const contextFiles = [{ path: "/repo/AGENTS.md", content: "Repo rules" }];
	session.beforeAgentStart(contextFiles);
	assert.equal(contextFiles.length, 1);
});
