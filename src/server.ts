import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";

import {
  type CollabState,
  type ClientMutation,
  type ClientMutationMessage,
  type ClientPresenceMessage,
  type SavedCollabState,
  type ServerHelloMessage,
  type ServerMutationMessage,
  type ServerPresenceMessage,
  type ServerPresenceLeaveMessage,
  applyClientMutations,
  collabFromMarkdown,
  collabToMarkdown,
  saveCollabState,
  loadCollabState,
  newCollabState,
  idBeforeIndex,
  idAtIndex,
} from "./collab.js";
import hljs from "highlight.js";
import { marked, type Tokens } from "marked";
import sanitizeHtml from "sanitize-html";


type CommentAnchor = {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
};

type CommentMessage = {
  id: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

type CommentThread = {
  id: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  anchor: CommentAnchor;
  messages: CommentMessage[];
};

type ShareAccess = "none" | "view" | "comment" | "edit";

type NoteMetaFile = {
  id: string;
  title: string;
  shareId: string;
  shareAccess: ShareAccess;
  createdAt: string;
  updatedAt: string;
  threads: CommentThread[];
  collab?: SavedCollabState;
  collabState?: SavedCollabState;
};

type NoteRecord = {
  id: string;
  title: string;
  shareId: string;
  shareAccess: ShareAccess;
  createdAt: string;
  updatedAt: string;
  threads: CommentThread[];
  markdown: string;
  collab: CollabState;
  clientAcks: Map<string, number>;
};

type NoteSummary = {
  id: string;
  title: string;
  updatedAt: string;
  shareId: string;
  snippet: string;
};

type DeviceToken = {
  id: string;
  salt: string;
  hash: string;
  createdAt: string;
  lastUsedAt: string;
};

type ApiKey = {
  id: string;
  label: string;
  keySalt: string;
  keyHash: string;
  createdAt: string;
};

type AuthData = {
  passwordSalt: string;
  passwordHash: string;
  tokens: DeviceToken[];
  apiKeys?: ApiKey[];
};

type ViewerInfo = {
  isOwner: boolean;
  commenterName: string | null;
  hasCommenterIdentity: boolean;
};

function cliArg(name: string) {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.split("=").slice(1).join("=") : null;
}

const port = Number(cliArg("port") || process.env.PORT || 3210);
const dataDir = cliArg("data") || process.env.DATA_DIR || path.join(process.cwd(), "data");
const notesDir = path.join(dataDir, "notes");
const authFilePath = path.join(dataDir, "auth.json");
const publicDir = path.join(path.resolve(__dirname, ".."), "public");
const ownerSessionCookieName = "md_owner_session";
const ownerLocalStorageTokenKey = "md_owner_token";
const commenterIdCookieName = "md_commenter_id";
const commenterNameCookieName = "md_commenter_name";
const ownerCookieMaxAgeSeconds = 60 * 60 * 24 * 30;
const commenterCookieMaxAgeSeconds = 60 * 60 * 24 * 365;
const notes = new Map<string, NoteRecord>();

const codeRenderer = new marked.Renderer();
codeRenderer.code = ({ text, lang }: Tokens.Code) => {
  const language = (lang || "").trim().split(/\s+/)[0];
  const validLanguage = language && hljs.getLanguage(language) ? language : null;
  const highlighted = validLanguage
    ? hljs.highlight(text, { language: validLanguage }).value
    : escapeHtml(text);
  const languageClass = validLanguage ? ` class="hljs language-${escapeHtml(validLanguage)}"` : ' class="hljs"';
  return `<pre><code${languageClass}>${highlighted}</code></pre>`;
};

marked.setOptions({
  gfm: true,
  breaks: true,
  renderer: codeRenderer,
});

ensureDirectories();
loadNotesIntoMemory();

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use("/static", express.static(publicDir));

app.get("/health", (_req, res) => {
  res.type("text/plain").send("ok");
});

app.get("/login", (req, res) => {
  if (isOwnerAuthenticated(req)) {
    res.redirect("/");
    return;
  }

  res.send(renderAuthPage(authConfigured() ? "login" : "setup"));
});

app.get("/", requireOwnerPage, (_req, res) => {
  res.send(renderAppShell("list", "Notes"));
});

app.get("/notes/:id", requireOwnerPage, (req, res) => {
  const note = notes.get(String(req.params.id));
  if (!note) {
    res.status(404).send(renderSimplePage("Not found", `<p>Note not found.</p><p><a href="/">Back</a></p>`));
    return;
  }

  res.send(renderAppShell("editor", note.title, { noteId: note.id }));
});

app.get("/s/:shareId", (req, res) => {
  const note = findNoteByShareId(String(req.params.shareId));
  if (!note || note.shareAccess === "none") {
    res.status(404).send(renderSimplePage("Not found", `<p>Shared note not found.</p>`));
    return;
  }

  res.send(renderAppShell("public", note.title, { shareId: note.shareId, shareAccess: note.shareAccess }));
});

app.get("/api/viewer", (req, res) => {
  res.json({
    ok: true,
    authConfigured: authConfigured(),
    ownerAuthenticated: isOwnerAuthenticated(req),
    ownerLocalStorageTokenKey,
    viewer: buildViewerInfo(req),
  });
});

app.post("/api/auth/setup", (req, res) => {
  if (authConfigured()) {
    res.status(400).json({ ok: false, error: "Password already configured." });
    return;
  }

  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirmPassword || "");

  if (password.length < 8) {
    res.status(400).json({ ok: false, error: "Use at least 8 characters." });
    return;
  }

  if (password !== confirmPassword) {
    res.status(400).json({ ok: false, error: "Passwords do not match." });
    return;
  }

  const token = initializeOwnerAuth(password);
  res.json({ ok: true, token, ownerLocalStorageTokenKey });
});

app.post("/api/auth/login", (req, res) => {
  if (!authConfigured()) {
    res.status(400).json({ ok: false, error: "Password is not configured yet." });
    return;
  }

  const password = String(req.body.password || "");
  if (!passwordMatches(password)) {
    res.status(401).json({ ok: false, error: "Wrong password." });
    return;
  }

  const token = issueOwnerToken();
  res.json({ ok: true, token, ownerLocalStorageTokenKey });
});

app.post("/api/auth/token", (req, res) => {
  const token = String(req.body.token || "");
  if (!token || !verifyOwnerToken(token)) {
    clearOwnerSessionCookie(req, res);
    res.status(401).json({ ok: false });
    return;
  }

  setOwnerSessionCookie(req, res, token);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  const token = getOwnerSessionToken(req);
  if (token) {
    revokeOwnerToken(token);
  }

  clearOwnerSessionCookie(req, res);
  res.json({ ok: true });
});

app.get("/api/keys", requireOwnerApi, (_req, res) => {
  res.json({ ok: true, keys: listApiKeys() });
});

app.post("/api/keys", requireOwnerApi, (req, res) => {
  const label = String(req.body.label || "unnamed");
  const result = createApiKey(label);
  res.json({ ok: true, ...result });
});

