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
const TODO_TASK_PATTERN = /^(\s*-\s\[)( |x|X)(\]\s+)(.*)$/;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const command = vscode.commands.registerCommand(
    "todomark.open",
    () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor || !isMarkdownDocument(editor.document)) {
        vscode.window.showWarningMessage(
          "Open a Markdown (.md) file first to launch TodoMark."
        );
        return;
      }

      const document = editor.document;
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
          mermaidScriptUri
        });
      };

      updatePanel();

      let updateTimer = null;
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
          if (!message || message.type !== "toggleTask") {
            return;
          }

          const lineNumber = Number(message.lineNumber);
          if (
            !Number.isInteger(lineNumber) ||
            lineNumber < 0 ||
            lineNumber >= document.lineCount
          ) {
            vscode.window.showWarningMessage(
              "Could not toggle todo: invalid task line."
            );
            return;
          }

          const line = document.lineAt(lineNumber);
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

          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            document.uri,
            new vscode.Range(markerStart, markerEnd),
            nextMarker
          );

          const applied = await vscode.workspace.applyEdit(edit);
          if (!applied) {
            vscode.window.showWarningMessage(
              "Could not toggle todo: edit was not applied."
            );
          }
        }
      );

      const changeSubscription = vscode.workspace.onDidChangeTextDocument(
        (event) => {
          if (event.document.uri.toString() === document.uri.toString()) {
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
 * }} data
 */
function getWebviewHtml(data) {
  const safeDisplayName = escapeHtml(formatDisplayFileName(data.filePath));
  const safeTasks = data.tasks.map((task) => ({
    lineNumber: task.lineNumber,
    text: escapeHtml(task.text),
    completed: task.completed
  }));
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
        --bg-1: #fdf2f8;
        --bg-2: #edf6ff;
        --bg-3: #ecfff5;
        --surface: rgba(255, 255, 255, 0.78);
        --border: rgba(88, 103, 130, 0.24);
        --text-main: #27344d;
        --text-dim: #66758f;
        --accent: #f6b8c9;
        --accent-strong: #f29bb3;
        --ok: #80cfa4;
      }

      * {
        box-sizing: border-box;
      }

      [hidden] {
        display: none !important;
      }

      body {
        margin: 0;
        min-height: 100vh;
        color: var(--text-main);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at 10% 10%, rgba(246, 184, 201, 0.35), transparent 35%),
          radial-gradient(circle at 80% 20%, rgba(179, 230, 213, 0.32), transparent 35%),
          linear-gradient(135deg, var(--bg-1), var(--bg-2) 55%, var(--bg-3));
        padding: 24px;
      }

      .card {
        max-width: 1024px;
        margin: 0 auto;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 16px;
        backdrop-filter: blur(6px);
        overflow: hidden;
        box-shadow: 0 18px 40px rgba(94, 111, 141, 0.18);
      }

      .header {
        padding: 20px 24px 14px;
        border-bottom: 1px solid var(--border);
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
        background: rgba(88, 103, 130, 0.16);
        transition: all 180ms ease;
      }

      .slider::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #ffffff;
        transition: transform 180ms ease;
      }

      .switch input:checked + .slider {
        border-color: var(--accent);
        background: rgba(246, 184, 201, 0.85);
      }

      .switch input:checked + .slider::after {
        transform: translateX(22px);
        background: #4a2c3a;
      }

      .switch input:focus-visible + .slider {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      .toolbar {
        display: flex;
        gap: 10px;
        padding: 16px 24px;
        flex-wrap: wrap;
        border-bottom: 1px solid var(--border);
      }

      .filter {
        appearance: none;
        border: 1px solid var(--border);
        background: rgba(88, 103, 130, 0.08);
        color: var(--text-main);
        border-radius: 999px;
        padding: 8px 14px;
        font-size: 0.92rem;
        cursor: pointer;
        transition: all 140ms ease;
      }

      .filter.active {
        background: var(--accent);
        border-color: var(--accent);
        color: #4a2c3a;
        font-weight: 600;
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
      }

      .todo-item.completed .todo-text {
        color: var(--text-dim);
        text-decoration: line-through;
        text-decoration-color: rgba(88, 103, 130, 0.35);
      }

      .stats {
        padding: 0 24px 16px;
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
        color: var(--accent);
      }

      .markdown-content blockquote {
        margin-left: 0;
        padding: 0.4rem 0.9rem;
        border-left: 3px solid rgba(246, 184, 201, 0.7);
        background: rgba(246, 184, 201, 0.16);
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
        background: rgba(88, 103, 130, 0.1);
      }

      .markdown-content pre {
        padding: 12px 14px;
        border-radius: 10px;
        background: rgba(46, 59, 86, 0.92);
        overflow: auto;
      }

      .markdown-content code {
        font-family: "SF Mono", "JetBrains Mono", Menlo, monospace;
      }

      .markdown-content :not(pre) > code {
        padding: 2px 6px;
        border-radius: 6px;
        background: rgba(88, 103, 130, 0.16);
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
        align-items: flex-start;
        gap: 12px;
        margin: 0.4rem 0;
        padding: 0;
        border: none;
      }

      .markdown-content li.task-list-item .todo-toggle {
        margin-top: 0.2rem;
        flex-shrink: 0;
        text-decoration: none;
      }

      .markdown-content li.task-list-item .task-body {
        flex: 1 1 auto;
        min-width: 0;
      }

      .markdown-content li.task-list-item .task-body > p {
        margin: 0;
      }

      .markdown-content li.task-list-item .task-body > p + p {
        margin-top: 0.45rem;
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
      }
    </style>
  </head>
  <body>
    <main class="card">
      <header class="header">
        <div class="header-top">
          <h1 class="title">${safeDisplayName}</h1>
          <label class="only-todo-control">
            <span>Only Todo</span>
            <span class="switch">
              <input id="only-todo-switch" type="checkbox" />
              <span class="slider"></span>
            </span>
          </label>
        </div>
      </header>
      <section class="toolbar" id="filter-toolbar">
        <button class="filter" data-filter="all">all</button>
        <button class="filter" data-filter="pending">pending</button>
        <button class="filter" data-filter="completed">completed</button>
      </section>
      <section class="content" id="content-root">
        <section id="todo-view">
          <ul class="todo-list" id="todo-list"></ul>
          <p class="empty" id="empty" hidden>No todos match this filter.</p>
        </section>
        <article id="markdown-view" class="markdown-content" hidden></article>
      </section>
      <footer class="stats" id="stats"></footer>
    </main>

    <script>
      const vscode = acquireVsCodeApi();
      const tasks = ${JSON.stringify(safeTasks)};
      const markdownHtml = ${JSON.stringify(data.markdownHtml)};
      const mermaidScriptUrl = ${JSON.stringify(data.mermaidScriptUri)};
      const filterOptions = new Set(["all", "pending", "completed"]);
      const savedState = vscode.getState() || {};
      let activeFilter = filterOptions.has(savedState.activeFilter)
        ? savedState.activeFilter
        : "all";
      let onlyTodo =
        typeof savedState.onlyTodo === "boolean" ? savedState.onlyTodo : true;
      let mermaidInitialized = false;
      let mermaidScriptPromise = null;

      const list = document.getElementById("todo-list");
      const empty = document.getElementById("empty");
      const stats = document.getElementById("stats");
      const contentRoot = document.getElementById("content-root");
      const todoView = document.getElementById("todo-view");
      const markdownView = document.getElementById("markdown-view");
      const filterToolbar = document.getElementById("filter-toolbar");
      const onlyTodoSwitch = document.getElementById("only-todo-switch");
      const filterButtons = Array.from(document.querySelectorAll(".filter"));

      const persistState = () => {
        vscode.setState({ activeFilter, onlyTodo });
      };

      const passesFilter = (task) => {
        if (activeFilter === "pending") return !task.completed;
        if (activeFilter === "completed") return task.completed;
        return true;
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
            (node) => node !== toggle
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

        const toggleButton = event.target.closest(".todo-toggle");
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
