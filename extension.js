const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const MarkdownIt = require("markdown-it");
const markdownItTaskLists = require("markdown-it-task-lists");
const markdownItMark = require("markdown-it-mark");
const markdownItSub = require("markdown-it-sub");
const markdownItSup = require("markdown-it-sup");
const markdownItTexmath = require("markdown-it-texmath");
const markdownItEmoji = require("markdown-it-emoji");
const katex = require("katex");

const emojiPlugin = markdownItEmoji.full || markdownItEmoji;
const TODO_TASK_PATTERN = /^(\s*(?:>\s*)*-\s\[)( |x|X)(\]\s+)(.*)$/;
const THEME_PREFERENCE_KEY = "todomark.themePreference";
const DEFAULT_THEME_PREFERENCE = Object.freeze({
  mode: "light",
  variant: "gradient",
  plainIndex: 0,
  gradientIndex: 0
});

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const command = vscode.commands.registerCommand(
    "todomark.open",
    async () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor || !isMarkdownDocument(editor.document)) {
        vscode.window.showWarningMessage(
          "Open a Markdown (.md) file first to launch TodoMark."
        );
        return;
      }

      const document = editor.document;
      let themePreference = normalizeThemePreference(
        context.globalState.get(THEME_PREFERENCE_KEY)
      );
      const panel = vscode.window.createWebviewPanel(
        "todomarkApplication",
        formatDisplayFileName(document.fileName),
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          localResourceRoots: [context.extensionUri]
        }
      );

      const markdownRenderer = createMarkdownRenderer();
      const katexCssUri = toWebviewAssetUri(
        panel.webview,
        context.extensionUri,
        "node_modules",
        "katex",
        "dist",
        "katex.min.css"
      );
      const texmathCssUri = toWebviewAssetUri(
        panel.webview,
        context.extensionUri,
        "node_modules",
        "markdown-it-texmath",
        "css",
        "texmath.css"
      );
      const mermaidScriptUri = toWebviewAssetUri(
        panel.webview,
        context.extensionUri,
        "media",
        "mermaid.min.js"
      );

      const updatePanel = () => {
        const markdown = document.getText();
        const tasks = parseMarkdownTodos(markdown);
        const markdownHtml = markdownRenderer.render(markdown);

        panel.webview.html = getWebviewHtml({
          filePath: document.fileName,
          tasks,
          markdownHtml,
          katexCssUri,
          texmathCssUri,
          mermaidScriptUri,
          initialThemePreference: themePreference
        });
      };

      updatePanel();

      let updateTimer = null;
      let skipNextInternalRefresh = false;
      let suppressRefreshUntil = 0;
      const schedulePanelUpdate = (delayMs = 120) => {
        if (updateTimer) {
          clearTimeout(updateTimer);
        }

        updateTimer = setTimeout(() => {
          if (panel.visible) {
            updatePanel();
          }
        }, delayMs);
      };

      const messageSubscription = panel.webview.onDidReceiveMessage(
        async (message) => {
          if (!message || typeof message.type !== "string") {
            return;
          }

          if (message.type === "saveThemePreference") {
            themePreference = normalizeThemePreference(message.preference);
            await context.globalState.update(
              THEME_PREFERENCE_KEY,
              themePreference
            );
            return;
          }

          if (message.type !== "toggleTask") {
            return;
          }

          const targetDocument =
            vscode.workspace.textDocuments.find(
              (entry) => entry.uri.toString() === document.uri.toString()
            ) || document;

          const lineNumber = Number(message.lineNumber);
          if (
            !Number.isInteger(lineNumber) ||
            lineNumber < 0 ||
            lineNumber >= targetDocument.lineCount
          ) {
            vscode.window.showWarningMessage(
              "Could not toggle todo: invalid task line."
            );
            return;
          }

          const line = targetDocument.lineAt(lineNumber);
          const match = line.text.match(TODO_TASK_PATTERN);
          if (!match) {
            vscode.window.showWarningMessage(
              "Could not toggle todo: line is no longer a markdown task."
            );
            return;
          }

          const nextMarker = match[2].toLowerCase() === "x" ? " " : "x";
          const markerOffset = match[1].length;
          const markerStart = line.range.start.translate(0, markerOffset);
          const markerEnd = markerStart.translate(0, 1);

          skipNextInternalRefresh = true;
          suppressRefreshUntil = Date.now() + 900;

          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            targetDocument.uri,
            new vscode.Range(markerStart, markerEnd),
            nextMarker
          );

          const applied = await vscode.workspace.applyEdit(edit);
          if (!applied) {
            vscode.window.showWarningMessage(
              "Could not toggle todo: edit was not applied."
            );
            skipNextInternalRefresh = false;
            suppressRefreshUntil = 0;
            return;
          }

          panel.webview.postMessage({
            type: "taskToggled",
            lineNumber,
            completed: nextMarker === "x"
          });

          const saved = await targetDocument.save();
          if (!saved) {
            vscode.window.showWarningMessage(
              "Todo toggled, but the markdown file could not be saved automatically."
            );
          }
        }
      );

      const changeSubscription = vscode.workspace.onDidChangeTextDocument(
        (event) => {
          if (event.document.uri.toString() === document.uri.toString()) {
            if (skipNextInternalRefresh) {
              skipNextInternalRefresh = false;
              return;
            }
            if (Date.now() < suppressRefreshUntil) {
              return;
            }
            schedulePanelUpdate();
          }
        }
      );

      const viewStateSubscription = panel.onDidChangeViewState((event) => {
        if (event.webviewPanel.visible) {
          schedulePanelUpdate(0);
        }
      });

      panel.onDidDispose(() => {
        if (updateTimer) {
          clearTimeout(updateTimer);
        }
        messageSubscription.dispose();
        changeSubscription.dispose();
        viewStateSubscription.dispose();
      });
    }
  );

  context.subscriptions.push(command);
}

/**
 * @param {vscode.TextDocument} document
 */
function isMarkdownDocument(document) {
  return (
    document.languageId === "markdown" ||
    document.fileName.toLowerCase().endsWith(".md")
  );
}

function createMarkdownRenderer() {
  const renderer = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true
  });

  renderer.use(markdownItTaskLists);
  renderer.use(markdownItMark);
  renderer.use(emojiPlugin);
  renderer.use(markdownItSub);
  renderer.use(markdownItSup);
  renderer.use(markdownItTexmath, {
    engine: katex,
    delimiters: ["dollars", "beg_end"],
    katexOptions: {
      throwOnError: false
    }
  });

  return renderer;
}

/**
 * @param {vscode.Webview} webview
 * @param {vscode.Uri} extensionUri
 * @param {...string} segments
 */
function toWebviewAssetUri(webview, extensionUri, ...segments) {
  const assetUri = vscode.Uri.joinPath(extensionUri, ...segments);
  if (!fs.existsSync(assetUri.fsPath)) {
    return null;
  }

  return webview.asWebviewUri(assetUri).toString();
}

/**
 * @param {string} filePath
 */
function formatDisplayFileName(filePath) {
  const baseName = path.basename(filePath, path.extname(filePath));
  const normalized = baseName.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const fallback = path.basename(filePath);
  const source = normalized || fallback;

  return source
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * @param {unknown} value
 */
function normalizeThemePreference(value) {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_THEME_PREFERENCE };
  }

  const candidate = /** @type {Record<string, unknown>} */ (value);
  const mode = candidate.mode === "dark" ? "dark" : "light";
  const variant = candidate.variant === "plain" ? "plain" : "gradient";
  const plainIndex = Number.isInteger(candidate.plainIndex)
    ? Math.max(0, /** @type {number} */ (candidate.plainIndex))
    : DEFAULT_THEME_PREFERENCE.plainIndex;
  const gradientIndex = Number.isInteger(candidate.gradientIndex)
    ? Math.max(0, /** @type {number} */ (candidate.gradientIndex))
    : DEFAULT_THEME_PREFERENCE.gradientIndex;

  return {
    mode,
    variant,
    plainIndex,
    gradientIndex
  };
}

/**
 * @param {string} markdown
 */
function parseMarkdownTodos(markdown) {
  const lines = markdown.split(/\r?\n/);
  /** @type {{ lineNumber: number; text: string; completed: boolean }[]} */
  const tasks = [];

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    const match = line.match(TODO_TASK_PATTERN);
    if (!match) {
      continue;
    }

    tasks.push({
      lineNumber,
      completed: match[2].toLowerCase() === "x",
      text: match[4]
    });
  }

  return tasks;
}

/**
 * @param {string} value
 */
function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * @param {{
 *   filePath: string;
 *   tasks: { lineNumber: number; text: string; completed: boolean }[];
 *   markdownHtml: string;
 *   katexCssUri: string | null;
 *   texmathCssUri: string | null;
 *   mermaidScriptUri: string | null;
 *   initialThemePreference: {
 *     mode: "light" | "dark";
 *     variant: "plain" | "gradient";
 *     plainIndex: number;
 *     gradientIndex: number;
 *   };
 * }} data
 */