app.delete("/api/keys/:id", requireOwnerApi, (req, res) => {
  const deleted = deleteApiKey(String(req.params.id));
  if (!deleted) {
    res.status(404).json({ ok: false, error: "API key not found." });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/notes/:id/edit", requireOwnerApi, (req, res) => {
  const note = notes.get(String(req.params.id));
  if (!note) {
    res.status(404).json({ ok: false, error: "Note not found." });
    return;
  }

  const edits = req.body.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    res.status(400).json({ ok: false, error: "edits must be a non-empty array of {oldText, newText}." });
    return;
  }

  let workingCollab = note.collab;
  let markdown = note.markdown;
  let senderCounter = 0;
  const errors: string[] = [];
  const idListUpdates: ServerMutationMessage["idListUpdates"] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const oldText = String(edit?.oldText || "");
    const newText = String(edit?.newText || "");

    if (!oldText) {
      errors.push(`Edit ${i}: oldText is empty.`);
      continue;
    }

    const firstIndex = markdown.indexOf(oldText);
    if (firstIndex === -1) {
      errors.push(`Edit ${i}: oldText not found.`);
      continue;
    }

    const secondIndex = markdown.indexOf(oldText, firstIndex + 1);
    if (secondIndex !== -1) {
      errors.push(`Edit ${i}: oldText is ambiguous (found ${countOccurrences(markdown, oldText)} times).`);
      continue;
    }

    let nextClientCounter = senderCounter + 1;
    const mutations: ClientMutation[] = [];

    if (oldText.length > 0) {
      mutations.push({
        name: "delete",
        clientCounter: nextClientCounter++,
        args: {
          startId: idAtIndex(workingCollab, firstIndex),
          endId: idAtIndex(workingCollab, firstIndex + oldText.length - 1),
          contentLength: oldText.length,
        },
      });
    }

    if (newText.length > 0) {
      mutations.push({
        name: "insert",
        clientCounter: nextClientCounter++,
        args: {
          before: firstIndex > 0 ? idBeforeIndex(workingCollab, firstIndex) : null,
          id: { bunchId: crypto.randomUUID(), counter: 0 },
          content: newText,
          isInWord: false,
        },
      });
    }

    const result = applyClientMutations(workingCollab, mutations);
    workingCollab = result.state;
    markdown = result.markdown;
    idListUpdates.push(...result.idListUpdates);
    senderCounter = mutations.at(-1)?.clientCounter || senderCounter;
  }

  if (errors.length > 0) {
    res.status(400).json({ ok: false, errors });
    return;
  }

  note.collab = workingCollab;
  note.markdown = markdown;
  note.updatedAt = nowIso();
  const titleChanged = Object.prototype.hasOwnProperty.call(req.body || {}, "title")
    && normalizeTitle(String(req.body.title || note.title)) !== note.title;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "title")) {
    note.title = normalizeTitle(String(req.body.title || note.title));
  }
  persistNote(note, false);

  if (titleChanged) {
    broadcastEditorHello(note);
  } else if (idListUpdates.length > 0) {
    broadcastEditorMutation(note, {
      type: "mutation",
      senderId: "__api__",
      senderCounter,
      serverCounter: note.collab.serverCounter,
      markdown: note.markdown,
      idListUpdates,
    });
  }
  broadcastNoteUpdate(note);

  res.json({ ok: true, savedAt: note.updatedAt });
});

app.post("/api/notes/:id/threads", requireOwnerApi, (req, res) => {
  const note = notes.get(String(req.params.id));
  if (!note) {
    res.status(404).json({ ok: false, error: "Note not found." });
    return;
  }

  const quote = String(req.body.quote || "");
  const body = normalizeCommentBody(String(req.body.body || ""));
  if (!quote || !body) {
    res.status(400).json({ ok: false, error: "quote and body are required." });
    return;
  }

  const start = note.markdown.indexOf(quote);
  if (start === -1) {
    res.status(400).json({ ok: false, error: "Quoted text not found in note." });
    return;
  }

  const prefix = note.markdown.slice(Math.max(0, start - 32), start);
  const end = start + quote.length;
  const suffix = note.markdown.slice(end, end + 32);

  const bearer = getBearerToken(req);
  const apiKeyLabel = bearer ? getApiKeyLabel(bearer) : null;
  const authorName = apiKeyLabel || "Owner";

  const anchor: CommentAnchor = { quote, prefix, suffix, start, end };
  const thread: CommentThread = {
    id: createId(10),
    resolved: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    anchor,
    messages: [
      {
        id: createId(10),
        parentId: null,
        authorId: "__owner__",
        authorName,
        body,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    ],
  };

  note.threads.push(thread);
  note.updatedAt = nowIso();
  persistNote(note);
  broadcastThreadsUpdated(note);
  res.json({ ok: true, thread: { id: thread.id } });
});

app.post("/api/notes/:id/threads/:threadId/replies", requireOwnerApi, (req, res) => {
  const note = notes.get(String(req.params.id));
  if (!note) {
    res.status(404).json({ ok: false, error: "Note not found." });
    return;
  }

  const thread = note.threads.find((t) => t.id === String(req.params.threadId));
  if (!thread) {
    res.status(404).json({ ok: false, error: "Thread not found." });
    return;
  }

  const body = normalizeCommentBody(String(req.body.body || ""));
  const parentMessageId = String(req.body.parentMessageId || thread.messages[0]?.id || "");
  if (!body) {
    res.status(400).json({ ok: false, error: "body is required." });
    return;
  }

  if (!thread.messages.some((m) => m.id === parentMessageId)) {
    res.status(400).json({ ok: false, error: "Parent message not found." });
    return;
  }

  const bearer = getBearerToken(req);
  const apiKeyLabel = bearer ? getApiKeyLabel(bearer) : null;
  const authorName = apiKeyLabel || "Owner";
  const timestamp = nowIso();

  thread.messages.push({
    id: createId(10),
    parentId: parentMessageId,
    authorId: "__owner__",
    authorName,
    body,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  thread.updatedAt = timestamp;
  note.updatedAt = timestamp;
  persistNote(note);
  broadcastThreadsUpdated(note);
  res.json({ ok: true });
});

app.patch("/api/notes/:id/threads/:threadId", requireOwnerApi, (req, res) => {
  const note = notes.get(String(req.params.id));
  if (!note) { res.status(404).json({ ok: false, error: "Note not found." }); return; }
  const thread = note.threads.find((t) => t.id === String(req.params.threadId));
  if (!thread) { res.status(404).json({ ok: false, error: "Thread not found." }); return; }
  thread.resolved = Boolean(req.body.resolved);
  thread.updatedAt = nowIso();
  note.updatedAt = thread.updatedAt;
  persistNote(note);
  broadcastThreadsUpdated(note);
  res.json({ ok: true });
});

app.delete("/api/notes/:id/threads/:threadId", requireOwnerApi, (req, res) => {
  const note = notes.get(String(req.params.id));
  if (!note) { res.status(404).json({ ok: false, error: "Note not found." }); return; }
  note.threads = note.threads.filter((t) => t.id !== String(req.params.threadId));
  note.updatedAt = nowIso();
  persistNote(note);
  broadcastThreadsUpdated(note);
  res.json({ ok: true });
});

app.patch("/api/notes/:id/messages/:messageId", requireOwnerApi, (req, res) => {
  const note = notes.get(String(req.params.id));
  if (!note) { res.status(404).json({ ok: false, error: "Note not found." }); return; }
  const located = locateMessage(note, String(req.params.messageId));
  if (!located) { res.status(404).json({ ok: false, error: "Message not found." }); return; }
  const body = normalizeCommentBody(String(req.body.body || ""));
  if (!body) { res.status(400).json({ ok: false, error: "Body is required." }); return; }
  located.message.body = body;
  located.message.updatedAt = nowIso();
  located.thread.updatedAt = located.message.updatedAt;
  note.updatedAt = located.message.updatedAt;
  persistNote(note);
  broadcastThreadsUpdated(note);
  res.json({ ok: true });
});

app.delete("/api/notes/:id/messages/:messageId", requireOwnerApi, (req, res) => {
  const note = notes.get(String(req.params.id));
  if (!note) { res.status(404).json({ ok: false, error: "Note not found." }); return; }
  const located = locateMessage(note, String(req.params.messageId));
  if (!located) { res.status(404).json({ ok: false, error: "Message not found." }); return; }
  located.thread.messages = located.thread.messages.filter((m) => m.id !== located.message.id);
  if (located.thread.messages.length === 0) {
    note.threads = note.threads.filter((t) => t.id !== located.thread.id);
  } else {
    located.thread.updatedAt = nowIso();
  }
  note.updatedAt = nowIso();
  persistNote(note);
  broadcastThreadsUpdated(note);
  res.json({ ok: true });
});

app.delete("/api/notes/:id", requireOwnerApi, (req, res) => {
  const id = String(req.params.id);
  const note = notes.get(id);
  if (!note) {
    res.status(404).json({ ok: false, error: "Note not found." });
    return;
  }

  notes.delete(id);
  try { fs.unlinkSync(noteMarkdownPath(id)); } catch {}
  try { fs.unlinkSync(noteMetaPath(id)); } catch {}
  res.json({ ok: true });
});

app.get("/api/notes", requireOwnerApi, (req, res) => {
  const query = String(req.query.q || "");
  const results = searchNotes(query);
  res.json({ ok: true, notes: results });
});

app.post("/api/notes", requireOwnerApi, (_req, res) => {
  const note = createNote();
  res.json({ ok: true, note: summarizeNote(note, "") });
});

app.get("/api/notes/:id", requireOwnerApi, (req, res) => {
  const note = notes.get(String(req.params.id));
  if (!note) {
    res.status(404).json({ ok: false, error: "Note not found." });
    return;
  }

  const offset = req.query.offset ? Number(req.query.offset) : null;
  const limit = req.query.limit ? Number(req.query.limit) : null;

  if (offset !== null || limit !== null) {
    const lines = note.markdown.split("\n");
    const start = Math.max(0, (offset || 1) - 1);
    const end = limit ? Math.min(lines.length, start + limit) : lines.length;
    const slice = lines.slice(start, end);
    const totalLines = lines.length;
    const remaining = totalLines - end;

    res.json({
      ok: true,
      note: {
        id: note.id,
        title: note.title,
        totalLines,
        offset: start + 1,
        limit: slice.length,
        remaining,
        content: slice.map((line, i) => `${start + i + 1}: ${line}`).join("\n"),
      },
    });
    return;
  }

  res.json({ ok: true, ...serializeNoteForClient(note, req) });
});

app.put("/api/notes/:id", requireOwnerApi, (req, res) => {
  const note = notes.get(String(req.params.id));
  if (!note) {
    res.status(404).json({ ok: false, error: "Note not found." });
    return;
  }

  const titleProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "title");
  const markdownProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "markdown");
  const shareAccessProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "shareAccess");
  const nextTitle = titleProvided ? normalizeTitle(String(req.body.title || note.title)) : note.title;
  const nextMarkdown = markdownProvided ? String(req.body.markdown || "") : note.markdown;
  const nextShareAccess = shareAccessProvided && ["none", "view", "comment", "edit"].includes(req.body.shareAccess)
    ? (req.body.shareAccess as ShareAccess)
    : note.shareAccess;
  const titleChanged = nextTitle !== note.title;
  const markdownChanged = nextMarkdown !== note.markdown;

  const shareAccessChanged = nextShareAccess !== note.shareAccess;

  note.title = nextTitle;
  note.shareAccess = nextShareAccess;
  if (markdownChanged) {
    note.collab = collabFromMarkdown(nextMarkdown, note.collab.serverCounter + 1);
    note.markdown = nextMarkdown;
  }
  note.updatedAt = nowIso();
  persistNote(note, false);
  if (shareAccessChanged) {
    enforceShareAccessForConnections(note);
  }
  if (titleChanged || markdownChanged || shareAccessChanged) {
    broadcastEditorHello(note);
    broadcastNoteUpdate(note);
  }
  res.json({ ok: true, savedAt: note.updatedAt, shareAccess: note.shareAccess });
});

