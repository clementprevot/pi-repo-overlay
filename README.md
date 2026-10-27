# Repo overlay

Pi extension that adds a personal instruction file for the repository a session runs in, next to that repository's own `AGENTS.md`. Use it for notes that are yours alone and do not belong in the shared file, such as how your machine runs the toolchain.

## How it works

When a session starts, the extension asks git for the origin URL of the repository and takes the name from it: `git@example.com:acme/widgets.git` gives `widgets`. Every worktree shares that URL, so the overlay applies whatever the checkout folder is called and however deep a worktree sits. A repository without an origin uses the name of its main checkout folder.

If `<dir>/<name>.md` exists, the extension adds it to the context files of the session, after the repository's own `AGENTS.md`. The model sees it as one more instruction file. The extension reads the file again when it changes, so an edit applies to the next prompt without a reload.

The footer shows `overlay: <name>`, and `/repo-overlay` tells you which file the session loaded, or why it loaded none.

## Configuration

In `~/.pi/agent/settings.json`:

```json
{
  "repoOverlay": {
    "dir": "~/notes/repos",
    "aliases": {
      "pi-extensions": ["acme/pi-*", "acme/tooling"]
    }
  }
}
```

- `dir`: the folder that holds the overlays, `~/.pi/agent/repo-overlays` by default
- `aliases`: overlay names mapped to `owner/repo` patterns, so several repositories can share one overlay

In a pattern, `*` matches any run of characters except a slash. When several aliases match, the first one wins.

## Install

```bash
pi install git:github.com/clementprevot/pi-repo-overlay
```

Then run `/reload`.

## Limitations

- the session must start inside the repository: a session started elsewhere gets no overlay
- a session gets one overlay, for the repository of its working directory
- a session without any context file (`pi --no-context-files`, or a subagent launched without them) gets no overlay either
- the extension reads only the global settings, so a project cannot point it at another folder

## Privacy and data

The extension runs two local git commands when a session starts and reads one file. It makes no network calls and stores nothing.

## Local development

```bash
npm install
npm test
npm run typecheck
pi -e .
```

## License

MIT
