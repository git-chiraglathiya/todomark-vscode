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
        const tasks = parseMarkdownTodos(markdown, markdownRenderer);
        const markdownHtml = markdownRenderer.render(markdown);
        const sectionListMarkdown = buildSectionListMarkdown(markdown);
        const sectionListHtml = markdownRenderer.render(sectionListMarkdown);

        panel.webview.html = getWebviewHtml({
          filePath: document.fileName,
          tasks,
          markdownHtml,
          sectionListHtml,
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

          const tasks = parseMarkdownTodos(targetDocument.getText(), markdownRenderer);
          const taskByLine = new Map(tasks.map((task) => [task.lineNumber, task]));
          const targetTask = taskByLine.get(lineNumber);
          if (!targetTask) {
            vscode.window.showWarningMessage(
              "Could not toggle todo: line is no longer a markdown task."
            );
            return;
          }

          /** @type {Map<number, boolean>} */
          const desiredStateByLine = new Map();
          const nextCompletedState = !targetTask.completed;
          const hasDescendants =
            Array.isArray(targetTask.descendantLineNumbers) &&
            targetTask.descendantLineNumbers.length > 0;

          desiredStateByLine.set(targetTask.lineNumber, nextCompletedState);
          if (hasDescendants) {
            targetTask.descendantLineNumbers.forEach((descendantLineNumber) => {
              desiredStateByLine.set(descendantLineNumber, nextCompletedState);
            });
          }
          if (targetTask.completed) {
            let ancestorLineNumber = targetTask.parentLineNumber;
            while (Number.isInteger(ancestorLineNumber)) {
              const ancestorTask = taskByLine.get(ancestorLineNumber);
              if (!ancestorTask) {
                break;
              }
              if (ancestorTask.completed) {
                desiredStateByLine.set(ancestorTask.lineNumber, false);
              }
              ancestorLineNumber = ancestorTask.parentLineNumber;
            }
          } else {
            desiredStateByLine.set(targetTask.lineNumber, true);
          }

          /** @type {{ lineNumber: number; completed: boolean; marker: " " | "x"; range: vscode.Range }[]} */
          const lineReplacements = [];
          for (const [affectedLineNumber, desiredCompletedState] of desiredStateByLine) {
            if (
              !Number.isInteger(affectedLineNumber) ||
              affectedLineNumber < 0 ||
              affectedLineNumber >= targetDocument.lineCount
            ) {
              vscode.window.showWarningMessage(
                "Could not toggle todo: one or more task lines are out of date."
              );
              return;
            }

            const affectedLine = targetDocument.lineAt(affectedLineNumber);
            const affectedMatch = affectedLine.text.match(TODO_TASK_PATTERN);
            if (!affectedMatch) {
              vscode.window.showWarningMessage(
                "Could not toggle todo: one or more nested task lines are no longer markdown tasks."
              );
              return;
            }

            const currentCompletedState = affectedMatch[2].toLowerCase() === "x";
            if (currentCompletedState === desiredCompletedState) {
              continue;
            }

            const markerOffset = affectedMatch[1].length;
            const markerStart = affectedLine.range.start.translate(0, markerOffset);
            const markerEnd = markerStart.translate(0, 1);
            lineReplacements.push({
              lineNumber: affectedLineNumber,
              completed: desiredCompletedState,
              marker: desiredCompletedState ? "x" : " ",
              range: new vscode.Range(markerStart, markerEnd)
            });
          }

          if (lineReplacements.length === 0) {
            return;
          }

          skipNextInternalRefresh = true;
          suppressRefreshUntil = Date.now() + 900;

          const edit = new vscode.WorkspaceEdit();
          lineReplacements.forEach((replacement) => {
            edit.replace(targetDocument.uri, replacement.range, replacement.marker);
          });

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
            type: "tasksToggled",
            updates: lineReplacements.map((replacement) => ({
              lineNumber: replacement.lineNumber,
              completed: replacement.completed
            }))
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
 * @param {MarkdownIt | null | undefined} renderer
 */
function parseMarkdownTodos(markdown, renderer) {
  const lines = markdown.split(/\r?\n/);
  /** @type {{
   *   lineNumber: number;
   *   text: string;
   *   completed: boolean;
   *   parentLineNumber: number | null;
   *   childLineNumbers: number[];
   *   descendantLineNumbers: number[];
   * }[]} */
  const tasks = [];
  /** @type {Map<number, {
   *   lineNumber: number;
   *   text: string;
   *   completed: boolean;
   *   parentLineNumber: number | null;
   *   childLineNumbers: number[];
   *   descendantLineNumbers: number[];
   * }>} */
  const taskByLine = new Map();

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    const match = line.match(TODO_TASK_PATTERN);
    if (!match) {
      continue;
    }

    const task = {
      lineNumber,
      completed: match[2].toLowerCase() === "x",
      text: match[4],
      parentLineNumber: null,
      childLineNumbers: [],
      descendantLineNumbers: []
    };
    tasks.push(task);
    taskByLine.set(lineNumber, task);
  }

  const parser = renderer && typeof renderer.parse === "function"
    ? renderer
    : createMarkdownRenderer();
  const tokens = parser.parse(markdown, {});

  /** @type {{ taskLineNumber: number | null }[]} */
  const listItemStack = [];
  for (const token of tokens) {
    if (token.type === "list_item_open") {
      const classValue = token.attrGet ? token.attrGet("class") : "";
      const classes = String(classValue || "")
        .split(/\s+/)
        .filter(Boolean);
      const isTaskListItem = classes.includes("task-list-item");
      let taskLineNumber = null;

      if (isTaskListItem && Array.isArray(token.map)) {
        const start = Math.max(0, token.map[0] || 0);
        const end = Math.min(
          lines.length,
          Number.isInteger(token.map[1]) ? token.map[1] : start + 1
        );
        for (let lineNumber = start; lineNumber < end; lineNumber += 1) {
          if (taskByLine.has(lineNumber)) {
            taskLineNumber = lineNumber;
            break;
          }
        }
      }

      let parentLineNumber = null;
      for (let index = listItemStack.length - 1; index >= 0; index -= 1) {
        const candidate = listItemStack[index].taskLineNumber;
        if (Number.isInteger(candidate)) {
          parentLineNumber = candidate;
          break;
        }
      }

      listItemStack.push({ taskLineNumber });
      if (!Number.isInteger(taskLineNumber)) {
        continue;
      }

      const task = taskByLine.get(taskLineNumber);
      if (!task) {
        continue;
      }

      task.parentLineNumber = parentLineNumber;
      if (Number.isInteger(parentLineNumber)) {
        const parentTask = taskByLine.get(parentLineNumber);
        if (parentTask && !parentTask.childLineNumbers.includes(taskLineNumber)) {
          parentTask.childLineNumbers.push(taskLineNumber);
        }
      }
      continue;
    }

    if (token.type === "list_item_close" && listItemStack.length > 0) {
      listItemStack.pop();
    }
  }

  /**
   * @param {{
   *   lineNumber: number;
   *   text: string;
   *   completed: boolean;
   *   parentLineNumber: number | null;
   *   childLineNumbers: number[];
   *   descendantLineNumbers: number[];
   * }} task
   */
  const collectDescendants = (task) => {
    /** @type {number[]} */
    const descendants = [];
    for (const childLineNumber of task.childLineNumbers) {
      descendants.push(childLineNumber);
      const childTask = taskByLine.get(childLineNumber);
      if (!childTask) {
        continue;
      }
      descendants.push(...collectDescendants(childTask));
    }
    const uniqueDescendants = Array.from(new Set(descendants));
    task.descendantLineNumbers = uniqueDescendants;
    return uniqueDescendants;
  };

  for (const task of tasks) {
    collectDescendants(task);
  }

  return tasks;
}

/**
 * @param {string} markdown
 */
function buildSectionListMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headingPattern = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

  /** @type {{ lineNumber: number; level: number }[]} */
  const headings = [];
  /** @type {Set<number>} */
  const taskLineNumbers = new Set();

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    const headingMatch = line.match(headingPattern);
    if (headingMatch) {
      headings.push({
        lineNumber,
        level: headingMatch[1].length
      });
    }

    if (TODO_TASK_PATTERN.test(line)) {
      taskLineNumbers.add(lineNumber);
    }
  }

  /** @type {Set<number>} */
  const includedHeadingLines = new Set();
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    let sectionEndLine = lines.length;

    for (let nextIndex = index + 1; nextIndex < headings.length; nextIndex += 1) {
      const next = headings[nextIndex];
      if (next.level <= current.level) {
        sectionEndLine = next.lineNumber;
        break;
      }
    }

    let hasTask = false;
    for (
      let sectionLine = current.lineNumber + 1;
      sectionLine < sectionEndLine;
      sectionLine += 1
    ) {
      if (taskLineNumbers.has(sectionLine)) {
        hasTask = true;
        break;
      }
    }

    if (hasTask) {
      includedHeadingLines.add(current.lineNumber);
    }
  }

  /** @type {string[]} */
  const outputLines = [];
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    const isHeading = headingPattern.test(line);
    const isTask = taskLineNumbers.has(lineNumber);
    const isBlank = line.trim().length === 0;

    if (isHeading) {
      if (includedHeadingLines.has(lineNumber)) {
        outputLines.push(line);
      }
      continue;
    }

    if (isTask) {
      outputLines.push(line);
      continue;
    }

    if (isBlank && outputLines.length > 0 && outputLines[outputLines.length - 1] !== "") {
      outputLines.push("");
    }
  }

  while (outputLines.length > 0 && outputLines[0] === "") {
    outputLines.shift();
  }
  while (outputLines.length > 0 && outputLines[outputLines.length - 1] === "") {
    outputLines.pop();
  }

  return outputLines.join("\n");
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
 *   tasks: {
 *     lineNumber: number;
 *     text: string;
 *     completed: boolean;
 *     parentLineNumber: number | null;
 *     childLineNumbers: number[];
 *     descendantLineNumbers: number[];
 *   }[];
 *   markdownHtml: string;
 *   sectionListHtml: string;
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
    completed: task.completed,
    parentLineNumber: task.parentLineNumber,
    childLineNumbers: Array.isArray(task.childLineNumbers)
      ? task.childLineNumbers.filter((entry) => Number.isInteger(entry))
      : [],
    descendantLineNumbers: Array.isArray(task.descendantLineNumbers)
      ? task.descendantLineNumbers.filter((entry) => Number.isInteger(entry))
      : []
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
        --header-pinned-bg: #ffffff;
        --border: rgba(88, 103, 130, 0.24);
        --text-main: #27344d;
        --text-dim: #66758f;
        --accent: #de79a9;
        --accent-strong: #c95d90;
        --ok: #78c79d;
        --checkbox-checked-surface:
          radial-gradient(
            circle at 32% 28%,
            rgba(255, 255, 255, 0.72),
            rgba(255, 255, 255, 0) 42%
          ),
          linear-gradient(
            145deg,
            rgba(128, 207, 164, 0.22),
            rgba(128, 207, 164, 0.46)
          );
        --checkbox-tick-fill: linear-gradient(180deg, #2f8b5b 0%, #67c48f 100%);
        --checkbox-checked-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.34),
          0 6px 12px rgba(74, 139, 101, 0.14);
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
        --code-text: #eef4ff;
        --code-border: rgba(171, 186, 214, 0.24);
        --inline-code-bg: rgba(88, 103, 130, 0.16);
        --inline-code-text: #314764;
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

      .card.header-pinned {
        overflow: visible;
      }

      .card::after {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: inherit;
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

      .card.header-pinned .header {
        position: sticky;
        top: 0;
        z-index: 18;
        background: var(--header-pinned-bg);
        border-top-left-radius: 16px;
        border-top-right-radius: 16px;
        backdrop-filter: none;
      }

      .header-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 14px;
        flex-wrap: wrap;
      }

      .title {
        margin: 0;
        font-size: 1.35rem;
        flex: 1 1 260px;
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .header-controls {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        margin-left: auto;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .pin-toggle {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        border: none;
        background: transparent;
        color: var(--text-dim);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition:
          color 180ms ease,
          transform 180ms ease;
      }

      .pin-toggle svg {
        width: 20px;
        height: 20px;
        transition: transform 180ms ease;
      }

      .pin-toggle:hover {
        transform: translateY(-1px);
        color: var(--text-main);
      }

      .pin-toggle[aria-pressed="true"] {
        color: var(--accent);
      }

      .pin-toggle[aria-pressed="true"] svg {
        transform: rotate(-16deg);
      }

      .pin-toggle[aria-pressed="true"] svg path {
        fill: currentColor !important;
      }

      .pin-toggle:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
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
        overscroll-behavior: contain;
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

      .view-mode-group {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--filter-bg);
      }

      .view-mode-option {
        appearance: none;
        width: 34px;
        height: 34px;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: var(--text-dim);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition:
          color 160ms ease,
          background-color 160ms ease,
          transform 160ms ease,
          box-shadow 180ms ease;
      }

      .view-mode-option svg {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
      }

      .view-mode-option:hover {
        color: var(--text-main);
        transform: translateY(-1px);
      }

      .view-mode-option.active {
        color: var(--surface-strong);
        background: var(--accent);
        box-shadow: 0 8px 18px rgba(33, 51, 82, 0.14);
      }

      .view-mode-option:focus-visible {
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
        position: relative;
        border-radius: 50%;
        border: 2px solid var(--text-dim);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        overflow: hidden;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
        transition:
          border-color 180ms ease,
          background 180ms ease,
          box-shadow 180ms ease;
      }

      .todo-item.completed .checkbox {
        border-color: var(--ok);
        background: var(--checkbox-checked-surface);
        box-shadow: var(--checkbox-checked-shadow);
      }

      .checkbox::after {
        content: "";
        position: absolute;
        top: 50%;
        left: 50%;
        width: 11px;
        height: 11px;
        background: var(--checkbox-tick-fill);
        -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M3.4 8.6L6.5 11.4L12.7 4.9' stroke='black' stroke-width='2.7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M3.4 8.6L6.5 11.4L12.7 4.9' stroke='black' stroke-width='2.7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        -webkit-mask-repeat: no-repeat;
        mask-repeat: no-repeat;
        -webkit-mask-size: contain;
        mask-size: contain;
        -webkit-mask-position: center;
        mask-position: center;
        opacity: 0;
        transform: translate(-50%, -54%) scale(0.72) rotate(-8deg);
        transition:
          opacity 160ms ease,
          transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1),
          background 180ms ease;
      }

      .todo-item.completed .checkbox::after {
        opacity: 1;
        transform: translate(-50%, -54%) scale(1) rotate(-8deg);
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
        color: var(--code-text);
        border: 1px solid var(--code-border);
        overflow: auto;
      }

      .markdown-content code {
        font-family: "SF Mono", "JetBrains Mono", Menlo, monospace;
      }

      .markdown-content pre code {
        color: inherit;
        background: transparent;
      }

      .markdown-content :not(pre) > code {
        padding: 2px 6px;
        border-radius: 6px;
        background: var(--inline-code-bg);
        color: var(--inline-code-text);
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
        color: var(--text-main);
      }

      .markdown-content li.task-list-item.nested-parent {
        align-items: flex-start;
      }

      .markdown-content li.task-list-item .todo-toggle {
        margin-top: 0;
        align-self: center;
        flex-shrink: 0;
        text-decoration: none;
      }

      .markdown-content li.task-list-item.nested-parent > .todo-toggle {
        align-self: flex-start;
        margin-top: 0.16rem;
      }

      .markdown-content li.task-list-item .task-body {
        flex: 1 1 auto;
        min-width: 0;
      }

      .markdown-content li.task-list-item .task-label {
        display: inline-block;
        max-width: 100%;
        cursor: pointer;
      }

      .markdown-content li.task-list-item .task-label > p {
        margin: 0;
      }

      .markdown-content li.task-list-item .task-label > p + p {
        margin-top: 0.45rem;
      }

      .markdown-content li.task-list-item .task-label > *:first-child {
        margin-top: 0 !important;
      }

      .markdown-content li.task-list-item .task-label > *:last-child {
        margin-bottom: 0 !important;
      }

      .markdown-content li.task-list-item.completed > .task-body > .task-label {
        color: var(--text-dim);
        text-decoration: line-through;
        text-decoration-color: rgba(88, 103, 130, 0.35);
      }

      .markdown-content li.task-list-item.completed > .todo-toggle .checkbox {
        border-color: var(--ok);
        background: var(--checkbox-checked-surface);
        box-shadow: var(--checkbox-checked-shadow);
      }

      .markdown-content li.task-list-item.completed > .todo-toggle .checkbox::after {
        opacity: 1;
        transform: translate(-50%, -54%) scale(1) rotate(-8deg);
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
          flex-direction: row;
          align-items: center;
        }

        .header-controls {
          width: auto;
          justify-content: flex-end;
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
            <div class="view-mode-group" role="radiogroup" aria-label="View mode">
              <button
                type="button"
                class="view-mode-option"
                data-view-mode="markdown"
                role="radio"
                aria-label="Markdown view"
                title="Markdown"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M29.693 25.849H2.308a2.31 2.31 0 0 1-2.307-2.307V8.459a2.31 2.31 0 0 1 2.307-2.307h27.385A2.31 2.31 0 0 1 32 8.459v15.078a2.305 2.305 0 0 1-2.307 2.307zm-22-4.62v-6l3.078 3.849l3.073-3.849v6h3.078V10.771h-3.078l-3.073 3.849l-3.078-3.849H4.615v10.464zM28.307 16h-3.078v-5.229h-3.073V16h-3.078l4.615 5.385z"
                  />
                </svg>
              </button>
              <button
                type="button"
                class="view-mode-option"
                data-view-mode="sections"
                role="radio"
                aria-label="Section list view"
                title="Section List"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" aria-hidden="true">
                  <g
                    fill="none"
                    stroke="currentColor"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="1"
                  >
                    <path d="M3.5 4.506v5.5a2 2 0 0 0 2 2h1m-3-5h3" />
                    <path d="M3.637.506C3 .506 2.4.53 1.86.586C1.294.644.76.982.608 1.53C.535 1.794.5 2.095.5 2.506s.035.713.108.977c.152.548.686.886 1.252.944c.541.056 1.141.08 1.777.08s1.235-.024 1.776-.08c.566-.058 1.1-.396 1.252-.944c.073-.264.109-.565.109-.977c0-.411-.036-.712-.109-.976C6.514.982 5.98.644 5.413.586a18 18 0 0 0-1.776-.08M10 5.464c-.799 0-1.548.024-2.209.079c-.49.041-.996.264-1.175.722c-.078.201-.116.43-.116.741c0 .312.038.541.116.742c.18.458.684.68 1.175.722c.66.055 1.41.079 2.209.079s1.548-.024 2.209-.079c.49-.041.996-.264 1.175-.722c.078-.201.116-.43.116-.742c0-.311-.038-.54-.116-.74c-.18-.46-.684-.682-1.175-.723c-.66-.055-1.41-.079-2.209-.079m0 4.946c-.799 0-1.548.023-2.209.078c-.49.042-.996.264-1.175.723c-.078.2-.116.43-.116.74s.038.541.116.742c.18.459.684.681 1.175.722c.66.056 1.41.079 2.209.079s1.548-.023 2.209-.079c.49-.04.996-.263 1.175-.722c.078-.2.116-.43.116-.741s-.038-.54-.116-.741c-.18-.46-.684-.681-1.175-.723c-.66-.055-1.41-.078-2.209-.078" />
                  </g>
                </svg>
              </button>
              <button
                type="button"
                class="view-mode-option"
                data-view-mode="list"
                role="radio"
                aria-label="List view"
                title="List"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="currentColor"
                    fill-rule="evenodd"
                    d="M8.048 2.488a.75.75 0 0 1-.036 1.06l-4.286 4a.75.75 0 0 1-1.095-.076l-1.214-1.5a.75.75 0 0 1 1.166-.944l.708.875l3.697-3.451a.75.75 0 0 1 1.06.036M11.25 5a.75.75 0 0 1 .75-.75h10a.75.75 0 0 1 0 1.5H12a.75.75 0 0 1-.75-.75M8.048 9.488a.75.75 0 0 1-.036 1.06l-4.286 4a.75.75 0 0 1-1.095-.076l-1.214-1.5a.75.75 0 1 1 1.166-.944l.708.875l3.697-3.451a.75.75 0 0 1 1.06.036M11.25 12a.75.75 0 0 1 .75-.75h10a.75.75 0 0 1 0 1.5H12a.75.75 0 0 1-.75-.75m-3.202 4.488a.75.75 0 0 1-.036 1.06l-4.286 4a.75.75 0 0 1-1.095-.076l-1.214-1.5a.75.75 0 1 1 1.166-.944l.708.875l3.697-3.451a.75.75 0 0 1 1.06.036M11.25 19a.75.75 0 0 1 .75-.75h10a.75.75 0 0 1 0 1.5H12a.75.75 0 0 1-.75-.75"
                    clip-rule="evenodd"
                  />
                </svg>
              </button>
            </div>
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
            <button
              type="button"
              class="pin-toggle"
              id="pin-header-toggle"
              aria-pressed="false"
              aria-label="Pin header"
              title="Pin header"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="1.5"
                  d="m3 21l5-5m5.259 2.871c-3.744-.85-7.28-4.386-8.13-8.13c-.135-.592-.202-.888-.007-1.369c.194-.48.433-.63.909-.927c1.076-.672 2.242-.886 3.451-.78c1.697.151 2.546.226 2.97.005c.423-.22.71-.736 1.286-1.767l.728-1.307c.48-.86.72-1.291 1.285-1.494s.905-.08 1.585.166a5.63 5.63 0 0 1 3.396 3.396c.246.68.369 1.02.166 1.585c-.203.564-.633.804-1.494 1.285l-1.337.745c-1.03.574-1.544.862-1.765 1.289c-.22.428-.14 1.258.02 2.918c.118 1.22-.085 2.394-.766 3.484c-.298.476-.447.714-.928.909c-.48.194-.777.127-1.37-.008"
                />
              </svg>
            </button>
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
        <article id="section-list-view" class="markdown-content" hidden></article>
      </section>
    </main>

    <script>
      const vscode = acquireVsCodeApi();
      let tasks = ${JSON.stringify(safeTasks)};
      const markdownHtml = ${JSON.stringify(data.markdownHtml)};
      const sectionListHtml = ${JSON.stringify(data.sectionListHtml)};
      const mermaidScriptUrl = ${JSON.stringify(data.mermaidScriptUri)};
      const initialThemePreference = ${JSON.stringify(safeThemePreference)};
      const filterOptions = new Set(["all", "pending", "completed"]);
      const viewModeOptions = new Set(["markdown", "sections", "list"]);
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
          headerPinnedBg: "#ffffff",
          border: "rgba(88, 103, 130, 0.24)",
          textMain: "#27344d",
          textDim: "#66758f",
          ok: "#78c79d",
          checkboxCheckedSurface:
            "radial-gradient(circle at 32% 28%, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0) 42%), linear-gradient(145deg, rgba(128, 207, 164, 0.22), rgba(128, 207, 164, 0.46))",
          checkboxTickFill:
            "linear-gradient(180deg, #2f8b5b 0%, #67c48f 100%)",
          checkboxCheckedShadow:
            "inset 0 1px 0 rgba(255, 255, 255, 0.34), 0 6px 12px rgba(74, 139, 101, 0.14)",
          shadow: "0 18px 40px rgba(72, 88, 120, 0.2)",
          filterBg: "rgba(88, 103, 130, 0.08)",
          sliderOff: "rgba(88, 103, 130, 0.16)",
          sliderKnob: "#ffffff",
          tableHead: "rgba(88, 103, 130, 0.1)",
          codeBg: "rgba(46, 59, 86, 0.92)",
          codeText: "#eef4ff",
          codeBorder: "rgba(171, 186, 214, 0.24)",
          inlineCodeBg: "rgba(88, 103, 130, 0.16)",
          inlineCodeText: "#314764",
          radialBg: "rgba(255, 255, 255, 0.95)",
          radialBorder: "rgba(88, 103, 130, 0.3)",
          modePillBg: "rgba(88, 103, 130, 0.1)",
          scrollShadow: "rgba(31, 42, 64, 0.28)"
        },
        dark: {
          surface: "rgba(29, 34, 47, 0.76)",
          surfaceStrong: "rgba(248, 250, 255, 0.9)",
          headerPinnedBg: "#1d222f",
          border: "rgba(175, 187, 224, 0.24)",
          textMain: "#e6ebff",
          textDim: "#b6c0de",
          ok: "#7ad6aa",
          checkboxCheckedSurface:
            "radial-gradient(circle at 34% 24%, rgba(255, 255, 255, 0.22), rgba(255, 255, 255, 0) 40%), linear-gradient(150deg, rgba(80, 148, 113, 0.92), rgba(38, 88, 67, 0.98))",
          checkboxTickFill:
            "linear-gradient(180deg, #f7fff9 0%, #cff7df 100%)",
          checkboxCheckedShadow:
            "inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 8px 18px rgba(2, 10, 7, 0.34)",
          shadow: "0 24px 48px rgba(7, 10, 20, 0.52)",
          filterBg: "rgba(175, 187, 224, 0.14)",
          sliderOff: "rgba(175, 187, 224, 0.25)",
          sliderKnob: "#eff4ff",
          tableHead: "rgba(175, 187, 224, 0.16)",
          codeBg: "rgba(9, 12, 20, 0.86)",
          codeText: "#f3f7ff",
          codeBorder: "rgba(175, 187, 224, 0.2)",
          inlineCodeBg: "rgba(175, 187, 224, 0.2)",
          inlineCodeText: "#eff4ff",
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
      let viewMode = viewModeOptions.has(savedState.viewMode)
        ? savedState.viewMode
        : typeof savedState.onlyTodo === "boolean"
          ? savedState.onlyTodo
            ? "list"
            : "markdown"
          : "list";
      let headerPinned =
        typeof savedState.headerPinned === "boolean"
          ? savedState.headerPinned
          : false;
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
      const WHEEL_STEP_THRESHOLD_PX = 34;
      const WHEEL_GESTURE_RESET_MS = 220;
      /** @type {{ plain: number; gradient: number }} */
      const wheelAccumByLayer = { plain: 0, gradient: 0 };
      /** @type {{ plain: number; gradient: number }} */
      const wheelLastEventByLayer = { plain: 0, gradient: 0 };

      const list = document.getElementById("todo-list");
      const empty = document.getElementById("empty");
      const stats = document.getElementById("stats");
      const contentRoot = document.getElementById("content-root");
      const todoView = document.getElementById("todo-view");
      const markdownView = document.getElementById("markdown-view");
      const sectionListView = document.getElementById("section-list-view");
      const card = document.querySelector(".card");
      const filterToolbar = document.getElementById("filter-toolbar");
      const viewModeButtons = Array.from(
        document.querySelectorAll(".view-mode-option")
      );
      const pinHeaderToggle = document.getElementById("pin-header-toggle");
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
        vscode.setState({ activeFilter, viewMode, headerPinned });
      };

      const applyHeaderPinState = () => {
        if (card) {
          card.classList.toggle("header-pinned", headerPinned);
        }

        if (pinHeaderToggle) {
          pinHeaderToggle.setAttribute("aria-pressed", String(headerPinned));
          pinHeaderToggle.setAttribute(
            "aria-label",
            headerPinned ? "Unpin header" : "Pin header"
          );
          pinHeaderToggle.title = headerPinned ? "Unpin header" : "Pin header";
        }
      };

      const persistThemePreference = () => {
        vscode.postMessage({
          type: "saveThemePreference",
          preference: themePreference
        });
      };

      const updateTaskStatusesLocally = (updates) => {
        /** @type {{ lineNumber: number; completed: boolean }[]} */
        const appliedUpdates = [];

        updates.forEach((update) => {
          const index = tasks.findIndex(
            (task) => task.lineNumber === update.lineNumber
          );
          if (index < 0) {
            return;
          }

          if (tasks[index].completed === update.completed) {
            return;
          }

          tasks[index] = {
            ...tasks[index],
            completed: update.completed
          };
          appliedUpdates.push({
            lineNumber: update.lineNumber,
            completed: update.completed
          });
        });

        return appliedUpdates;
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
          "--header-pinned-bg": modeBase.headerPinnedBg,
          "--border": modeBase.border,
          "--text-main": modeBase.textMain,
          "--text-dim": modeBase.textDim,
          "--accent": selected.accent,
          "--accent-strong": selected.accentStrong,
          "--ok": modeBase.ok,
          "--checkbox-checked-surface": modeBase.checkboxCheckedSurface,
          "--checkbox-tick-fill": modeBase.checkboxTickFill,
          "--checkbox-checked-shadow": modeBase.checkboxCheckedShadow,
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
          "--code-text": modeBase.codeText,
          "--code-border": modeBase.codeBorder,
          "--inline-code-bg": modeBase.inlineCodeBg,
          "--inline-code-text": modeBase.inlineCodeText,
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

      const renderMermaidDiagrams = async (container) => {
        const mermaidCodeBlocks = Array.from(
          container.querySelectorAll(
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
            nodes: container.querySelectorAll(".mermaid")
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

      const decorateTaskItems = (container) => {
        const taskItems = Array.from(container.querySelectorAll("li.task-list-item"));
        taskItems.forEach((item, index) => {
          const task = tasks[index];
          if (!task) {
            return;
          }

          item.classList.toggle("completed", task.completed);
          item.classList.toggle(
            "nested-parent",
            Array.isArray(task.childLineNumbers) &&
              task.childLineNumbers.length > 0
          );

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

          let currentLabel = null;
          nodesToMove.forEach((node) => {
            const isNestedList =
              node.nodeType === Node.ELEMENT_NODE &&
              (node.tagName === "UL" || node.tagName === "OL");

            if (isNestedList) {
              currentLabel = null;
              taskBody.appendChild(node);
              return;
            }

            if (!currentLabel) {
              currentLabel = document.createElement("div");
              currentLabel.className = "task-label";
              taskBody.appendChild(currentLabel);
            }

            currentLabel.appendChild(node);
          });

          item.appendChild(taskBody);
        });
      };

      const renderMarkdown = () => {
        markdownView.innerHTML = markdownHtml;
        decorateTaskItems(markdownView);
        void renderMermaidDiagrams(markdownView);
      };

      const renderSectionList = () => {
        sectionListView.innerHTML = sectionListHtml;
        decorateTaskItems(sectionListView);
      };

      const render = () => {
        applyHeaderPinState();
        viewModeButtons.forEach((button) => {
          const isActive = button.dataset.viewMode === viewMode;
          button.classList.toggle("active", isActive);
          button.setAttribute("aria-checked", String(isActive));
        });

        const isListMode = viewMode === "list";
        filterToolbar.hidden = !isListMode;
        filterToolbar.style.display = isListMode ? "flex" : "none";
        stats.hidden = !isListMode;
        todoView.hidden = !isListMode;
        markdownView.hidden = viewMode !== "markdown";
        sectionListView.hidden = viewMode !== "sections";

        if (isListMode) {
          renderTodoList();
          return;
        }

        if (viewMode === "sections") {
          renderSectionList();
        } else {
          renderMarkdown();
        }
      };

      viewModeButtons.forEach((button) => {
        button.addEventListener("click", () => {
          const nextMode = button.dataset.viewMode;
          if (!viewModeOptions.has(nextMode) || nextMode === viewMode) {
            return;
          }
          viewMode = nextMode;
          persistState();
          render();
        });
      });

      pinHeaderToggle?.addEventListener("click", () => {
        headerPinned = !headerPinned;
        persistState();
        applyHeaderPinState();
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

      const normalizeWheelDeltaToPixels = (event) => {
        if (!(event instanceof WheelEvent)) {
          return 0;
        }

        let deltaY = event.deltaY;
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
          deltaY *= 16;
        } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
          deltaY *= window.innerHeight;
        }

        return deltaY;
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
          event.preventDefault();
          event.stopPropagation();

          const targetLayer = getScrollLayerFromPointer(event);
          if (!targetLayer) {
            return;
          }

          const normalizedDelta = normalizeWheelDeltaToPixels(event);
          if (!Number.isFinite(normalizedDelta) || normalizedDelta === 0) {
            return;
          }

          const now = Number(event.timeStamp) || performance.now();
          if (now - wheelLastEventByLayer[targetLayer] > WHEEL_GESTURE_RESET_MS) {
            wheelAccumByLayer[targetLayer] = 0;
          }
          wheelLastEventByLayer[targetLayer] = now;

          const previousAccum = wheelAccumByLayer[targetLayer];
          if (previousAccum !== 0 && Math.sign(previousAccum) !== Math.sign(normalizedDelta)) {
            wheelAccumByLayer[targetLayer] = 0;
          }

          wheelAccumByLayer[targetLayer] += normalizedDelta;
          if (Math.abs(wheelAccumByLayer[targetLayer]) < WHEEL_STEP_THRESHOLD_PX) {
            return;
          }

          rotateLayer(targetLayer, wheelAccumByLayer[targetLayer] > 0 ? 1 : -1);
          wheelAccumByLayer[targetLayer] = 0;
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
          const markdownTaskLabel = event.target.closest(
            "li.task-list-item .task-label"
          );
          if (markdownTaskLabel) {
            toggleButton = markdownTaskLabel
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
        if (!message || typeof message.type !== "string") {
          return;
        }

        /** @type {{ lineNumber: number; completed: boolean }[]} */
        let incomingUpdates = [];
        if (message.type === "tasksToggled") {
          const updates = Array.isArray(message.updates) ? message.updates : [];
          incomingUpdates = updates
            .map((update) => ({
              lineNumber: Number(update?.lineNumber),
              completed: Boolean(update?.completed)
            }))
            .filter((update) => Number.isInteger(update.lineNumber));
        } else if (message.type === "taskToggled") {
          const lineNumber = Number(message.lineNumber);
          if (!Number.isInteger(lineNumber)) {
            return;
          }
          incomingUpdates = [
            {
              lineNumber,
              completed: Boolean(message.completed)
            }
          ];
        } else {
          return;
        }

        if (incomingUpdates.length === 0) {
          return;
        }

        const appliedUpdates = updateTaskStatusesLocally(incomingUpdates);
        if (appliedUpdates.length === 0) {
          return;
        }

        if (viewMode === "list") {
          renderTodoList();
          return;
        }

        const activeMarkdownContainer =
          viewMode === "sections" ? sectionListView : markdownView;

        appliedUpdates.forEach((update) => {
          const markdownTaskItem = activeMarkdownContainer.querySelector(
            \`li.task-list-item .todo-toggle[data-line-number="\${update.lineNumber}"]\`
          )?.closest("li.task-list-item");
          if (markdownTaskItem) {
            markdownTaskItem.classList.toggle("completed", update.completed);
          }
        });
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