app.get("/api/notes/:id/collab", requireOwnerApi, (req, res) => {
  const note = notes.get(String(req.params.id));
  if (!note) {
    res.status(404).json({ ok: false, error: "Note not found." });
    return;
  }

  res.json({
    ok: true,
    noteId: note.id,
    title: note.title,
    shareId: note.shareId,
    shareUrl: makeShareUrl(req, note.shareId),
    serverCounter: note.collab.serverCounter,
    collabState: saveCollabState(note.collab),
  });
});

app.get("/api/share/:shareId/collab", (req, res) => {
  const note = requireShareAccess(req, res, "edit");
  if (!note) return;

  res.json({
    ok: true,
    noteId: note.id,
    title: note.title,
    shareId: note.shareId,
    shareUrl: makeShareUrl(req, note.shareId),
    serverCounter: note.collab.serverCounter,
    collabState: saveCollabState(note.collab),
  });
});

app.post("/api/render", requireOwnerApi, (req, res) => {
  const markdown = String(req.body.markdown || "");
  res.json({ ok: true, html: renderMarkdown(markdown) });
});

app.post("/api/share/:shareId/edit", (req, res) => {
  const note = requireShareAccess(req, res, "edit");
  if (!note) return;

  const edits = req.body.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    res.status(400).json({ ok: false, error: "edits must be a non-empty array of {oldText, newText}." });
    return;
  }

  let workingCollab = note.collab;
  let markdown = note.markdown;
  let senderCounter = 0;
  const errors: string[] = [];
  const idListUpdates: ServerMutationMessage["idListUpdates"] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const oldText = String(edit?.oldText || "");
    const newText = String(edit?.newText || "");

    if (!oldText) {
      errors.push(`Edit ${i}: oldText is empty.`);
      continue;
    }

    const firstIndex = markdown.indexOf(oldText);
    if (firstIndex === -1) {
      errors.push(`Edit ${i}: oldText not found.`);
      continue;
    }

    const secondIndex = markdown.indexOf(oldText, firstIndex + 1);
    if (secondIndex !== -1) {
      errors.push(`Edit ${i}: oldText is ambiguous (found ${countOccurrences(markdown, oldText)} times).`);
      continue;
    }

    let nextClientCounter = senderCounter + 1;
    const mutations: ClientMutation[] = [];

    if (oldText.length > 0) {
      mutations.push({
        name: "delete",
        clientCounter: nextClientCounter++,
        args: {
          startId: idAtIndex(workingCollab, firstIndex),
          endId: idAtIndex(workingCollab, firstIndex + oldText.length - 1),
          contentLength: oldText.length,
        },
      });
    }

    if (newText.length > 0) {
      mutations.push({
        name: "insert",
        clientCounter: nextClientCounter++,
        args: {
          before: firstIndex > 0 ? idBeforeIndex(workingCollab, firstIndex) : null,
          id: { bunchId: crypto.randomUUID(), counter: 0 },
          content: newText,
          isInWord: false,
        },
      });
    }

    const result = applyClientMutations(workingCollab, mutations);
    workingCollab = result.state;
    markdown = result.markdown;
    idListUpdates.push(...result.idListUpdates);
    senderCounter = mutations.at(-1)?.clientCounter || senderCounter;
  }

  if (errors.length > 0) {
    res.status(400).json({ ok: false, errors });
    return;
  }

  note.collab = workingCollab;
  note.markdown = markdown;
  note.updatedAt = nowIso();
  persistNote(note, false);

  if (idListUpdates.length > 0) {
    broadcastEditorMutation(note, {
      type: "mutation",
      senderId: "__api__",
      senderCounter,
      serverCounter: note.collab.serverCounter,
      markdown: note.markdown,
      idListUpdates,
    });
  }
  broadcastNoteUpdate(note);
  res.json({ ok: true, savedAt: note.updatedAt });
});

