# TodoMark (VS Code Extension)

Open a Markdown file as a focused TODO application with dual rendering modes.

## Command

- `TodoMark: Open`

## What it does

- Reads the currently active `.md` file.
- Finds Markdown todos in the format:
  - `- [ ] pending task`
  - `- [x] completed task`
- Opens a styled webview app with an `Only Todo` toggle:
  - `Only Todo` ON: focused todo mode with circular checkbox visuals and `all` / `pending` / `completed` filters.
  - `Only Todo` OFF: full markdown rendering (headings, blockquotes, tables, highlight, emoji, sub/sup, LaTeX, Mermaid diagrams).
- Keeps markdown task checkboxes clickable in both modes with rounded checkbox UI.
- Persists `Only Todo` and active filter in webview state.
- Auto-refreshes when the markdown document changes.

## Run locally

1. Open this folder in VS Code.
2. Run `npm install`.
3. Press `F5` to launch an Extension Development Host.
4. In the new VS Code window, open any markdown file.
5. Press `Cmd/Ctrl + Shift + P`.
6. Run: `TodoMark: Open`.

## Example markdown

```md
# Today

- [ ] Write release notes
- [x] Respond to customer email
- [ ] Clean up backlog items
```

## Author

- Chirag Lathiya
- contact@chiraglathiya.com