function getWebviewHtml(data) {
  const safeDisplayName = escapeHtml(formatDisplayFileName(data.filePath));
  const safeTasks = data.tasks.map((task) => ({
    lineNumber: task.lineNumber,
    text: escapeHtml(task.text),
    completed: task.completed
  }));
  const safeThemePreference = normalizeThemePreference(data.initialThemePreference);
  const katexCssLink = data.katexCssUri
    ? `<link rel="stylesheet" href="${data.katexCssUri}" />`
    : "";
  const texmathCssLink = data.texmathCssUri
    ? `<link rel="stylesheet" href="${data.texmathCssUri}" />`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeDisplayName}</title>
    ${katexCssLink}
    ${texmathCssLink}
    <style>
      :root {
        --bg-layer-1: #fff6fb;
        --bg-layer-2: #f2f8ff;
        --bg-layer-3: #f3fff8;
        --background-overlay-1: rgba(222, 121, 169, 0.22);
        --background-overlay-2: rgba(125, 169, 222, 0.2);
        --surface: rgba(255, 255, 255, 0.74);
        --surface-strong: rgba(255, 255, 255, 0.92);
        --border: rgba(88, 103, 130, 0.24);
        --text-main: #27344d;
        --text-dim: #66758f;
        --accent: #de79a9;
        --accent-strong: #c95d90;
        --ok: #78c79d;
        --link: #b44c83;
        --shadow: 0 18px 40px rgba(72, 88, 120, 0.2);
        --filter-bg: rgba(88, 103, 130, 0.08);
        --slider-off: rgba(88, 103, 130, 0.16);
        --slider-on: rgba(222, 121, 169, 0.82);
        --slider-knob: #ffffff;
        --quote-bg: rgba(222, 121, 169, 0.16);
        --quote-border: rgba(201, 93, 144, 0.7);
        --table-head-bg: rgba(88, 103, 130, 0.1);
        --code-bg: rgba(46, 59, 86, 0.92);
        --inline-code-bg: rgba(88, 103, 130, 0.16);
        --card-glow: rgba(201, 93, 144, 0.36);
        --pulse: rgba(201, 93, 144, 0.3);
        --radial-bg: rgba(255, 255, 255, 0.95);
        --radial-border: rgba(88, 103, 130, 0.3);
        --trigger-fill: #de79a9;
        --mode-pill-bg: rgba(88, 103, 130, 0.1);
        --swatch-size: 30px;
        --radial-size: 224px;
        --radial-center-x: 206px;
        --radial-center-y: 14px;
        --radial-angle-start: 8;
        --radial-angle-end: 86;
        --scroll-shadow: rgba(31, 42, 64, 0.3);
      }

      * {
        box-sizing: border-box;
      }

      [hidden] {
        display: none !important;
      }

      body {
        position: relative;
        margin: 0;
        min-height: 100vh;
        color: var(--text-main);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at 10% 10%, var(--background-overlay-1), transparent 36%),
          radial-gradient(circle at 80% 20%, var(--background-overlay-2), transparent 40%),
          linear-gradient(135deg, var(--bg-layer-1), var(--bg-layer-2) 52%, var(--bg-layer-3));
        padding: 24px;
        transition:
          background 420ms cubic-bezier(0.2, 0.8, 0.2, 1),
          color 240ms ease;
      }

      body::before {
        content: "";
        position: fixed;
        inset: -20vmax;
        pointer-events: none;
        background: radial-gradient(circle at 85% 12%, var(--pulse), transparent 38%);
        opacity: 0;
        transform: scale(0.94);
      }

      body.theme-animate::before {
        animation: backgroundPulse 520ms cubic-bezier(0.2, 0.8, 0.2, 1);
      }

      .card {
        position: relative;
        max-width: 1024px;
        margin: 0 auto;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 16px;
        backdrop-filter: blur(6px);
        overflow: hidden;
        box-shadow: var(--shadow);
        transition:
          background 340ms cubic-bezier(0.2, 0.8, 0.2, 1),
          border-color 240ms ease,
          box-shadow 340ms ease;
      }

      .card::after {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: radial-gradient(circle at 95% 0%, var(--card-glow), transparent 36%);
        opacity: 0;
        transition: opacity 260ms ease;
      }

      body.theme-animate .card::after {
        opacity: 1;
      }

      .header {
        padding: 20px 24px 14px;
        border-bottom: 1px solid var(--border);
        transition: border-color 240ms ease;
      }

      .header-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 14px;
      }

      .title {
        margin: 0;
        font-size: 1.35rem;
      }

      .header-controls {
        display: inline-flex;
        align-items: center;
        gap: 12px;
      }

      .theme-picker {
        position: relative;
        display: inline-flex;
        align-items: center;
      }

      .theme-trigger {
        position: relative;
        width: 36px;
        height: 36px;
        border: none;
        border-radius: 50%;
        padding: 0;
        cursor: pointer;
        background: transparent;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: transform 180ms ease;
      }

      .theme-trigger:hover {
        transform: translateY(-1px);
      }

      .theme-trigger:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      .theme-trigger::before {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 2px solid var(--radial-border);
        background:
          conic-gradient(
            from 145deg,
            rgba(255, 255, 255, 0.16),
            rgba(255, 255, 255, 0) 46%,
            rgba(255, 255, 255, 0.12) 74%,
            rgba(255, 255, 255, 0.18)
          );
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
      }

      .theme-trigger-fill {
        position: absolute;
        inset: 6px;
        border-radius: 50%;
        background: var(--trigger-fill);
        border: 1px solid rgba(255, 255, 255, 0.55);
      }

      .theme-radial {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        width: var(--radial-size);
        height: var(--radial-size);
        background: var(--radial-bg);
        border: 1px solid var(--radial-border);
        border-radius: 14px 14px 14px 100%;
        backdrop-filter: blur(8px);
        box-shadow: 0 18px 40px rgba(19, 28, 46, 0.24);
        overflow: hidden;
        z-index: 30;
        opacity: 0;
        transform: translateY(-8px) scale(0.96);
        pointer-events: none;
        transition:
          opacity 160ms ease,
          transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1),
          background 220ms ease,
          border-color 220ms ease;
      }

      .theme-radial.open {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }

      .radial-layer {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }

      .radial-layer-scrollable {
        cursor: ns-resize;
      }

      .radial-separator {
        position: absolute;
        width: 164px;
        height: 164px;
        left: calc(var(--radial-center-x) - 82px);
        top: calc(var(--radial-center-y) - 82px);
        border-left: 1px solid var(--radial-border);
        border-bottom: 1px solid var(--radial-border);
        border-radius: 50%;
        pointer-events: none;
        opacity: 0.9;
      }

      .layer-fade {
        position: absolute;
        width: 72px;
        height: calc(var(--swatch-size) + 10px);
        border-radius: 999px;
        pointer-events: none;
        background: linear-gradient(90deg, var(--scroll-shadow), rgba(0, 0, 0, 0));
        opacity: 0.96;
        filter: blur(2px);
        transform-origin: center center;
      }

      .radial-swatch {
        position: absolute;
        width: var(--swatch-size);
        height: var(--swatch-size);
        border-radius: 50%;
        border: 1px solid var(--radial-border);
        background: var(--swatch-fill);
        padding: 0;
        margin: 0;
        cursor: pointer;
        box-shadow: 0 8px 18px rgba(26, 34, 56, 0.2);
        transition:
          transform 240ms cubic-bezier(0.22, 1.22, 0.32, 1),
          border-color 180ms ease,
          box-shadow 180ms ease;
        pointer-events: auto;
        --swatch-scale: 1;
        transform: scale(var(--swatch-scale));
      }

      .palette-swatch.swatch-bounce:not(.swatch-peek) {
        animation: swatchBounce 280ms cubic-bezier(0.22, 1.22, 0.32, 1);
      }

      .radial-swatch:hover {
        transform: scale(calc(var(--swatch-scale) + 0.06));
      }

      .radial-swatch:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      .radial-swatch.active {
        border-color: var(--accent-strong);
        box-shadow:
          0 0 0 2px rgba(255, 255, 255, 0.78),
          0 0 0 4px rgba(0, 0, 0, 0.08),
          0 10px 20px rgba(14, 19, 34, 0.28);
        transform: scale(calc(var(--swatch-scale) + 0.07));
      }

      .radial-swatch.swatch-peek {
        opacity: 0.5;
        pointer-events: none;
        box-shadow: 0 5px 12px rgba(26, 34, 56, 0.14);
        filter: saturate(0.9);
      }

      .mode-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 0;
        color: transparent;
        text-indent: -9999px;
        overflow: hidden;
        box-shadow:
          inset 0 0 0 1px rgba(255, 255, 255, 0.26),
          0 8px 18px rgba(26, 34, 56, 0.24);
        z-index: 3;
      }

      .mode-button[data-mode="dark"] {
        --swatch-fill: linear-gradient(135deg, #273149 0%, #1a2234 56%, #171d2a 100%);
      }

      .mode-button[data-mode="light"] {
        --swatch-fill: linear-gradient(135deg, #fff9ff 0%, #f4f7ff 50%, #f3fffa 100%);
      }

      .only-todo-control {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        color: var(--text-main);
        font-size: 0.9rem;
        user-select: none;
        cursor: pointer;
      }

      .switch {
        position: relative;
        display: inline-block;
        width: 46px;
        height: 24px;
      }

      .switch input {
        opacity: 0;
        width: 0;
        height: 0;
        position: absolute;
      }

      .slider {
        position: absolute;
        inset: 0;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--slider-off);
        transition:
          border-color 180ms ease,
          background 180ms ease;
      }

      .slider::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: var(--slider-knob);
        transition: transform 180ms ease;
      }

      .switch input:checked + .slider {
        border-color: var(--accent);
        background: var(--slider-on);
      }

      .switch input:checked + .slider::after {
        transform: translateX(22px);
        background: var(--surface-strong);
      }

      .switch input:focus-visible + .slider {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      .toolbar {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 16px 24px;
        align-items: flex-start;
        border-bottom: 1px solid var(--border);
        transition:
          border-color 240ms ease,
          background 240ms ease;
      }

      .filter-row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }

      .filter {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--border);
        background: var(--filter-bg);
        color: var(--text-main);
        border-radius: 999px;
        padding: 8px 14px;
        font-size: 0.92rem;
        font-weight: 600;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
        transition:
          background-color 140ms ease,
          border-color 140ms ease,
          color 140ms ease,
          box-shadow 160ms ease;
      }

      .filter.active {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--surface-strong);
        box-shadow: 0 10px 22px rgba(33, 51, 82, 0.12);
      }

      .filter:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      .content {
        padding: 10px 0 8px;
      }

      .empty {
        margin: 24px;
        color: var(--text-dim);
      }

      .todo-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .todo-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 24px;
        border-bottom: 1px solid rgba(88, 103, 130, 0.14);
        transition:
          border-color 220ms ease,
          color 220ms ease;
      }

      .todo-item:last-child {
        border-bottom: none;
      }

      .todo-toggle {
        appearance: none;
        border: none;
        background: transparent;
        padding: 0;
        margin: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        border-radius: 999px;
      }

      .todo-toggle:hover .checkbox {
        border-color: var(--accent);
      }

      .todo-toggle:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      .checkbox {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        border: 2px solid var(--text-dim);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      .todo-item.completed .checkbox {
        border-color: var(--ok);
        background: rgba(128, 207, 164, 0.24);
      }

      .checkbox::after {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: transparent;
      }

      .todo-item.completed .checkbox::after {
        background: var(--ok);
      }

      .todo-text {
        font-size: 0.98rem;
        cursor: pointer;
      }

      .todo-item.completed .todo-text {
        color: var(--text-dim);
        text-decoration: line-through;
        text-decoration-color: rgba(88, 103, 130, 0.35);
      }

      .stats {
        padding: 0;
        color: var(--text-dim);
        font-size: 0.86rem;
      }

      .markdown-content {
        padding: 16px 24px 24px;
        line-height: 1.7;
        overflow-wrap: anywhere;
      }

      .markdown-content h1,
      .markdown-content h2,
      .markdown-content h3,
      .markdown-content h4,
      .markdown-content h5,
      .markdown-content h6 {
        margin-top: 1.2em;
        margin-bottom: 0.45em;
        line-height: 1.3;
      }

      .markdown-content h1 {
        font-size: 1.55rem;
        padding-bottom: 0.3rem;
        border-bottom: 1px solid rgba(88, 103, 130, 0.24);
      }

      .markdown-content h2 {
        font-size: 1.32rem;
      }

      .markdown-content h3 {
        font-size: 1.15rem;
      }

      .markdown-content p,
      .markdown-content ul,
      .markdown-content ol,
      .markdown-content blockquote,
      .markdown-content table,
      .markdown-content pre {
        margin-top: 0.7rem;
        margin-bottom: 0.7rem;
      }

      .markdown-content a {
        color: var(--link);
      }

      .markdown-content blockquote {
        margin-left: 0;
        padding: 0.4rem 0.9rem;
        border-left: 3px solid var(--quote-border);
        background: var(--quote-bg);
        color: var(--text-dim);
        border-radius: 0 8px 8px 0;
      }

      .markdown-content table {
        width: 100%;
        border-collapse: collapse;
      }

      .markdown-content th,
      .markdown-content td {
        border: 1px solid rgba(88, 103, 130, 0.24);
        padding: 8px 10px;
      }

      .markdown-content th {
        background: var(--table-head-bg);
      }

      .markdown-content pre {
        padding: 12px 14px;
        border-radius: 10px;
        background: var(--code-bg);
        overflow: auto;
      }

      .markdown-content code {
        font-family: "SF Mono", "JetBrains Mono", Menlo, monospace;
      }

      .markdown-content :not(pre) > code {
        padding: 2px 6px;
        border-radius: 6px;
        background: var(--inline-code-bg);
      }

      .markdown-content mark {
        background: rgba(255, 221, 128, 0.7);
        color: #473718;
        padding: 0 3px;
        border-radius: 4px;
      }

      .markdown-content hr {
        border: none;
        border-top: 1px solid rgba(88, 103, 130, 0.24);
      }

      .markdown-content ul.task-list,
      .markdown-content ul.contains-task-list,
      .markdown-content ol.contains-task-list {
        list-style: none;
        padding-left: 0;
      }

      .markdown-content li.task-list-item {
        list-style: none;
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 0.4rem 0;
        padding: 0;
        border: none;
      }

      .markdown-content li.task-list-item .todo-toggle {
        margin-top: 0;
        align-self: center;
        flex-shrink: 0;
        text-decoration: none;
      }

      .markdown-content li.task-list-item .task-body {
        flex: 1 1 auto;
        min-width: 0;
        cursor: pointer;
      }

      .markdown-content li.task-list-item .task-body > p {
        margin: 0;
      }

      .markdown-content li.task-list-item .task-body > p + p {
        margin-top: 0.45rem;
      }

      .markdown-content li.task-list-item .task-body > *:first-child {
        margin-top: 0 !important;
      }

      .markdown-content li.task-list-item .task-body > *:last-child {
        margin-bottom: 0 !important;
      }

      .markdown-content li.task-list-item.completed {
        color: var(--text-dim);
      }

      .markdown-content li.task-list-item.completed .task-body {
        text-decoration: line-through;
        text-decoration-color: rgba(88, 103, 130, 0.35);
      }

      .markdown-content li.task-list-item.completed .checkbox {
        border-color: var(--ok);
        background: rgba(128, 207, 164, 0.24);
      }

      .markdown-content li.task-list-item.completed .checkbox::after {
        background: var(--ok);
      }

      .markdown-content .mermaid {
        display: block;
        margin: 1rem 0;
        padding: 14px;
        border-radius: 10px;
        background: rgba(88, 103, 130, 0.14);
        overflow: auto;
      }

      .markdown-content .mermaid svg {
        max-width: 100%;
        height: auto;
      }

      @media (max-width: 720px) {
        body {
          padding: 12px;
        }

        .header,
        .toolbar,
        .stats,
        .markdown-content {
          padding-left: 16px;
          padding-right: 16px;
        }

        .todo-item {
          padding-left: 16px;
          padding-right: 16px;
        }

        .header-top {
          flex-direction: column;
          align-items: flex-start;
        }

        .header-controls {
          width: 100%;
          justify-content: flex-end;
        }

        .theme-radial {
          width: 206px;
          height: 206px;
          --radial-size: 206px;
          --radial-center-x: 188px;
          --radial-center-y: 14px;
        }
      }

      @keyframes backgroundPulse {
        0% {
          opacity: 0;
          transform: scale(0.94);
        }
        50% {
          opacity: 0.9;
        }
        100% {
          opacity: 0;
          transform: scale(1.03);
        }
      }

      @keyframes swatchBounce {
        0% {
          transform: scale(calc(var(--swatch-scale) * 0.84));
        }
        62% {
          transform: scale(calc(var(--swatch-scale) + 0.08));
        }
        100% {
          transform: scale(var(--swatch-scale));
        }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <header class="header">
        <div class="header-top">
          <h1 class="title">${safeDisplayName}</h1>
          <div class="header-controls">
            <label class="only-todo-control">
              <span>Only Todo</span>
              <span class="switch">
                <input id="only-todo-switch" type="checkbox" />
                <span class="slider"></span>
              </span>
            </label>
            <div class="theme-picker" id="theme-picker">
              <button
                type="button"
                class="theme-trigger"
                id="theme-trigger"
                aria-label="Open theme picker"
                aria-expanded="false"
              >
                <span class="theme-trigger-fill" aria-hidden="true"></span>
              </button>
              <div class="theme-radial" id="theme-radial" hidden>
                <div class="radial-layer" id="mode-layer">
                  <button
                    type="button"
                    class="radial-swatch mode-button"
                    data-mode="dark"
                    aria-label="Use dark palette"
                  ></button>
                  <button
                    type="button"
                    class="radial-swatch mode-button"
                    data-mode="light"
                    aria-label="Use light palette"
                  ></button>
                </div>
                <div class="radial-separator" aria-hidden="true"></div>
                <div
                  class="radial-layer radial-layer-scrollable"
                  id="plain-layer"
                  aria-label="Plain themes"
                ></div>
                <div class="layer-fade" id="plain-fade-start" aria-hidden="true"></div>
                <div class="layer-fade" id="plain-fade-end" aria-hidden="true"></div>
                <div
                  class="radial-layer radial-layer-scrollable"
                  id="gradient-layer"
                  aria-label="Gradient themes"
                ></div>
                <div
                  class="layer-fade"
                  id="gradient-fade-start"
                  aria-hidden="true"
                ></div>
                <div class="layer-fade" id="gradient-fade-end" aria-hidden="true"></div>
              </div>
            </div>
          </div>
        </div>
      </header>
      <section class="toolbar" id="filter-toolbar">
        <div class="filter-row">
          <button class="filter" data-filter="all">All</button>
          <button class="filter" data-filter="pending">Pending</button>
          <button class="filter" data-filter="completed">Completed</button>
        </div>
        <footer class="stats" id="stats"></footer>
      </section>
      <section class="content" id="content-root">
        <section id="todo-view">
          <ul class="todo-list" id="todo-list"></ul>
          <p class="empty" id="empty" hidden>No todos match this filter.</p>
        </section>
        <article id="markdown-view" class="markdown-content" hidden></article>
      </section>
    </main>

    <script>
      const vscode = acquireVsCodeApi();
      let tasks = ${JSON.stringify(safeTasks)};
      const markdownHtml = ${JSON.stringify(data.markdownHtml)};
      const mermaidScriptUrl = ${JSON.stringify(data.mermaidScriptUri)};
      const initialThemePreference = ${JSON.stringify(safeThemePreference)};
      const filterOptions = new Set(["all", "pending", "completed"]);
      const themeModes = new Set(["dark", "light"]);
      const themeVariants = new Set(["plain", "gradient"]);
      const THEME_CATALOG = {
        light: {
          plain: [
            {
              id: "blush",
              label: "Blush",
              fill: "#f2b2ca",
              accent: "#db6e9b",
              accentStrong: "#c95484",
              bg1: "#fff7fc",
              bg2: "#f4f7ff",
              bg3: "#f2fff9",
              link: "#b34b7f"
            },
            {
              id: "mint",
              label: "Mint",
              fill: "#b8e2cf",
              accent: "#58a982",
              accentStrong: "#458d6e",
              bg1: "#f5fff9",
              bg2: "#edf6ff",
              bg3: "#f1fff5",
              link: "#3d8263"
            },
            {
              id: "sky",
              label: "Sky",
              fill: "#b8d9ff",
              accent: "#5f93d4",
              accentStrong: "#4a79b5",
              bg1: "#f3f8ff",
              bg2: "#eef5ff",
              bg3: "#f6fcff",
              link: "#3d68a0"
            },
            {
              id: "peach",
              label: "Peach",
              fill: "#ffd1b8",
              accent: "#d8875f",
              accentStrong: "#be6f49",
              bg1: "#fff8f2",
              bg2: "#fff2ef",
              bg3: "#fff9f1",
              link: "#a95f3f"
            },
            {
              id: "lilac",
              label: "Lilac",
              fill: "#d8c6f4",
              accent: "#9470c8",
              accentStrong: "#7a58ad",
              bg1: "#fbf8ff",
              bg2: "#f3f1ff",
              bg3: "#f9f4ff",
              link: "#6b4c98"
            },
            {
              id: "seafoam",
              label: "Seafoam",
              fill: "#b8ebdf",
              accent: "#4f9d8c",
              accentStrong: "#3e7f72",
              bg1: "#f2fffb",
              bg2: "#edfbff",
              bg3: "#f2fff9",
              link: "#376f62"
            },
            {
              id: "butter",
              label: "Butter",
              fill: "#ffe79f",
              accent: "#cc9f42",
              accentStrong: "#af8432",
              bg1: "#fffdf1",
              bg2: "#fff7e9",
              bg3: "#fffef3",
              link: "#8f6a22"
            },
            {
              id: "berrymilk",
              label: "Berry Milk",
              fill: "#f4bfd8",
              accent: "#c66f9b",
              accentStrong: "#ac567f",
              bg1: "#fff5fa",
              bg2: "#f9f0ff",
              bg3: "#fff7f3",
              link: "#8f3f66"
            }
          ],
          gradient: [
            {
              id: "classic-pastel",
              label: "Classic Pastel",
              fill: "linear-gradient(135deg, #fdf2f8 0%, #edf6ff 55%, #ecfff5 100%)",
              accent: "#f6b8c9",
              accentStrong: "#f29bb3",
              bg1: "#fdf2f8",
              bg2: "#edf6ff",
              bg3: "#ecfff5",
              link: "#cc6f93"
            },
            {
              id: "sunrise",
              label: "Sunrise",
              fill: "linear-gradient(135deg, #ffd8a8 0%, #ffc2d6 52%, #bde4ff 100%)",
              accent: "#d57c90",
              accentStrong: "#c3677d",
              bg1: "#fff8ec",
              bg2: "#fff0f6",
              bg3: "#edf8ff",
              link: "#a85770"
            },
            {
              id: "matcha-latte",
              label: "Matcha Latte",
              fill: "linear-gradient(135deg, #d0efc4 0%, #9cdabf 50%, #b0d9ff 100%)",
              accent: "#5f9985",
              accentStrong: "#4c7f6d",
              bg1: "#f7fff0",
              bg2: "#edfef7",
              bg3: "#eef5ff",
              link: "#3d6a59"
            },
            {
              id: "aurora-candy",
              label: "Aurora Candy",
              fill: "linear-gradient(135deg, #ffd0f3 0%, #cabfff 48%, #a7e8ff 100%)",
              accent: "#8f73c8",
              accentStrong: "#7559ad",
              bg1: "#fff4fd",
              bg2: "#f2f1ff",
              bg3: "#edf9ff",
              link: "#634696"
            },
            {
              id: "coral-breeze",
              label: "Coral Breeze",
              fill: "linear-gradient(135deg, #ffd1c2 0%, #ffd9a8 54%, #bce9d2 100%)",
              accent: "#c67f63",
              accentStrong: "#ad6a4e",
              bg1: "#fff7f3",
              bg2: "#fff6ec",
              bg3: "#f1fff8",
              link: "#92553f"
            },
            {
              id: "powder-rain",
              label: "Powder Rain",
              fill: "linear-gradient(135deg, #c6ddff 0%, #d4cdfd 50%, #f6cfff 100%)",
              accent: "#7b8cc8",
              accentStrong: "#6274ad",
              bg1: "#f4f8ff",
              bg2: "#f5f2ff",
              bg3: "#fff2fd",
              link: "#4f6194"
            },
            {
              id: "opal-garden",
              label: "Opal Garden",
              fill: "linear-gradient(135deg, #d9f6cf 0%, #bce7e0 52%, #bee2ff 100%)",
              accent: "#5f9f90",
              accentStrong: "#4e8678",
              bg1: "#f7fff2",
              bg2: "#eefcf7",
              bg3: "#edf6ff",
              link: "#3c6f62"
            },
            {
              id: "sherbet",
              label: "Sherbet",
              fill: "linear-gradient(135deg, #ffe2a6 0%, #ffc8a7 50%, #ffc6df 100%)",
              accent: "#cc8a5f",
              accentStrong: "#b3734b",
              bg1: "#fffaf0",
              bg2: "#fff3ee",
              bg3: "#fff1f8",
              link: "#95593a"
            },
            {
              id: "mint-berry",
              label: "Mint Berry",
              fill: "linear-gradient(135deg, #bff0dd 0%, #bde5ff 45%, #f5c1d8 100%)",
              accent: "#5b94ad",
              accentStrong: "#497c92",
              bg1: "#f1fff8",
              bg2: "#edf7ff",
              bg3: "#fff2f8",
              link: "#3e6678"
            },
            {
              id: "lavender-milk",
              label: "Lavender Milk",
              fill: "linear-gradient(135deg, #e7dbff 0%, #c3d2ff 50%, #ffe2f2 100%)",
              accent: "#8b7ac8",
              accentStrong: "#715fab",
              bg1: "#faf6ff",
              bg2: "#eef3ff",
              bg3: "#fff4fb",
              link: "#5c4b95"
            },
            {
              id: "pond-mist",
              label: "Pond Mist",
              fill: "linear-gradient(135deg, #bfe3d9 0%, #b8d5f5 50%, #d7caf0 100%)",
              accent: "#5d87ac",
              accentStrong: "#4a6f90",
              bg1: "#f1fbf8",
              bg2: "#edf4ff",
              bg3: "#f8f2ff",
              link: "#3d5873"
            }
          ]
        },
        dark: {
          plain: [
            {
              id: "twilight-rose",
              label: "Twilight Rose",
              fill: "#6f465b",
              accent: "#e7a0c1",
              accentStrong: "#f2b4cf",
              bg1: "#19141f",
              bg2: "#1d1f2d",
              bg3: "#1a2428",
              link: "#f3b6d2"
            },
            {
              id: "night-mint",
              label: "Night Mint",
              fill: "#355c50",
              accent: "#9ed9bd",
              accentStrong: "#b6e6cc",
              bg1: "#111b19",
              bg2: "#18252a",
              bg3: "#15201f",
              link: "#bcebd6"
            },
            {
              id: "deep-sky",
              label: "Deep Sky",
              fill: "#3a547d",
              accent: "#a2c6ff",
              accentStrong: "#bdd9ff",
              bg1: "#121827",
              bg2: "#162130",
              bg3: "#12202d",
              link: "#c9e0ff"
            },
            {
              id: "embers",
              label: "Embers",
              fill: "#72503f",
              accent: "#f2be9b",
              accentStrong: "#ffcfaf",
              bg1: "#1e1714",
              bg2: "#281d18",
              bg3: "#1e2117",
              link: "#ffd8bd"
            },
            {
              id: "plum-night",
              label: "Plum Night",
              fill: "#5b476c",
              accent: "#d2b7ff",
              accentStrong: "#e1ccff",
              bg1: "#1a1521",
              bg2: "#1e1a2d",
              bg3: "#19222a",
              link: "#e5d3ff"
            },
            {
              id: "ocean-ink",
              label: "Ocean Ink",
              fill: "#3a5f62",
              accent: "#9ed6da",
              accentStrong: "#b4e3e7",
              bg1: "#11181d",
              bg2: "#17232d",
              bg3: "#122125",
              link: "#bbe6e9"
            },
            {
              id: "golden-hour",
              label: "Golden Hour",
              fill: "#6a5b35",
              accent: "#f3d78c",
              accentStrong: "#ffe4a5",
              bg1: "#1f1c12",
              bg2: "#272114",
              bg3: "#1b2316",
              link: "#ffe6b0"
            },
            {
              id: "berry-night",
              label: "Berry Night",
              fill: "#66435d",
              accent: "#e2a3cf",
              accentStrong: "#f0b8dc",
              bg1: "#1c1420",
              bg2: "#22192b",
              bg3: "#1d2327",
              link: "#f4c2e2"
            }
          ],
          gradient: [
            {
              id: "neon-dusk",
              label: "Neon Dusk",
              fill: "linear-gradient(135deg, #7c4f63 0%, #5f5ea0 50%, #3b6b8e 100%)",
              accent: "#d9a4c9",
              accentStrong: "#eab9da",
              bg1: "#1d1520",
              bg2: "#1f2131",
              bg3: "#182532",
              link: "#efbfe0"
            },
            {
              id: "forest-haze",
              label: "Forest Haze",
              fill: "linear-gradient(135deg, #476a57 0%, #2f5d67 50%, #46628d 100%)",
              accent: "#a9dbc5",
              accentStrong: "#bee8d4",
              bg1: "#131d19",
              bg2: "#17262c",
              bg3: "#172133",
              link: "#c6efdd"
            },
            {
              id: "violet-wave",
              label: "Violet Wave",
              fill: "linear-gradient(135deg, #5d4f87 0%, #3d5f96 50%, #4e587b 100%)",
              accent: "#cab8ff",
              accentStrong: "#ddcdff",
              bg1: "#18162a",
              bg2: "#162538",
              bg3: "#1e2434",
              link: "#e3d5ff"
            },
            {
              id: "amber-night",
              label: "Amber Night",
              fill: "linear-gradient(135deg, #7a6238 0%, #68503d 50%, #4e5f47 100%)",
              accent: "#f0d09a",
              accentStrong: "#ffe2b2",
              bg1: "#201b12",
              bg2: "#271d18",
              bg3: "#1c261b",
              link: "#ffe7bf"
            },
            {
              id: "crystal-noir",
              label: "Crystal Noir",
              fill: "linear-gradient(135deg, #476983 0%, #4b5488 50%, #5a4f7a 100%)",
              accent: "#b7d5ef",
              accentStrong: "#cce3f8",
              bg1: "#141d28",
              bg2: "#1a2032",
              bg3: "#1e1d31",
              link: "#d4e8fb"
            },
            {
              id: "retro-pop",
              label: "Retro Pop",
              fill: "linear-gradient(135deg, #744c5f 0%, #53639a 50%, #4f7a70 100%)",
              accent: "#e2b2d0",
              accentStrong: "#efc4dc",
              bg1: "#1d1520",
              bg2: "#1f2436",
              bg3: "#172623",
              link: "#f4cde2"
            },
            {
              id: "aurora-night",
              label: "Aurora Night",
              fill: "linear-gradient(135deg, #476871 0%, #55508f 45%, #7a4f7c 100%)",
              accent: "#afcced",
              accentStrong: "#c3dcf8",
              bg1: "#141c1f",
              bg2: "#1c1e36",
              bg3: "#251b2d",
              link: "#cae1fb"
            },
            {
              id: "cocoa-rain",
              label: "Cocoa Rain",
              fill: "linear-gradient(135deg, #70574a 0%, #5c4f6e 50%, #3f5970 100%)",
              accent: "#e4bfac",
              accentStrong: "#f0d0bf",
              bg1: "#211812",
              bg2: "#221c31",
              bg3: "#172230",
              link: "#f5d6c8"
            },
            {
              id: "blue-hour",
              label: "Blue Hour",
              fill: "linear-gradient(135deg, #3f5877 0%, #3d4f74 50%, #425f6d 100%)",
              accent: "#aaccf3",
              accentStrong: "#c0dbfa",
              bg1: "#11182a",
              bg2: "#172035",
              bg3: "#12242a",
              link: "#c8e0fd"
            },
            {
              id: "orchid-gloom",
              label: "Orchid Gloom",
              fill: "linear-gradient(135deg, #5f4d74 0%, #3f586f 50%, #625263 100%)",
              accent: "#d7c0f0",
              accentStrong: "#e5d2f8",
              bg1: "#181528",
              bg2: "#172235",
              bg3: "#231c29",
              link: "#ead9fa"
            }
          ]
        }
      };
      const MODE_BASE_TOKENS = {
        light: {
          surface: "rgba(255, 255, 255, 0.74)",
          surfaceStrong: "rgba(255, 255, 255, 0.92)",
          border: "rgba(88, 103, 130, 0.24)",
          textMain: "#27344d",
          textDim: "#66758f",
          ok: "#78c79d",
          shadow: "0 18px 40px rgba(72, 88, 120, 0.2)",
          filterBg: "rgba(88, 103, 130, 0.08)",
          sliderOff: "rgba(88, 103, 130, 0.16)",
          sliderKnob: "#ffffff",
          tableHead: "rgba(88, 103, 130, 0.1)",
          codeBg: "rgba(46, 59, 86, 0.92)",
          inlineCodeBg: "rgba(88, 103, 130, 0.16)",
          radialBg: "rgba(255, 255, 255, 0.95)",
          radialBorder: "rgba(88, 103, 130, 0.3)",
          modePillBg: "rgba(88, 103, 130, 0.1)",
          scrollShadow: "rgba(31, 42, 64, 0.28)"
        },
        dark: {
          surface: "rgba(29, 34, 47, 0.76)",
          surfaceStrong: "rgba(248, 250, 255, 0.9)",
          border: "rgba(175, 187, 224, 0.24)",
          textMain: "#e6ebff",
          textDim: "#b6c0de",
          ok: "#7ad6aa",
          shadow: "0 24px 48px rgba(7, 10, 20, 0.52)",
          filterBg: "rgba(175, 187, 224, 0.14)",
          sliderOff: "rgba(175, 187, 224, 0.25)",
          sliderKnob: "#eff4ff",
          tableHead: "rgba(175, 187, 224, 0.16)",
          codeBg: "rgba(9, 12, 20, 0.86)",
          inlineCodeBg: "rgba(175, 187, 224, 0.2)",
          radialBg: "rgba(29, 34, 47, 0.95)",
          radialBorder: "rgba(175, 187, 224, 0.32)",
          modePillBg: "rgba(175, 187, 224, 0.16)",
          scrollShadow: "rgba(10, 15, 28, 0.52)"
        }
      };
      const RADIAL_GEOMETRY = Object.freeze({
        centerX: 206,
        centerY: 14,
        angleStart: 8,
        angleEnd: 86,
        modeRadius: 50,
        modeOffsetX: 10,
        modeOffsetY: -6,
        plainRadius: 110,
        gradientRadius: 160,
        modeAngles: [22, 68],
        plainSpacing: 44,
        gradientSpacing: 40,
        plainScaleBandPx: 30,
        gradientScaleBandPx: 20
      });
      const savedState = vscode.getState() || {};
      let activeFilter = filterOptions.has(savedState.activeFilter)
        ? savedState.activeFilter
        : "all";
      let onlyTodo =
        typeof savedState.onlyTodo === "boolean" ? savedState.onlyTodo : true;
      const normalizeClientThemePreference = (value) => {
        if (!value || typeof value !== "object") {
          return { ...initialThemePreference };
        }

        const mode = themeModes.has(value.mode) ? value.mode : initialThemePreference.mode;
        const variant = themeVariants.has(value.variant)
          ? value.variant
          : initialThemePreference.variant;
        const plainIndex = Number.isInteger(value.plainIndex)
          ? Math.max(0, value.plainIndex)
          : initialThemePreference.plainIndex;
        const gradientIndex = Number.isInteger(value.gradientIndex)
          ? Math.max(0, value.gradientIndex)
          : initialThemePreference.gradientIndex;

        return {
          mode,
          variant,
          plainIndex,
          gradientIndex
        };
      };
      let themePreference = normalizeClientThemePreference(initialThemePreference);
      let plainWheelOffset = themePreference.plainIndex;
      let gradientWheelOffset = themePreference.gradientIndex;
      let themePulseTimer = null;
      let mermaidInitialized = false;
      let mermaidScriptPromise = null;
      let themePickerOpen = false;
      let closePickerTimer = null;
      let plainHasOverflowState = false;
      let gradientHasOverflowState = false;

      const list = document.getElementById("todo-list");
      const empty = document.getElementById("empty");
      const stats = document.getElementById("stats");
      const contentRoot = document.getElementById("content-root");
      const todoView = document.getElementById("todo-view");
      const markdownView = document.getElementById("markdown-view");
      const filterToolbar = document.getElementById("filter-toolbar");
      const onlyTodoSwitch = document.getElementById("only-todo-switch");
      const filterButtons = Array.from(document.querySelectorAll(".filter"));
      const themePicker = document.getElementById("theme-picker");
      const themeTrigger = document.getElementById("theme-trigger");
      const themeRadial = document.getElementById("theme-radial");
      const modeLayer = document.getElementById("mode-layer");
      const plainLayer = document.getElementById("plain-layer");
      const gradientLayer = document.getElementById("gradient-layer");
      const plainFadeStart = document.getElementById("plain-fade-start");
      const plainFadeEnd = document.getElementById("plain-fade-end");
      const gradientFadeStart = document.getElementById("gradient-fade-start");
      const gradientFadeEnd = document.getElementById("gradient-fade-end");

      const persistState = () => {
        vscode.setState({ activeFilter, onlyTodo });
      };

      const persistThemePreference = () => {
        vscode.postMessage({
          type: "saveThemePreference",
          preference: themePreference
        });
      };

      const updateTaskStatusLocally = (lineNumber, completed) => {
        const index = tasks.findIndex((task) => task.lineNumber === lineNumber);
        if (index < 0) {
          return false;
        }

        tasks[index] = {
          ...tasks[index],
          completed
        };
        return true;
      };

      const passesFilter = (task) => {
        if (activeFilter === "pending") return !task.completed;
        if (activeFilter === "completed") return task.completed;
        return true;
      };

      const wrapIndex = (index, length) => {
        if (!Number.isFinite(length) || length <= 0) {
          return 0;
        }

        const next = index % length;
        return next < 0 ? next + length : next;
      };

      const withAlpha = (hex, alpha) => {
        if (typeof hex !== "string") {
          return "rgba(0, 0, 0, 0)";
        }

        const cleaned = hex.trim().replace(/^#/, "");
        const normalized = cleaned.length === 3
          ? cleaned
              .split("")
              .map((char) => char + char)
              .join("")
          : cleaned;

        if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
          return "rgba(0, 0, 0, 0)";
        }

        const red = parseInt(normalized.slice(0, 2), 16);
        const green = parseInt(normalized.slice(2, 4), 16);
        const blue = parseInt(normalized.slice(4, 6), 16);
        return \`rgba(\${red}, \${green}, \${blue}, \${alpha})\`;
      };

      const toRadians = (degree) => (degree * Math.PI) / 180;
      const getPointOnArc = (radius, angle) => {
        const radians = toRadians(angle);
        return {
          x: RADIAL_GEOMETRY.centerX - radius * Math.cos(radians),
          y: RADIAL_GEOMETRY.centerY + radius * Math.sin(radians)
        };
      };

      const placeArcElement = (
        element,
        radius,
        angle,
        offsetX = 0,
        offsetY = 0
      ) => {
        const point = getPointOnArc(radius, angle);
        const width = element.offsetWidth || 24;
        const height = element.offsetHeight || 24;
        element.style.left = \`\${point.x - width / 2 + offsetX}px\`;
        element.style.top = \`\${point.y - height / 2 + offsetY}px\`;
      };

      const placeEdgeFade = (element, radius, angle, reverse = false) => {
        const point = getPointOnArc(radius, angle);
        const tangentAngle = 90 - angle;
        element.style.left = \`\${point.x}px\`;
        element.style.top = \`\${point.y}px\`;
        element.style.transform = \`translate(-50%, -50%) rotate(\${tangentAngle}deg)\${reverse ? " scaleX(-1)" : ""}\`;
      };

      const getRadialCenterFromStyles = () => {
        const style = getComputedStyle(themeRadial);
        const centerX = Number.parseFloat(style.getPropertyValue("--radial-center-x"));
        const centerY = Number.parseFloat(style.getPropertyValue("--radial-center-y"));
        return {
          x: Number.isFinite(centerX) ? centerX : RADIAL_GEOMETRY.centerX,
          y: Number.isFinite(centerY) ? centerY : RADIAL_GEOMETRY.centerY
        };
      };

      const getVisibleAngles = (count) => {
        if (count <= 1) {
          return [RADIAL_GEOMETRY.angleStart];
        }

        const step = (RADIAL_GEOMETRY.angleEnd - RADIAL_GEOMETRY.angleStart) / (count - 1);
        return Array.from({ length: count }, (_, index) => RADIAL_GEOMETRY.angleStart + index * step);
      };

      const getVisibleCountForLayer = (radius, spacing, totalEntries) => {
        if (totalEntries <= 0) {
          return 0;
        }

        const arcDegrees = Math.max(1, RADIAL_GEOMETRY.angleEnd - RADIAL_GEOMETRY.angleStart);
        const arcLength = radius * toRadians(arcDegrees);
        const safeSpacing = Math.max(1, spacing);
        const derivedCount = Math.floor(arcLength / safeSpacing) + 1;
        return Math.max(1, Math.min(totalEntries, derivedCount));
      };

      const clampThemePreference = () => {
        const modeCatalog = THEME_CATALOG[themePreference.mode] || THEME_CATALOG.light;
        const plainLength = modeCatalog.plain.length;
        const gradientLength = modeCatalog.gradient.length;
        themePreference.plainIndex = wrapIndex(themePreference.plainIndex, plainLength);
        themePreference.gradientIndex = wrapIndex(themePreference.gradientIndex, gradientLength);
        plainWheelOffset = wrapIndex(plainWheelOffset, plainLength);
        gradientWheelOffset = wrapIndex(gradientWheelOffset, gradientLength);
      };

      const getActivePalette = () => {
        const modeCatalog = THEME_CATALOG[themePreference.mode];
        const paletteType = themePreference.variant === "plain" ? "plain" : "gradient";
        const paletteIndex = paletteType === "plain"
          ? themePreference.plainIndex
          : themePreference.gradientIndex;
        const selected = modeCatalog[paletteType][wrapIndex(paletteIndex, modeCatalog[paletteType].length)];
        return {
          modeCatalog,
          selected
        };
      };

      const renderModeLayer = () => {
        const modeButtons = Array.from(modeLayer.querySelectorAll(".mode-button"));
        modeButtons.forEach((button, index) => {
          placeArcElement(
            button,
            RADIAL_GEOMETRY.modeRadius,
            RADIAL_GEOMETRY.modeAngles[index] || RADIAL_GEOMETRY.modeAngles[0],
            RADIAL_GEOMETRY.modeOffsetX,
            RADIAL_GEOMETRY.modeOffsetY
          );
          button.classList.toggle("active", button.dataset.mode === themePreference.mode);
        });
      };

      const renderPaletteLayer = (
        layer,
        type,
        radius,
        offset,
        spacing,
        options = {}
      ) => {
        const { animateSwatches = false } = options;
        const modeCatalog = THEME_CATALOG[themePreference.mode];
        const entries = modeCatalog[type];
        const visibleCount = getVisibleCountForLayer(radius, spacing, entries.length);
        const angles = getVisibleAngles(visibleCount);
        layer.innerHTML = "";

        if (entries.length === 0) {
          return false;
        }

        const selectedKey = type === "plain" ? "plainIndex" : "gradientIndex";
        const angleStep = angles.length > 1
          ? angles[1] - angles[0]
          : Math.max(
              12,
              (RADIAL_GEOMETRY.angleEnd - RADIAL_GEOMETRY.angleStart) * 0.3
            );
        const scaleBandPx = type === "plain"
          ? RADIAL_GEOMETRY.plainScaleBandPx
          : RADIAL_GEOMETRY.gradientScaleBandPx;
        const angleStepRadians = toRadians(angleStep);

        const scaleFromCenterBand = (visibleIndex, count) => {
          const center = (count - 1) / 2;
          const centerDistance = Math.abs(visibleIndex - center);

          // Keep the visual center pair consistently largest across layers.
          if (centerDistance <= 0.5) {
            return 1.2;
          }

          // Layer 3: always decrease by 0.2 per ring as we move toward edges.
          if (type === "gradient") {
            const stepsFromCenter = Math.max(0, Math.ceil(centerDistance) - 1);
            return Math.max(0.3, 1.2 - stepsFromCenter * 0.2);
          }

          const distancePx = centerDistance * radius * angleStepRadians;
          const band = Math.floor(distancePx / Math.max(1, scaleBandPx));
          if (band <= 1) {
            return 1.0;
          }
          return 0.8;
        };

        const createSwatchButton = (
          entry,
          absoluteIndex,
          isPeek = false,
          scale = 1,
          shouldBounce = false
        ) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = isPeek
            ? "radial-swatch palette-swatch swatch-peek"
            : "radial-swatch palette-swatch";
          if (shouldBounce && !isPeek) {
            button.classList.add("swatch-bounce");
          }
          button.style.setProperty("--swatch-fill", entry.fill);
          button.style.setProperty("--swatch-scale", String(scale));

          if (isPeek) {
            button.setAttribute("aria-hidden", "true");
            button.tabIndex = -1;
            return button;
          }

          button.dataset.type = type;
          button.dataset.index = String(absoluteIndex);
          button.setAttribute("aria-label", \`\${type} theme: \${entry.label}\`);
          button.title = entry.label;
          button.classList.toggle(
            "active",
            themePreference.variant === type &&
              themePreference[selectedKey] === absoluteIndex
          );
          return button;
        };

        const hasOverflow = entries.length > visibleCount;
        const peekAngleOffset = angleStep * 0.5;
        const peekScale = type === "gradient" ? 0.6 : 0.6;

        if (hasOverflow) {
          const leadingIndex = wrapIndex(offset - 1, entries.length);
          const trailingIndex = wrapIndex(offset + visibleCount, entries.length);
          const leadingSwatch = createSwatchButton(
            entries[leadingIndex],
            leadingIndex,
            true,
            peekScale
          );
          const trailingSwatch = createSwatchButton(
            entries[trailingIndex],
            trailingIndex,
            true,
            peekScale
          );
          layer.appendChild(leadingSwatch);
          layer.appendChild(trailingSwatch);
          placeArcElement(
            leadingSwatch,
            radius,
            RADIAL_GEOMETRY.angleStart - peekAngleOffset
          );
          placeArcElement(
            trailingSwatch,
            radius,
            RADIAL_GEOMETRY.angleEnd + peekAngleOffset
          );
        }

        angles.forEach((angle, visibleIndex) => {
          const absoluteIndex = wrapIndex(offset + visibleIndex, entries.length);
          const entry = entries[absoluteIndex];
          const swatchScale = scaleFromCenterBand(visibleIndex, visibleCount);
          const button = createSwatchButton(
            entry,
            absoluteIndex,
            false,
            swatchScale,
            animateSwatches
          );
          layer.appendChild(button);
          placeArcElement(button, radius, angle);
        });

        return hasOverflow;
      };

      const renderLayerEdgeFades = (plainHasOverflow, gradientHasOverflow) => {
        plainFadeStart.hidden = !plainHasOverflow;
        plainFadeEnd.hidden = !plainHasOverflow;
        gradientFadeStart.hidden = !gradientHasOverflow;
        gradientFadeEnd.hidden = !gradientHasOverflow;

        if (plainHasOverflow) {
          placeEdgeFade(
            plainFadeStart,
            RADIAL_GEOMETRY.plainRadius,
            RADIAL_GEOMETRY.angleStart,
            false
          );
          placeEdgeFade(
            plainFadeEnd,
            RADIAL_GEOMETRY.plainRadius,
            RADIAL_GEOMETRY.angleEnd,
            true
          );
        }

        if (gradientHasOverflow) {
          placeEdgeFade(
            gradientFadeStart,
            RADIAL_GEOMETRY.gradientRadius,
            RADIAL_GEOMETRY.angleStart - 3,
            false
          );
          placeEdgeFade(
            gradientFadeEnd,
            RADIAL_GEOMETRY.gradientRadius,
            RADIAL_GEOMETRY.angleEnd,
            true
          );
        }
      };

      const renderThemePicker = (options = {}) => {
        const {
          renderPlain = true,
          renderGradient = true,
          animatePlain = false,
          animateGradient = false
        } = options;

        renderModeLayer();
        if (renderPlain) {
          plainHasOverflowState = renderPaletteLayer(
            plainLayer,
            "plain",
            RADIAL_GEOMETRY.plainRadius,
            plainWheelOffset,
            RADIAL_GEOMETRY.plainSpacing,
            { animateSwatches: animatePlain }
          );
        }
        if (renderGradient) {
          gradientHasOverflowState = renderPaletteLayer(
            gradientLayer,
            "gradient",
            RADIAL_GEOMETRY.gradientRadius,
            gradientWheelOffset,
            RADIAL_GEOMETRY.gradientSpacing,
            { animateSwatches: animateGradient }
          );
        }
        renderLayerEdgeFades(plainHasOverflowState, gradientHasOverflowState);
      };

      const runThemePulse = () => {
        document.body.classList.remove("theme-animate");
        if (themePulseTimer) {
          clearTimeout(themePulseTimer);
        }
        void document.body.offsetWidth;
        document.body.classList.add("theme-animate");
        themePulseTimer = setTimeout(() => {
          document.body.classList.remove("theme-animate");
          themePulseTimer = null;
        }, 540);
      };

      const applyTheme = ({ animate = true, persist = true } = {}) => {
        clampThemePreference();
        const modeBase = MODE_BASE_TOKENS[themePreference.mode];
        const { selected } = getActivePalette();
        const isDarkMode = themePreference.mode === "dark";
        const isPlainVariant = themePreference.variant === "plain";
        const backgroundLayer2 = isPlainVariant ? selected.bg1 : selected.bg2;
        const backgroundLayer3 = isPlainVariant ? selected.bg1 : selected.bg3;
        const overlayOne = isPlainVariant
          ? "rgba(0, 0, 0, 0)"
          : withAlpha(selected.accent, isDarkMode ? 0.28 : 0.24);
        const overlayTwo = isPlainVariant
          ? "rgba(0, 0, 0, 0)"
          : withAlpha(selected.accentStrong, isDarkMode ? 0.22 : 0.18);
        const tokens = {
          "--bg-layer-1": selected.bg1,
          "--bg-layer-2": backgroundLayer2,
          "--bg-layer-3": backgroundLayer3,
          "--surface": modeBase.surface,
          "--surface-strong": modeBase.surfaceStrong,
          "--border": modeBase.border,
          "--text-main": modeBase.textMain,
          "--text-dim": modeBase.textDim,
          "--accent": selected.accent,
          "--accent-strong": selected.accentStrong,
          "--ok": modeBase.ok,
          "--link": selected.link || selected.accentStrong,
          "--shadow": modeBase.shadow,
          "--filter-bg": modeBase.filterBg,
          "--slider-off": modeBase.sliderOff,
          "--slider-on": withAlpha(selected.accent, isDarkMode ? 0.56 : 0.82),
          "--slider-knob": modeBase.sliderKnob,
          "--quote-bg": withAlpha(selected.accent, isDarkMode ? 0.24 : 0.16),
          "--quote-border": withAlpha(selected.accentStrong, isDarkMode ? 0.74 : 0.7),
          "--table-head-bg": modeBase.tableHead,
          "--code-bg": modeBase.codeBg,
          "--inline-code-bg": modeBase.inlineCodeBg,
          "--card-glow": withAlpha(selected.accentStrong, isDarkMode ? 0.3 : 0.34),
          "--pulse": withAlpha(selected.accentStrong, isDarkMode ? 0.42 : 0.3),
          "--radial-bg": modeBase.radialBg,
          "--radial-border": modeBase.radialBorder,
          "--trigger-fill": selected.fill,
          "--mode-pill-bg": modeBase.modePillBg,
          "--scroll-shadow": modeBase.scrollShadow,
          "--background-overlay-1": overlayOne,
          "--background-overlay-2": overlayTwo
        };

        Object.entries(tokens).forEach(([name, value]) => {
          document.documentElement.style.setProperty(name, value);
        });

        document.body.dataset.themeMode = themePreference.mode;
        renderThemePicker();

        if (animate) {
          runThemePulse();
        }

        if (persist) {
          persistThemePreference();
        }
      };

      const setThemePickerOpen = (nextOpen) => {
        if (themePickerOpen === nextOpen) {
          return;
        }

        themePickerOpen = nextOpen;
        themeTrigger.setAttribute("aria-expanded", String(nextOpen));

        if (closePickerTimer) {
          clearTimeout(closePickerTimer);
          closePickerTimer = null;
        }

        if (nextOpen) {
          themeRadial.hidden = false;
          requestAnimationFrame(() => {
            themeRadial.classList.add("open");
          });
          return;
        }

        themeRadial.classList.remove("open");
        closePickerTimer = setTimeout(() => {
          if (!themePickerOpen) {
            themeRadial.hidden = true;
          }
          closePickerTimer = null;
        }, 210);
      };

      const getMermaidApi = () => {
        const mermaid = window.mermaid;
        if (!mermaid) {
          return null;
        }

        if (!mermaidInitialized && typeof mermaid.initialize === "function") {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "loose",
            theme: "default"
          });
          mermaidInitialized = true;
        }

        return mermaid;
      };

      const ensureMermaidScriptLoaded = async () => {
        if (window.mermaid) {
          return window.mermaid;
        }

        if (!mermaidScriptUrl) {
          return null;
        }

        if (!mermaidScriptPromise) {
          mermaidScriptPromise = new Promise((resolve) => {
            const script = document.createElement("script");
            script.src = mermaidScriptUrl;
            script.async = true;
            script.onload = () => {
              resolve(window.mermaid || null);
            };
            script.onerror = () => {
              console.error("Failed to load Mermaid runtime");
              mermaidScriptPromise = null;
              resolve(null);
            };
            document.head.appendChild(script);
          });
        }

        return mermaidScriptPromise;
      };

      const renderMermaidDiagrams = async () => {
        const mermaidCodeBlocks = Array.from(
          markdownView.querySelectorAll(
            "pre > code.language-mermaid, pre > code.lang-mermaid"
          )
        );

        if (mermaidCodeBlocks.length === 0) {
          return;
        }

        await ensureMermaidScriptLoaded();

        const mermaid = getMermaidApi();
        if (!mermaid || typeof mermaid.run !== "function") {
          return;
        }

        mermaidCodeBlocks.forEach((codeBlock) => {
          const pre = codeBlock.parentElement;
          if (!pre) {
            return;
          }

          const container = document.createElement("div");
          container.className = "mermaid";
          container.textContent = codeBlock.textContent || "";
          pre.replaceWith(container);
        });

        try {
          await mermaid.run({
            nodes: markdownView.querySelectorAll(".mermaid")
          });
        } catch (error) {
          console.error("Mermaid render failed", error);
        }
      };

      const renderTodoList = () => {
        filterButtons.forEach((entry) => {
          entry.classList.toggle("active", entry.dataset.filter === activeFilter);
        });

        const filtered = tasks.filter(passesFilter);
        list.innerHTML = filtered
          .map(
            (task) => \`
              <li class="todo-item \${task.completed ? "completed" : ""}">
                <button
                  type="button"
                  class="todo-toggle"
                  data-line-number="\${task.lineNumber}"
                  aria-label="Toggle todo: \${task.text}"
                >
                  <span class="checkbox" aria-hidden="true"></span>
                </button>
                <span class="todo-text">\${task.text}</span>
              </li>
            \`
          )
          .join("");

        empty.hidden = filtered.length !== 0;
        const completedCount = tasks.filter((task) => task.completed).length;
        const pendingCount = tasks.length - completedCount;
        stats.textContent = \`\${tasks.length} total | \${pendingCount} pending | \${completedCount} completed\`;
      };

      const renderMarkdown = () => {
        markdownView.innerHTML = markdownHtml;
        const markdownTaskItems = Array.from(
          markdownView.querySelectorAll("li.task-list-item")
        );

        markdownTaskItems.forEach((item, index) => {
          const task = tasks[index];
          if (!task) {
            return;
          }

          item.classList.toggle("completed", task.completed);

          const nativeCheckbox = item.querySelector('input[type="checkbox"]');
          if (nativeCheckbox) {
            nativeCheckbox.remove();
          }

          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "todo-toggle";
          toggle.dataset.lineNumber = String(task.lineNumber);
          const taskText = (item.textContent || "").trim().replace(/\s+/g, " ");
          toggle.setAttribute(
            "aria-label",
            taskText ? \`Toggle todo: \${taskText}\` : "Toggle todo"
          );

          const indicator = document.createElement("span");
          indicator.className = "checkbox";
          indicator.setAttribute("aria-hidden", "true");
          toggle.appendChild(indicator);
          item.insertBefore(toggle, item.firstChild);

          const taskBody = document.createElement("div");
          taskBody.className = "task-body";

          const nodesToMove = Array.from(item.childNodes).filter(
            (node) =>
              node !== toggle &&
              !(
                node.nodeType === Node.TEXT_NODE &&
                !(node.textContent || "").trim()
              )
          );
          nodesToMove.forEach((node) => {
            taskBody.appendChild(node);
          });

          item.appendChild(taskBody);
        });

        void renderMermaidDiagrams();
      };

      const render = () => {
        onlyTodoSwitch.checked = onlyTodo;
        filterToolbar.hidden = !onlyTodo;
        filterToolbar.style.display = onlyTodo ? "flex" : "none";
        todoView.hidden = !onlyTodo;
        markdownView.hidden = onlyTodo;
        stats.hidden = !onlyTodo;

        if (onlyTodo) {
          renderTodoList();
        } else {
          renderMarkdown();
        }
      };

      onlyTodoSwitch.addEventListener("change", () => {
        onlyTodo = onlyTodoSwitch.checked;
        persistState();
        render();
      });

      themeTrigger.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setThemePickerOpen(!themePickerOpen);
      });

      themeRadial.addEventListener("click", (event) => {
        event.stopPropagation();
      });

      modeLayer.addEventListener("click", (event) => {
        if (!(event.target instanceof Element)) {
          return;
        }

        const modeButton = event.target.closest(".mode-button");
        if (!modeButton) {
          return;
        }

        const nextMode = modeButton.dataset.mode === "dark" ? "dark" : "light";
        if (nextMode === themePreference.mode) {
          return;
        }

        themePreference = {
          ...themePreference,
          mode: nextMode
        };
        clampThemePreference();
        applyTheme({ animate: true, persist: true });
      });

      const rotateLayer = (type, step) => {
        const entries = THEME_CATALOG[themePreference.mode][type];
        if (!entries || entries.length <= 1) {
          return;
        }

        if (type === "plain") {
          plainWheelOffset = wrapIndex(plainWheelOffset + step, entries.length);
          renderThemePicker({
            renderPlain: true,
            renderGradient: false,
            animatePlain: true
          });
        } else {
          gradientWheelOffset = wrapIndex(gradientWheelOffset + step, entries.length);
          renderThemePicker({
            renderPlain: false,
            renderGradient: true,
            animateGradient: true
          });
        }
      };

      const getScrollLayerFromPointer = (event) => {
        const rect = themeRadial.getBoundingClientRect();
        const center = getRadialCenterFromStyles();
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;
        const radius = Math.hypot(localX - center.x, localY - center.y);
        const plainGap = Math.abs(radius - RADIAL_GEOMETRY.plainRadius);
        const gradientGap = Math.abs(radius - RADIAL_GEOMETRY.gradientRadius);
        const tolerance = 24;
        const closestGap = Math.min(plainGap, gradientGap);

        if (closestGap > tolerance) {
          return null;
        }

        return plainGap <= gradientGap ? "plain" : "gradient";
      };

      themeRadial.addEventListener(
        "wheel",
        (event) => {
          const targetLayer = getScrollLayerFromPointer(event);
          if (!targetLayer) {
            return;
          }

          event.preventDefault();
          rotateLayer(targetLayer, event.deltaY >= 0 ? 1 : -1);
        },
        { passive: false }
      );

      themeRadial.addEventListener("click", (event) => {
        if (!(event.target instanceof Element)) {
          return;
        }

        const swatch = event.target.closest(".palette-swatch");
        if (!swatch) {
          return;
        }

        const type = swatch.dataset.type === "plain" ? "plain" : "gradient";
        const index = Number(swatch.dataset.index);
        if (!Number.isInteger(index)) {
          return;
        }

        if (type === "plain") {
          themePreference = {
            ...themePreference,
            variant: "plain",
            plainIndex: index
          };
        } else {
          themePreference = {
            ...themePreference,
            variant: "gradient",
            gradientIndex: index
          };
        }

        applyTheme({ animate: true, persist: true });
      });

      document.addEventListener("pointerdown", (event) => {
        if (!themePickerOpen) {
          return;
        }

        if (!(event.target instanceof Element)) {
          return;
        }

        if (!themePicker.contains(event.target)) {
          setThemePickerOpen(false);
        }
      });

      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && themePickerOpen) {
          event.preventDefault();
          setThemePickerOpen(false);
        }
      });

      filterButtons.forEach((button) => {
        button.addEventListener("click", () => {
          if (!filterOptions.has(button.dataset.filter)) {
            return;
          }

          activeFilter = button.dataset.filter;
          persistState();
          render();
        });
      });

      contentRoot.addEventListener("click", (event) => {
        if (!(event.target instanceof Element)) {
          return;
        }

        if (event.target.closest("a")) {
          return;
        }

        if ((window.getSelection?.().toString() || "").trim().length > 0) {
          return;
        }

        let toggleButton = event.target.closest(".todo-toggle");
        if (!toggleButton) {
          const todoText = event.target.closest(".todo-item .todo-text");
          if (todoText) {
            toggleButton = todoText
              .closest(".todo-item")
              ?.querySelector(".todo-toggle");
          }
        }

        if (!toggleButton) {
          const markdownTaskText = event.target.closest(
            "li.task-list-item .task-body"
          );
          if (markdownTaskText) {
            toggleButton = markdownTaskText
              .closest("li.task-list-item")
              ?.querySelector(".todo-toggle");
          }
        }

        if (!toggleButton) {
          return;
        }

        const lineNumber = Number(toggleButton.dataset.lineNumber);
        if (!Number.isInteger(lineNumber)) {
          return;
        }

        vscode.postMessage({
          type: "toggleTask",
          lineNumber
        });
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.type !== "taskToggled") {
          return;
        }

        const lineNumber = Number(message.lineNumber);
        const completed = Boolean(message.completed);
        if (!Number.isInteger(lineNumber)) {
          return;
        }

        const updated = updateTaskStatusLocally(lineNumber, completed);
        if (!updated) {
          return;
        }

        if (onlyTodo) {
          renderTodoList();
          return;
        }

        const markdownTaskItem = markdownView.querySelector(
          \`li.task-list-item .todo-toggle[data-line-number="\${lineNumber}"]\`
        )?.closest("li.task-list-item");
        if (markdownTaskItem) {
          markdownTaskItem.classList.toggle("completed", completed);
        }
      });

      applyTheme({ animate: false, persist: false });
      render();
    </script>
  </body>
</html>`;
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