app.post("/api/share/:shareId/render", (req, res) => {
  const note = requireShareAccess(req, res, "view");
  if (!note) return;
  const markdown = String(req.body.markdown || "");
  res.json({ ok: true, html: renderMarkdown(markdown) });
});

app.get("/api/share/:shareId", (req, res) => {
  const note = requireShareAccess(req, res, "view");
  if (!note) return;

  res.json({ ok: true, ...serializeNoteForClient(note, req) });
});

app.get("/api/share/:shareId/note", (req, res) => {
  const note = requireShareAccess(req, res, "view");
  if (!note) return;

  res.json({
    ok: true,
    note: {
      id: note.id,
      title: note.title,
      markdown: note.markdown,
      shareAccess: note.shareAccess,
      updatedAt: note.updatedAt,
    },
    threads: serializeThreads(note, req),
  });
});

app.post("/api/share/:shareId/identity", (req, res) => {
  const note = requireShareAccess(req, res, "comment");
  if (!note) return;

  const name = normalizeCommenterName(String(req.body.name || ""));
  if (!name) {
    res.status(400).json({ ok: false, error: "Name is required." });
    return;
  }

  const commenterId = getOrCreateCommenterId(req, res);
  setCommenterNameCookie(req, res, name);
  res.json({
    ok: true,
    commenterIdSet: Boolean(commenterId),
    viewer: buildViewerInfo(req, { commenterNameOverride: name, hasCommenterIdentityOverride: true }),
  });
});

app.post("/api/share/:shareId/threads", (req, res) => {
  const note = requireShareAccess(req, res, "comment");
  if (!note) return;

  const identity = ensureCommentAuthor(req, res);
  if (!identity) {
    res.status(400).json({ ok: false, error: "Set your name first." });
    return;
  }

  const anchor = sanitizeAnchor(req.body.anchor);
  const body = normalizeCommentBody(String(req.body.body || ""));
  if (!anchor || !body) {
    res.status(400).json({ ok: false, error: "Anchor and comment body are required." });
    return;
  }

  const thread: CommentThread = {
    id: createId(10),
    resolved: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    anchor,
    messages: [
      {
        id: createId(10),
        parentId: null,
        authorId: identity.authorId,
        authorName: identity.authorName,
        body,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    ],
  };

  note.threads.push(thread);
  note.updatedAt = nowIso();
  persistNote(note);
  broadcastThreadsUpdated(note);
  res.json({ ok: true, threads: serializeThreads(note, req) });
});

app.post("/api/share/:shareId/threads/:threadId/replies", (req, res) => {
  const note = requireShareAccess(req, res, "comment");
  if (!note) return;

  const thread = note.threads.find((item) => item.id === String(req.params.threadId));
  if (!thread) {
    res.status(404).json({ ok: false, error: "Thread not found." });
    return;
  }

  const identity = ensureCommentAuthor(req, res);
  if (!identity) {
    res.status(400).json({ ok: false, error: "Set your name first." });
    return;
  }

  const body = normalizeCommentBody(String(req.body.body || ""));
  if (!body) {
    res.status(400).json({ ok: false, error: "Reply body is required." });
    return;
  }

  const requestedParentId = typeof req.body.parentMessageId === "string" ? String(req.body.parentMessageId) : "";
  const parentMessageId = requestedParentId || thread.messages[0]?.id || "";
  if (!parentMessageId || !thread.messages.some((message) => message.id === parentMessageId)) {
    res.status(400).json({ ok: false, error: "Parent message not found." });
    return;
  }

  const timestamp = nowIso();
  thread.messages.push({
    id: createId(10),
    parentId: parentMessageId,
    authorId: identity.authorId,
    authorName: identity.authorName,
    body,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  thread.updatedAt = timestamp;
  note.updatedAt = timestamp;
  persistNote(note);
  broadcastThreadsUpdated(note);
  res.json({ ok: true, threads: serializeThreads(note, req) });
});

app.patch("/api/share/:shareId/threads/:threadId", (req, res) => {
  const note = requireShareAccess(req, res, "comment");
  if (!note) return;

  const thread = note.threads.find((item) => item.id === String(req.params.threadId));
  if (!thread) {
    res.status(404).json({ ok: false, error: "Thread not found." });
    return;
  }

  if (!canManageThread(req, thread)) {
    res.status(403).json({ ok: false, error: "Not allowed." });
    return;
  }

  thread.resolved = Boolean(req.body.resolved);
  thread.updatedAt = nowIso();
  note.updatedAt = thread.updatedAt;
  persistNote(note);
  broadcastThreadsUpdated(note);
  res.json({ ok: true, threads: serializeThreads(note, req) });
});

app.delete("/api/share/:shareId/threads/:threadId", (req, res) => {
  const note = requireShareAccess(req, res, "comment");
  if (!note) return;

  const thread = note.threads.find((item) => item.id === String(req.params.threadId));
  if (!thread) {
    res.status(404).json({ ok: false, error: "Thread not found." });
    return;
  }

  if (!isOwnerAuthenticated(req)) {
    res.status(403).json({ ok: false, error: "Only the owner can delete a whole thread." });
    return;
  }

  note.threads = note.threads.filter((item) => item.id !== thread.id);
  note.updatedAt = nowIso();
  persistNote(note);
  broadcastThreadsUpdated(note);
  res.json({ ok: true, threads: serializeThreads(note, req) });
});

app.patch("/api/share/:shareId/messages/:messageId", (req, res) => {
  const note = requireShareAccess(req, res, "comment");
  if (!note) return;

  const located = locateMessage(note, String(req.params.messageId));
  if (!located) {
    res.status(404).json({ ok: false, error: "Message not found." });
    return;
  }

  if (!canManageMessage(req, located.message)) {
    res.status(403).json({ ok: false, error: "Not allowed." });
    return;
  }

  const body = normalizeCommentBody(String(req.body.body || ""));
  if (!body) {
    res.status(400).json({ ok: false, error: "Body is required." });
    return;
  }

  located.message.body = body;
  located.message.updatedAt = nowIso();
  located.thread.updatedAt = located.message.updatedAt;
  note.updatedAt = located.message.updatedAt;
  persistNote(note);
  broadcastThreadsUpdated(note);
  res.json({ ok: true, threads: serializeThreads(note, req) });
});

app.delete("/api/share/:shareId/messages/:messageId", (req, res) => {
  const note = requireShareAccess(req, res, "comment");
  if (!note) return;

  const located = locateMessage(note, String(req.params.messageId));
  if (!located) {
    res.status(404).json({ ok: false, error: "Message not found." });
    return;
  }

  if (!canManageMessage(req, located.message)) {
    res.status(403).json({ ok: false, error: "Not allowed." });
    return;
  }

  located.thread.messages = located.thread.messages.filter((message) => message.id !== located.message.id);
  if (located.thread.messages.length === 0) {
    note.threads = note.threads.filter((thread) => thread.id !== located.thread.id);
  } else {
    located.thread.updatedAt = nowIso();
  }

  note.updatedAt = nowIso();
  persistNote(note);
  broadcastThreadsUpdated(note);
  res.json({ ok: true, threads: serializeThreads(note, req) });
});

app.use((_req, res) => {
  res.status(404).send(renderSimplePage("Not found", `<p>Page not found.</p>`));
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).json({ ok: false, error: "Internal server error." });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const CURSOR_COLORS = ["#4285f4", "#ea4335", "#34a853", "#fbbc04", "#9c27b0", "#ff6d00", "#00bcd4", "#e91e63"];
let nextColorIndex = 0;

type ClientConn = {
  ws: WebSocket;
  kind: "editor" | "public-editor" | "public-viewer";
  noteId: string;
  shareId: string;
  clientId: string;
  name: string;
  color: string;
  alive: boolean;
  selection?: ClientPresenceMessage["selection"];
};

const clients: ClientConn[] = [];
let clientIdCounter = 0;

const heartbeatInterval = setInterval(() => {
  for (const conn of clients) {
    if (!conn.alive) {
      conn.ws.terminate();
      continue;
    }
    conn.alive = false;
    if (conn.ws.readyState === 1) {
      conn.ws.ping();
    }
  }
}, 30000);

wss.on("close", () => clearInterval(heartbeatInterval));

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://localhost:${port}`);
  const noteId = url.searchParams.get("noteId") || "";
  const shareId = url.searchParams.get("shareId") || "";

  if (noteId) {
    if (!isOwnerAuthenticatedIncomingRequest(req)) {
      ws.close();
      return;
    }

    const note = notes.get(noteId);
    if (!note) {
      ws.close();
      return;
    }

    const clientId = `c${++clientIdCounter}`;
    const color = CURSOR_COLORS[nextColorIndex++ % CURSOR_COLORS.length];
    const conn: ClientConn = { ws, kind: "editor", noteId: note.id, shareId: note.shareId, clientId, name: "Owner", color, alive: true };
    clients.push(conn);
    sendServerMessage(ws, { ...buildHelloMessage(note), clientId });
    sendExistingPresence(conn);

    ws.on("pong", () => { conn.alive = true; });
    ws.on("message", (data) => handleEditorMessage(conn, String(data)));
    ws.on("close", () => handleDisconnect(conn));
    ws.on("error", () => handleDisconnect(conn));
    return;
  }

  if (shareId) {
    const note = findNoteByShareId(shareId);
    if (!note || note.shareAccess === "none") {
      ws.close();
      return;
    }

    if (note.shareAccess === "edit") {
      const commenterName = getCommenterIdentityFromHeaders(req.headers).name;
      const clientId = `c${++clientIdCounter}`;
      const color = CURSOR_COLORS[nextColorIndex++ % CURSOR_COLORS.length];
      const conn: ClientConn = { ws, kind: "public-editor", noteId: note.id, shareId: note.shareId, clientId, name: commenterName || "Anonymous", color, alive: true };
      clients.push(conn);
      sendServerMessage(ws, { ...buildHelloMessage(note), clientId });
      sendExistingPresence(conn);

      ws.on("pong", () => { conn.alive = true; });
      ws.on("message", (data) => handleEditorMessage(conn, String(data)));
      ws.on("close", () => handleDisconnect(conn));
      ws.on("error", () => handleDisconnect(conn));
      return;
    }

    const clientId = `c${++clientIdCounter}`;
    const conn: ClientConn = { ws, kind: "public-viewer", noteId: note.id, shareId: note.shareId, clientId, name: "", color: "", alive: true };
    clients.push(conn);
    ws.on("pong", () => { conn.alive = true; });
    ws.on("close", () => handleDisconnect(conn));
    ws.on("error", () => handleDisconnect(conn));
    return;
  }

  ws.close();
});

function isCollaborativeConn(conn: ClientConn, noteId: string) {
  return (conn.kind === "editor" || conn.kind === "public-editor") && conn.noteId === noteId;
}

function handleDisconnect(conn: ClientConn) {
  const index = clients.indexOf(conn);
  if (index !== -1) {
    clients.splice(index, 1);
  }
  if (conn.kind === "editor" || conn.kind === "public-editor") {
    broadcastPresenceLeave(conn);
  }
}

function handleEditorMessage(conn: ClientConn, data: string) {
  let message: ClientMutationMessage | ClientPresenceMessage;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }

  if (message.type === "presence") {
    const presenceMsg = message as ClientPresenceMessage;
    if (presenceMsg.clientId !== conn.clientId) {
      return;
    }
    conn.selection = presenceMsg.selection;
    broadcastPresence(conn, presenceMsg);
    return;
  }

  if (message.type !== "mutation" || !(message as ClientMutationMessage).clientId || !Array.isArray((message as ClientMutationMessage).mutations) || (message as ClientMutationMessage).mutations.length === 0) {
    return;
  }

  const mutationMsg = message as ClientMutationMessage;
  if (mutationMsg.clientId !== conn.clientId) {
    return;
  }

  const note = notes.get(conn.noteId);
  if (!note) {
    return;
  }

  const senderCounter = mutationMsg.mutations.at(-1)?.clientCounter || 0;
  const lastAcknowledgedCounter = note.clientAcks.get(mutationMsg.clientId) || 0;
  const freshMutations = mutationMsg.mutations.filter((mutation) => mutation.clientCounter > lastAcknowledgedCounter);

  if (freshMutations.length === 0) {
    sendServerMessage(conn.ws, {
      type: "mutation",
      senderId: mutationMsg.clientId,
      senderCounter,
      serverCounter: note.collab.serverCounter,
      markdown: note.markdown,
      idListUpdates: [],
    });
    return;
  }

  let result;
  try {
    result = applyClientMutations(note.collab, freshMutations);
  } catch (error) {
    console.error(error);
    sendServerMessage(conn.ws, { ...buildHelloMessage(note), clientId: conn.clientId });
    return;
  }
  note.clientAcks.set(mutationMsg.clientId, senderCounter);

  if (!result.changed) {
    sendServerMessage(conn.ws, {
      type: "mutation",
      senderId: mutationMsg.clientId,
      senderCounter,
      serverCounter: note.collab.serverCounter,
      markdown: note.markdown,
      idListUpdates: [],
    });
    return;
  }

  note.collab = result.state;
  note.markdown = result.markdown;
  note.updatedAt = nowIso();
  persistNote(note, false);

  broadcastEditorMutation(note, {
    type: "mutation",
    senderId: mutationMsg.clientId,
    senderCounter,
    serverCounter: note.collab.serverCounter,
    markdown: note.markdown,
    idListUpdates: result.idListUpdates,
  });
  broadcastNoteUpdate(note);
}

type AnyServerMessage = (ServerHelloMessage & { clientId?: string }) | ServerMutationMessage | ServerPresenceMessage | ServerPresenceLeaveMessage | { type: "updated"; noteId: string; shareId: string; updatedAt: string } | { type: "threads-updated"; noteId: string; shareId: string };

function sendServerMessage(ws: WebSocket, message: AnyServerMessage) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function buildHelloMessage(note: NoteRecord): ServerHelloMessage {
  return {
    type: "hello",
    noteId: note.id,
    title: note.title,
    shareId: note.shareId,
    markdown: note.markdown,
    idListState: saveCollabState(note.collab).idListState,
    serverCounter: note.collab.serverCounter,
  };
}

function sendExistingPresence(target: ClientConn) {
  for (const conn of clients) {
    if (conn === target || !isCollaborativeConn(conn, target.noteId) || !conn.selection) {
      continue;
    }
    sendServerMessage(target.ws, {
      type: "presence",
      clientId: conn.clientId,
      name: conn.name,
      color: conn.color,
      selection: conn.selection,
    });
  }
}

function broadcastEditorHello(note: NoteRecord) {
  const message = buildHelloMessage(note);
  for (const conn of clients) {
    if (isCollaborativeConn(conn, note.id)) {
      sendServerMessage(conn.ws, conn.clientId ? { ...message, clientId: conn.clientId } : message);
    }
  }
}

function broadcastEditorMutation(note: NoteRecord, message: ServerMutationMessage) {
  for (const conn of clients) {
    if (isCollaborativeConn(conn, note.id)) {
      sendServerMessage(conn.ws, message);
    }
  }
}

function enforceShareAccessForConnections(note: NoteRecord) {
  for (const conn of [...clients]) {
    if (conn.shareId !== note.shareId) {
      continue;
    }
    if (conn.kind === "public-editor" && note.shareAccess !== "edit") {
      try { conn.ws.close(); } catch {}
      continue;
    }
    if (conn.kind === "public-viewer" && note.shareAccess === "none") {
      try { conn.ws.close(); } catch {}
    }
  }
}

function broadcastNoteUpdate(note: NoteRecord) {
  const message = {
    type: "updated" as const,
    noteId: note.id,
    shareId: note.shareId,
    updatedAt: note.updatedAt,
  };
  for (const conn of clients) {
    if (conn.kind === "public-viewer" && conn.shareId === note.shareId) {
      sendServerMessage(conn.ws, message);
    }
  }
}

function broadcastThreadsUpdated(note: NoteRecord) {
  const message = { type: "threads-updated" as const, noteId: note.id, shareId: note.shareId };
  for (const conn of clients) {
    if (conn.noteId === note.id) {
      sendServerMessage(conn.ws, message);
    }
  }
}

function broadcastPresence(sender: ClientConn, message: ClientPresenceMessage) {
  const outgoing: ServerPresenceMessage = {
    type: "presence",
    clientId: sender.clientId,
    name: sender.name,
    color: sender.color,
    selection: message.selection,
  };
  for (const conn of clients) {
    if (conn === sender) continue;
    if (isCollaborativeConn(conn, sender.noteId)) {
      sendServerMessage(conn.ws, outgoing);
    }
  }
}

function broadcastPresenceLeave(sender: ClientConn) {
  const outgoing: ServerPresenceLeaveMessage = {
    type: "presence-leave",
    clientId: sender.clientId,
  };
  for (const conn of clients) {
    if (conn === sender) continue;
    if (isCollaborativeConn(conn, sender.noteId)) {
      sendServerMessage(conn.ws, outgoing);
    }
  }
}

server.listen(port, () => {
  console.log(`jot listening on http://localhost:${port}`);
  console.log(`data: ${path.resolve(dataDir)}`);
});

function ensureDirectories() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
}

function loadNotesIntoMemory() {
  notes.clear();
  const files = fs.readdirSync(notesDir).filter((file) => file.endsWith(".md"));

  for (const file of files) {
    const id = path.basename(file, ".md");
    const markdownPath = noteMarkdownPath(id);
    const metaPath = noteMetaPath(id);
    if (!fs.existsSync(metaPath)) {
      continue;
    }

    const markdown = fs.readFileSync(markdownPath, "utf8");
    const meta = readJson<NoteMetaFile | null>(metaPath, null);
    if (!meta) {
      continue;
    }

    const threads = Array.isArray(meta.threads)
      ? meta.threads.map((thread) => ({
          ...thread,
          messages: Array.isArray(thread.messages)
            ? thread.messages.map((message) => ({
                ...message,
                parentId: typeof message.parentId === "string" ? message.parentId : null,
              }))
            : [],
        }))
      : [];

    let collab: CollabState;
    if (meta.collab) {
      collab = loadCollabState(meta.collab);
    } else if (meta.collabState) {
      collab = loadCollabState(meta.collabState);
    } else {
      collab = collabFromMarkdown(markdown);
    }

    notes.set(id, {
      ...meta,
      shareAccess: (meta.shareAccess as ShareAccess) || "none",
      markdown: collabToMarkdown(collab),
      threads,
      collab,
      clientAcks: new Map(),
    });
  }
}

function noteMarkdownPath(id: string) {
  return path.join(notesDir, `${id}.md`);
}

function noteMetaPath(id: string) {
  return path.join(notesDir, `${id}.json`);
}

function readJson<T>(filePath: string, fallback: T) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createNote() {
  const timestamp = nowIso();
  const id = createShortId();
  const note: NoteRecord = {
    id,
    title: "untitled",
    shareId: createShortId(14),
    shareAccess: "none",
    createdAt: timestamp,
    updatedAt: timestamp,
    markdown: "",
    threads: [],
    collab: newCollabState(),
    clientAcks: new Map(),
  };

  notes.set(id, note);
  persistNote(note);
  return note;
}

function persistNote(note: NoteRecord, broadcastUpdate = true) {
  note.markdown = collabToMarkdown(note.collab);

  const meta: NoteMetaFile = {
    id: note.id,
    title: note.title,
    shareId: note.shareId,
    shareAccess: note.shareAccess,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    threads: note.threads,
    collab: saveCollabState(note.collab),
  };

  fs.writeFileSync(noteMarkdownPath(note.id), note.markdown, "utf8");
  writeJson(noteMetaPath(note.id), meta);
  if (broadcastUpdate) {
    broadcastNoteUpdate(note);
  }
}

function searchNotes(query: string) {
  const needle = query.trim().toLowerCase();
  return Array.from(notes.values())
    .map((note) => summarizeNote(note, needle))
    .filter((note) => {
      if (!needle) {
        return true;
      }

      return note.title.toLowerCase().includes(needle) || note.snippet.toLowerCase().includes(needle);
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function summarizeNote(note: NoteRecord, needle: string): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    updatedAt: note.updatedAt,
    shareId: note.shareId,
    snippet: buildSnippet(note, needle),
  };
}

function buildSnippet(note: NoteRecord, needle: string) {
  const source = note.markdown.replace(/\s+/g, " ").trim();
  if (!source) {
    return "";
  }

  if (!needle) {
    return source.slice(0, 140);
  }

  const index = source.toLowerCase().indexOf(needle);
  if (index === -1) {
    return source.slice(0, 140);
  }

  const start = Math.max(0, index - 40);
  const end = Math.min(source.length, index + needle.length + 80);
  return source.slice(start, end);
}

function findNoteByShareId(shareId: string) {
  for (const note of notes.values()) {
    if (note.shareId === shareId) {
      return note;
    }
  }

  return null;
}

function locateMessage(note: NoteRecord, messageId: string) {
  for (const thread of note.threads) {
    const message = thread.messages.find((item) => item.id === messageId);
    if (message) {
      return { thread, message };
    }
  }

  return null;
}

function buildViewerInfo(
  req: Request,
  overrides?: { commenterNameOverride?: string; hasCommenterIdentityOverride?: boolean },
): ViewerInfo {
  const commenter = getCommenterIdentity(req);
  return {
    isOwner: isOwnerAuthenticated(req),
    commenterName: overrides?.commenterNameOverride ?? commenter.name,
    hasCommenterIdentity: overrides?.hasCommenterIdentityOverride ?? Boolean(commenter.id),
  };
}

function serializeThreads(note: NoteRecord, req: Request) {
  const viewer = buildViewerInfo(req);
  const commenter = getCommenterIdentity(req);

  return [...note.threads]
    .sort((a, b) => {
      const startDelta = a.anchor.start - b.anchor.start;
      if (startDelta !== 0) {
        return startDelta;
      }
      return a.createdAt.localeCompare(b.createdAt);
    })
    .map((thread) => ({
    id: thread.id,
    resolved: thread.resolved,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    anchor: thread.anchor,
    canReply: viewer.isOwner || viewer.hasCommenterIdentity,
    canResolve: viewer.isOwner || viewer.hasCommenterIdentity,
    canDeleteThread: viewer.isOwner,
    messages: [...thread.messages]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((message) => ({
      id: message.id,
      parentId: message.parentId,
      authorName: message.authorName,
      body: message.body,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      canEdit: viewer.isOwner || (Boolean(commenter.id) && commenter.id === message.authorId),
      canDelete: viewer.isOwner || (Boolean(commenter.id) && commenter.id === message.authorId),
    })),
  }));
}

function serializeNoteForClient(note: NoteRecord, req: Request) {
  return {
    note: {
      id: note.id,
      title: note.title,
      markdown: note.markdown,
      renderedHtml: renderMarkdown(note.markdown),
      shareId: note.shareId,
      shareAccess: note.shareAccess,
      shareUrl: makeShareUrl(req, note.shareId),
      updatedAt: note.updatedAt,
      createdAt: note.createdAt,
    },
    viewer: buildViewerInfo(req),
    threads: serializeThreads(note, req),
  };
}

function requireOwnerPage(req: Request, res: Response, next: NextFunction) {
  if (!isOwnerAuthenticated(req)) {
    res.redirect("/login");
    return;
  }

  next();
}

function requireOwnerApi(req: Request, res: Response, next: NextFunction) {
  if (!isOwnerAuthenticated(req)) {
    res.status(401).json({ ok: false, error: "Unauthorized." });
    return;
  }

  next();
}

const shareAccessLevels: Record<ShareAccess, number> = { none: 0, view: 1, comment: 2, edit: 3 };

function requireShareAccess(req: Request, res: Response, minAccess: ShareAccess): NoteRecord | null {
  const note = findNoteByShareId(String(req.params.shareId));
  if (!note || shareAccessLevels[note.shareAccess] < shareAccessLevels[minAccess]) {
    res.status(404).json({ ok: false, error: "Shared note not found." });
    return null;
  }
  return note;
}

function countOccurrences(haystack: string, needle: string) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + 1);
  }
  return count;
}

function normalizeTitle(input: string) {
  return input.trim().slice(0, 160) || "untitled";
}

function normalizeCommentBody(input: string) {
  return input.trim().slice(0, 4000);
}

function normalizeCommenterName(input: string) {
  return input.trim().slice(0, 80);
}

function sanitizeAnchor(input: unknown) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const source = input as Record<string, unknown>;
  const quote = String(source.quote || "").slice(0, 1000);
  const prefix = String(source.prefix || "").slice(0, 200);
  const suffix = String(source.suffix || "").slice(0, 200);
  const start = Number(source.start);
  const end = Number(source.end);

  if (!quote || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    return null;
  }

  return { quote, prefix, suffix, start, end } satisfies CommentAnchor;
}

function renderMarkdown(markdown: string) {
  const rawHtml = marked.parse(markdown) as string;
  return sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "pre",
      "code",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "blockquote",
      "span",
    ]),
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title"],
      code: ["class"],
      span: ["class"],
    },
    allowedClasses: {
      code: ["hljs", /^language-/],
      span: [/^hljs.*/],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
    },
  });
}

function makeShareUrl(req: Request, shareId: string) {
  return `${req.protocol}://${req.get("host")}/s/${shareId}`;
}

function nowIso() {
  return new Date().toISOString();
}

function createShortId(length = 8) {
  return crypto.randomBytes(length).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, length);
}

function createId(length = 12) {
  return createShortId(length);
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hashSecret(value: string, salt: string) {
  return crypto.scryptSync(value, salt, 64).toString("hex");
}

function secureEqualsHex(a: string, b: string) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function loadAuthData() {
  return readJson<AuthData | null>(authFilePath, null);
}

function saveAuthData(authData: AuthData) {
  writeJson(authFilePath, authData);
}

function authConfigured() {
  const auth = loadAuthData();
  return Boolean(auth?.passwordSalt && auth?.passwordHash);
}

function passwordMatches(password: string) {
  const auth = loadAuthData();
  if (!auth) {
    return false;
  }

  return secureEqualsHex(hashSecret(password, auth.passwordSalt), auth.passwordHash);
}

function initializeOwnerAuth(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const auth: AuthData = {
    passwordSalt: salt,
    passwordHash: hashSecret(password, salt),
    tokens: [],
  };
  saveAuthData(auth);
  return issueOwnerToken();
}

function issueOwnerToken() {
  const auth = loadAuthData();
  if (!auth) {
    throw new Error("Password not configured.");
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const salt = crypto.randomBytes(16).toString("hex");
  const timestamp = nowIso();
  auth.tokens.push({
    id: createId(10),
    salt,
    hash: hashSecret(token, salt),
    createdAt: timestamp,
    lastUsedAt: timestamp,
  });
  saveAuthData(auth);
  return token;
}

function verifyOwnerToken(token: string) {
  const auth = loadAuthData();
  if (!auth) {
    return false;
  }

  let changed = false;
  for (const stored of auth.tokens) {
    if (secureEqualsHex(hashSecret(token, stored.salt), stored.hash)) {
      const lastSeen = Date.parse(stored.lastUsedAt);
      if (Number.isNaN(lastSeen) || Date.now() - lastSeen > 1000 * 60 * 60 * 12) {
        stored.lastUsedAt = nowIso();
        changed = true;
      }
      if (changed) {
        saveAuthData(auth);
      }
      return true;
    }
  }

  return false;
}

function revokeOwnerToken(token: string) {
  const auth = loadAuthData();
  if (!auth) {
    return;
  }

  const tokens = auth.tokens.filter((stored) => !secureEqualsHex(hashSecret(token, stored.salt), stored.hash));
  if (tokens.length !== auth.tokens.length) {
    auth.tokens = tokens;
    saveAuthData(auth);
  }
}

function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }

  for (const item of header.split(";")) {
    const index = item.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function setCookie(
  req: Request,
  res: Response,
  name: string,
  value: string,
  options: { maxAgeSeconds: number; httpOnly?: boolean },
) {
  const secure = req.secure ? "; Secure" : "";
  const httpOnly = options.httpOnly === false ? "" : "; HttpOnly";
  res.append(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${options.maxAgeSeconds}${httpOnly}${secure}`,
  );
}

function clearCookie(req: Request, res: Response, name: string, httpOnly = true) {
  const secure = req.secure ? "; Secure" : "";
  const httpOnlyPart = httpOnly ? "; HttpOnly" : "";
  res.append("Set-Cookie", `${name}=; Path=/; SameSite=Lax; Max-Age=0${httpOnlyPart}${secure}`);
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function getOwnerSessionTokenFromHeaders(headers: http.IncomingHttpHeaders) {
  return parseCookies(headerValue(headers.cookie))[ownerSessionCookieName] || null;
}

function getBearerTokenFromHeaders(headers: http.IncomingHttpHeaders) {
  const header = headerValue(headers.authorization);
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice(7).trim() || null;
}

function getOwnerSessionToken(req: Request) {
  return getOwnerSessionTokenFromHeaders(req.headers);
}

function setOwnerSessionCookie(req: Request, res: Response, token: string) {
  setCookie(req, res, ownerSessionCookieName, token, { maxAgeSeconds: ownerCookieMaxAgeSeconds });
}

function clearOwnerSessionCookie(req: Request, res: Response) {
  clearCookie(req, res, ownerSessionCookieName);
}

function isOwnerAuthenticatedHeaders(headers: http.IncomingHttpHeaders) {
  const bearer = getBearerTokenFromHeaders(headers);
  if (bearer && verifyApiKey(bearer)) {
    return true;
  }

  const token = getOwnerSessionTokenFromHeaders(headers);
  return Boolean(token && verifyOwnerToken(token));
}

function isOwnerAuthenticated(req: Request) {
  return isOwnerAuthenticatedHeaders(req.headers);
}

function isOwnerAuthenticatedIncomingRequest(req: http.IncomingMessage) {
  return isOwnerAuthenticatedHeaders(req.headers);
}

function getBearerToken(req: Request) {
  return getBearerTokenFromHeaders(req.headers);
}

function verifyApiKey(key: string) {
  const auth = loadAuthData();
  if (!auth || !auth.apiKeys) {
    return false;
  }

  for (const stored of auth.apiKeys) {
    if (secureEqualsHex(hashSecret(key, stored.keySalt), stored.keyHash)) {
      return true;
    }
  }

  return false;
}

function getApiKeyLabel(key: string): string | null {
  const auth = loadAuthData();
  if (!auth || !auth.apiKeys) {
    return null;
  }

  for (const stored of auth.apiKeys) {
    if (secureEqualsHex(hashSecret(key, stored.keySalt), stored.keyHash)) {
      return stored.label;
    }
  }

  return null;
}

function createApiKey(label: string) {
  const auth = loadAuthData();
  if (!auth) {
    throw new Error("Password not configured.");
  }

  if (!auth.apiKeys) {
    auth.apiKeys = [];
  }

  const rawKey = crypto.randomBytes(32).toString("base64url");
  const salt = crypto.randomBytes(16).toString("hex");
  const apiKey: ApiKey = {
    id: createId(10),
    label: label.trim().slice(0, 80) || "unnamed",
    keySalt: salt,
    keyHash: hashSecret(rawKey, salt),
    createdAt: nowIso(),
  };

  auth.apiKeys.push(apiKey);
  saveAuthData(auth);
  return { id: apiKey.id, label: apiKey.label, key: rawKey, createdAt: apiKey.createdAt };
}

function deleteApiKey(keyId: string) {
  const auth = loadAuthData();
  if (!auth || !auth.apiKeys) {
    return false;
  }

  const before = auth.apiKeys.length;
  auth.apiKeys = auth.apiKeys.filter((k) => k.id !== keyId);
  if (auth.apiKeys.length !== before) {
    saveAuthData(auth);
    return true;
  }

  return false;
}

function listApiKeys() {
  const auth = loadAuthData();
  if (!auth || !auth.apiKeys) {
    return [];
  }

  return auth.apiKeys.map((k) => ({ id: k.id, label: k.label, createdAt: k.createdAt }));
}

function getCommenterIdentityFromHeaders(headers: http.IncomingHttpHeaders) {
  const cookies = parseCookies(headerValue(headers.cookie));
  return {
    id: cookies[commenterIdCookieName] || null,
    name: cookies[commenterNameCookieName] || null,
  };
}

function getCommenterIdentity(req: Request) {
  return getCommenterIdentityFromHeaders(req.headers);
}

function getOrCreateCommenterId(req: Request, res: Response) {
  const existing = getCommenterIdentity(req).id;
  if (existing) {
    return existing;
  }

  const created = crypto.randomBytes(24).toString("base64url");
  setCookie(req, res, commenterIdCookieName, created, { maxAgeSeconds: commenterCookieMaxAgeSeconds });
  return created;
}

function setCommenterNameCookie(req: Request, res: Response, name: string) {
  setCookie(req, res, commenterNameCookieName, name, { maxAgeSeconds: commenterCookieMaxAgeSeconds });
}

function ensureCommentAuthor(req: Request, res: Response) {
  if (isOwnerAuthenticated(req)) {
    return { authorId: "__owner__", authorName: "Owner" };
  }

  const commenter = getCommenterIdentity(req);
  const name = commenter.name || normalizeCommenterName(String(req.body?.name || ""));
  if (!name) {
    return null;
  }

  const commenterId = commenter.id || getOrCreateCommenterId(req, res);
  return { authorId: commenterId, authorName: name };
}

function canManageMessage(req: Request, message: CommentMessage) {
  if (isOwnerAuthenticated(req)) {
    return true;
  }

  const commenter = getCommenterIdentity(req);
  return Boolean(commenter.id && commenter.id === message.authorId);
}

function canManageThread(req: Request, thread: CommentThread) {
  if (isOwnerAuthenticated(req)) {
    return true;
  }

  const commenter = getCommenterIdentity(req);
  return Boolean(commenter.id && thread.messages.some((message) => message.authorId === commenter.id));
}

function renderSimplePage(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/static/styles.css" />
    <script src="/static/theme.js"></script>
  </head>
  <body class="page-shell simple-page">
    <main class="simple-page-content">${body}</main>
  </body>
</html>`;
}

function renderAuthPage(mode: "login" | "setup") {
  const title = mode === "setup" ? "Set password" : "Sign in";
  const heading = mode === "setup" ? "Set the password" : "Enter the password";
  const hint =
    mode === "setup"
      ? "First startup. This becomes the single owner password for the instance."
      : "This instance uses one password and per-device tokens.";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="/static/styles.css" />
    <script src="/static/theme.js"></script>
  </head>
  <body class="page-shell auth-shell" data-auth-mode="${mode}">
    <button type="button" class="text-button theme-toggle auth-theme-toggle" aria-label="Toggle theme"></button>
    <main class="auth-layout">
      <h1>${heading}</h1>
      <p class="auth-hint">${hint}</p>
      <p class="auth-error hidden" id="auth-error"></p>
      <form id="auth-form" class="auth-form">
        <input id="password" name="password" type="password" autocomplete="${mode === "setup" ? "new-password" : "current-password"}" placeholder="Password" minlength="8" required autofocus />
        ${
          mode === "setup"
            ? '<input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" placeholder="Confirm password" minlength="8" required />'
            : ""
        }
        <div class="auth-actions">
          <button type="submit">${mode === "setup" ? "Save password" : "Sign in"}</button>
        </div>
      </form>
    </main>
    <script>window.__OWNER_TOKEN_KEY__ = ${JSON.stringify(ownerLocalStorageTokenKey)};</script>
    <script>document.querySelectorAll('.theme-toggle').forEach(function(b){b.innerHTML=window.__themeIcon(document.documentElement.getAttribute('data-theme')||'dark')});</script>
    <script src="/static/login.js" defer></script>
  </body>
</html>`;
}

function renderAppShell(
  page: "list" | "editor" | "public",
  title: string,
  data?: { noteId?: string; shareId?: string; shareAccess?: string },
) {
  const attrs = [
    `data-page="${page}"`,
    data?.noteId ? `data-note-id="${escapeHtml(data.noteId)}"` : "",
    data?.shareId ? `data-share-id="${escapeHtml(data.shareId)}"` : "",
    data?.shareAccess ? `data-share-access="${escapeHtml(data.shareAccess)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/static/styles.css" />
    <script src="/static/theme.js"></script>
  </head>
  <body class="page-shell app-page" ${attrs}>
    <div id="app"></div>
    <script>window.__OWNER_TOKEN_KEY__ = ${JSON.stringify(ownerLocalStorageTokenKey)};</script>
    <script>document.querySelectorAll('.theme-toggle').forEach(function(b){b.innerHTML=window.__themeIcon(document.documentElement.getAttribute('data-theme')||'dark')});</script>
    <script src="/static/components.js"></script>
    <script src="/static/app.js" defer></script>
  </body>
</html>`;
}
