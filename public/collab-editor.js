import {
  SimpleIdList,
  applyClientMutation,
  applyIdListUpdates,
  selectionFromIds,
  selectionToIds,
} from "./collab-shared.js";

const PRESENCE_THROTTLE_MS = 80;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const PRESENCE_STALE_MS = 60000;

// crypto.randomUUID is only available in secure contexts (HTTPS, localhost, file://).
// Fall back to crypto.getRandomValues so plain-HTTP origins (e.g. Docker on a LAN IP) still work.
const randomUUID = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
};

function isWordChar(ch) { return /[0-9A-Za-z_]/.test(ch || ""); }

function readInsertText(event) {
  if (typeof event.data === "string") return event.data;
  if (event.dataTransfer) return event.dataTransfer.getData("text/plain") || "";
  return "";
}

function clampSel(text, sel) {
  return {
    start: Math.max(0, Math.min(sel.start, text.length)),
    end: Math.max(0, Math.min(sel.end, text.length)),
    direction: sel.direction || "none",
  };
}

function wordBackward(text, cursor) {
  let i = cursor;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}
function wordForward(text, cursor) {
  let i = cursor;
  while (i < text.length && /\s/.test(text[i])) i++;
  while (i < text.length && !/\s/.test(text[i])) i++;
  return i;
}
function lineBackward(text, cursor) {
  let i = cursor - 1;
  while (i > 0 && text[i - 1] !== "\n") i--;
  return Math.max(0, i);
}

function buildDeleteMutation(state, start, endExcl, counter) {
  if (start < 0 || endExcl <= start || endExcl > state.text.length) return null;
  return {
    name: "delete", clientCounter: counter,
    args: { startId: state.idList.at(start), endId: state.idList.at(endExcl - 1), contentLength: endExcl - start },
  };
}

function buildInsertMutation(state, index, content, counter, newId) {
  if (!content) return null;
  const before = index === 0 ? null : state.idList.at(index - 1);
  const id = newId(before, state.idList, content.length);
  const prev = index > 0 ? state.text[index - 1] : "";
  const next = index < state.text.length ? state.text[index] : "";
  return {
    name: "insert", clientCounter: counter,
    args: { before, id, content, isInWord: isWordChar(content[0]) && (isWordChar(prev) || isWordChar(next)) },
  };
}

function replayPending(serverState, pending) {
  let s = { text: serverState.text, idList: serverState.idList.clone() };
  for (const m of pending) s = applyClientMutation(s, m);
  return s;
}

// ---- Mirror div for computing caret pixel positions in a textarea ----

function syncMirrorStyles(mirror, textarea) {
  const cs = getComputedStyle(textarea);
  const props = [
    "fontFamily","fontSize","fontWeight","fontStyle","letterSpacing","textTransform",
    "wordSpacing","textIndent","borderTopWidth","borderRightWidth","borderBottomWidth",
    "borderLeftWidth","paddingTop","paddingRight","paddingBottom","paddingLeft",
    "wordWrap","overflowWrap","whiteSpace","lineHeight","tabSize","boxSizing",
  ];
  for (const p of props) mirror.style[p] = cs[p];
  mirror.style.width = textarea.offsetWidth + "px";
}

function measureCaretPositions(textarea, mirror, indices) {
  syncMirrorStyles(mirror, textarea);
  const text = textarea.value;
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  mirror.textContent = "";
  const markers = new Map();
  let last = 0;
  for (const idx of sorted) {
    const clampedIdx = Math.max(0, Math.min(idx, text.length));
    if (clampedIdx > last) mirror.appendChild(document.createTextNode(text.substring(last, clampedIdx)));
    const span = document.createElement("span");
    span.textContent = "\u200b";
    mirror.appendChild(span);
    markers.set(idx, span);
    last = clampedIdx;
  }
  if (last < text.length) mirror.appendChild(document.createTextNode(text.substring(last)));
  if (!mirror.childNodes.length) mirror.appendChild(document.createTextNode("\u200b"));

  const result = new Map();
  for (const [idx, span] of markers) {
    result.set(idx, { top: span.offsetTop - textarea.scrollTop, left: span.offsetLeft - textarea.scrollLeft });
  }
  return result;
}

// ---- Main editor ----

export function createCollabEditor(textarea, opts) {
  const { noteId, shareId, name, onReady, onTextChange, onConnectionChange, onThreadsUpdated } = opts;
  let nextBunchIdCounter = 0;

  let ws = null;
  let destroyed = false;
  let programmatic = false;
  let initialized = false;
  let connected = false;
  let reconnectDelay = RECONNECT_BASE_MS;
  let nextClientCounter = 1;
  let clientId = null;

  let serverState = { text: "", idList: new SimpleIdList() };
  let currentState = { text: "", idList: new SimpleIdList() };
  let pendingMutations = [];

  // Remote presence
  const remoteCursors = new Map(); // clientId -> { name, color, selection, lastUpdate }

  // DOM elements for cursor overlay and mirror
  const container = textarea.parentElement;
  container.style.position = "relative";

  const overlay = document.createElement("div");
  overlay.className = "cursor-overlay";
  container.appendChild(overlay);

  const mirror = document.createElement("div");
  mirror.className = "textarea-mirror";
  mirror.style.cssText = "position:absolute;visibility:hidden;overflow:hidden;white-space:pre-wrap;word-wrap:break-word;pointer-events:none;";
  container.appendChild(mirror);

  let resizeObserver = null;
  try {
    resizeObserver = new ResizeObserver(() => renderRemoteCursors());
    resizeObserver.observe(textarea);
  } catch {}

  function newId(before, idList, count = 1) {
    if (clientId && before !== null && before.bunchId.startsWith(`${clientId}:`)) {
      const maxCounter = idList.maxCounter(before.bunchId);
      if (maxCounter === before.counter) {
        return { bunchId: before.bunchId, counter: before.counter + 1 };
      }
    }
    return {
      bunchId: `${clientId}:${nextBunchIdCounter++}:${randomUUID()}`,
      counter: 0,
    };
  }

  // ---- Connection state ----

  function setConnected(c) {
    if (connected === c) return;
    connected = c;
    textarea.readOnly = !c;
    onConnectionChange?.(c);
  }

  // ---- Rendering ----

  function render(sel) {
    const s = clampSel(currentState.text, sel || {
      start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection || "none",
    });
    programmatic = true;
    textarea.value = currentState.text;
    textarea.setSelectionRange(s.start, s.end, s.direction);
    queueMicrotask(() => { programmatic = false; });
    onTextChange?.(currentState.text);
    renderRemoteCursors();
  }

  function renderRemoteCursors() {
    overlay.innerHTML = "";
    if (!initialized) return;
    const indices = [];
    const cursorData = [];

    for (const [cid, info] of remoteCursors) {
      if (Date.now() - info.lastUpdate > PRESENCE_STALE_MS) { remoteCursors.delete(cid); continue; }
      try {
        const sel = selectionFromIds(info.selection, currentState.idList);
        const idx = sel.start;
        indices.push(idx);
        cursorData.push({ idx, name: info.name, color: info.color });
      } catch {}
    }

    if (!cursorData.length) return;

    const positions = measureCaretPositions(textarea, mirror, indices);
    const cs = getComputedStyle(textarea);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;

    for (const cursor of cursorData) {
      const pos = positions.get(cursor.idx);
      if (!pos) continue;
      // Don't render if outside visible area
      const btw = parseFloat(cs.borderTopWidth) || 0;
      const bbw = parseFloat(cs.borderBottomWidth) || 0;
      const visibleHeight = textarea.clientHeight;
      if (pos.top < 0 - lineHeight || pos.top > visibleHeight + btw + bbw) continue;

      const el = document.createElement("div");
      el.className = "remote-cursor";
      el.style.left = pos.left + "px";
      el.style.top = pos.top + "px";
      el.innerHTML = `<div class="remote-cursor-caret" style="background:${cursor.color};height:${lineHeight}px"></div><div class="remote-cursor-label" style="background:${cursor.color}">${escapeHtml(cursor.name)}</div>`;
      overlay.appendChild(el);
    }
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ---- Presence sending ----

  let lastPresenceSent = 0;
  let presenceTimer = null;
  let lastSentSelection = null;

  function sendPresence() {
    if (!initialized || !connected || !clientId || !ws || ws.readyState !== WebSocket.OPEN) return;
    const sel = selectionToIds(
      currentState.idList, textarea.selectionStart, textarea.selectionEnd,
      textarea.selectionDirection || "none",
    );
    const key = JSON.stringify(sel);
    if (key === lastSentSelection) return;
    lastSentSelection = key;
    ws.send(JSON.stringify({ type: "presence", clientId, selection: sel }));
  }

  function throttledPresence() {
    const now = Date.now();
    if (now - lastPresenceSent >= PRESENCE_THROTTLE_MS) {
      lastPresenceSent = now;
      sendPresence();
    } else {
      clearTimeout(presenceTimer);
      presenceTimer = setTimeout(() => {
        lastPresenceSent = Date.now();
        sendPresence();
      }, PRESENCE_THROTTLE_MS - (now - lastPresenceSent));
    }
  }

  // ---- Mutations ----

  function applyLocalMutations(mutations, sel) {
    if (!mutations.length) return;
    for (const m of mutations) {
      currentState = applyClientMutation(currentState, m);
      pendingMutations.push(m);
    }
    render(sel);
    if (ws && ws.readyState === WebSocket.OPEN && clientId) {
      ws.send(JSON.stringify({ type: "mutation", clientId, mutations }));
    }
    throttledPresence();
  }

  // ---- Server messages ----

  function receiveHello(msg) {
    const selIds = initialized
      ? selectionToIds(currentState.idList, textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection || "none")
      : null;

    if (msg.clientId) clientId = msg.clientId;
    serverState = { text: msg.markdown || "", idList: SimpleIdList.load(msg.idListState || []) };
    currentState = replayPending(serverState, pendingMutations);
    initialized = true;
    setConnected(true);
    reconnectDelay = RECONNECT_BASE_MS;
    render(selIds ? selectionFromIds(selIds, currentState.idList) : { start: 0, end: 0, direction: "none" });
    onReady?.({ noteId: msg.noteId, title: msg.title, shareId: msg.shareId, markdown: currentState.text });

    if (pendingMutations.length > 0 && ws && ws.readyState === WebSocket.OPEN && clientId) {
      ws.send(JSON.stringify({ type: "mutation", clientId, mutations: pendingMutations }));
    }
    throttledPresence();
  }

  function receiveMutation(msg) {
    if (!initialized) return;
    const selIds = selectionToIds(currentState.idList, textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection || "none");
    serverState = { text: msg.markdown || "", idList: applyIdListUpdates(serverState.idList, msg.idListUpdates || []) };
    if (msg.senderId === clientId) {
      const idx = pendingMutations.findIndex((m) => m.clientCounter === msg.senderCounter);
      if (idx !== -1) pendingMutations = pendingMutations.slice(idx + 1);
    }
    currentState = replayPending(serverState, pendingMutations);
    render(selectionFromIds(selIds, currentState.idList));
    throttledPresence();
  }

  function receivePresence(msg) {
    remoteCursors.set(msg.clientId, { name: msg.name, color: msg.color, selection: msg.selection, lastUpdate: Date.now() });
    renderRemoteCursors();
  }

  function receivePresenceLeave(msg) {
    remoteCursors.delete(msg.clientId);
    renderRemoteCursors();
  }

  // ---- Input handling ----

  function handleBeforeInput(event) {
    if (!initialized || !connected) { event.preventDefault(); return; }
    if (event.isComposing || event.inputType.includes("Composition")) return;

    const it = event.inputType;
    const ss = textarea.selectionStart;
    const se = textarea.selectionEnd;
    const hasSel = ss !== se;
    const mutations = [];
    let ws2 = { text: currentState.text, idList: currentState.idList.clone() };

    function pushDel(s, e) {
      const m = buildDeleteMutation(ws2, s, e, nextClientCounter++);
      if (!m) return false;
      mutations.push(m); ws2 = applyClientMutation(ws2, m); return true;
    }
    function pushIns(i, c) {
      const m = buildInsertMutation(ws2, i, c, nextClientCounter++, newId);
      if (!m) return false;
      mutations.push(m); ws2 = applyClientMutation(ws2, m); return true;
    }

    let sel = { start: ss, end: se, direction: "none" };

    if (hasSel && it !== "historyUndo" && it !== "historyRedo") {
      pushDel(ss, se); sel = { start: ss, end: ss, direction: "none" };
    }

    if (it === "insertText" || it === "insertReplacementText" || it === "insertFromPaste" || it === "insertFromDrop") {
      const c = readInsertText(event); if (!c) return;
      event.preventDefault();
      pushIns(sel.start, c); sel = { start: sel.start + c.length, end: sel.start + c.length, direction: "none" };
      applyLocalMutations(mutations, sel); return;
    }
    if (it === "insertLineBreak" || it === "insertParagraph") {
      event.preventDefault();
      pushIns(sel.start, "\n"); sel = { start: sel.start + 1, end: sel.start + 1, direction: "none" };
      applyLocalMutations(mutations, sel); return;
    }
    if (it === "deleteContentBackward") {
      event.preventDefault();
      if (!hasSel && ss > 0) { pushDel(ss - 1, ss); sel = { start: ss - 1, end: ss - 1, direction: "none" }; }
      applyLocalMutations(mutations, sel); return;
    }
    if (it === "deleteContentForward") {
      event.preventDefault();
      if (!hasSel && ss < currentState.text.length) { pushDel(ss, ss + 1); sel = { start: ss, end: ss, direction: "none" }; }
      applyLocalMutations(mutations, sel); return;
    }
    if (it === "deleteWordBackward") {
      event.preventDefault();
      if (!hasSel && ss > 0) { const s = wordBackward(currentState.text, ss); pushDel(s, ss); sel = { start: s, end: s, direction: "none" }; }
      applyLocalMutations(mutations, sel); return;
    }
    if (it === "deleteWordForward") {
      event.preventDefault();
      if (!hasSel && ss < currentState.text.length) { const e = wordForward(currentState.text, ss); pushDel(ss, e); sel = { start: ss, end: ss, direction: "none" }; }
      applyLocalMutations(mutations, sel); return;
    }
    if (it === "deleteSoftLineBackward" || it === "deleteHardLineBackward") {
      event.preventDefault();
      if (!hasSel && ss > 0) { const s = lineBackward(currentState.text, ss); pushDel(s, ss); sel = { start: s, end: s, direction: "none" }; }
      applyLocalMutations(mutations, sel); return;
    }
  }

  function handleInput() {
    if (programmatic || !initialized) return;
    applyDiffFallback(textarea.value);
  }

  function applyDiffFallback(nextText) {
    if (!initialized || nextText === currentState.text) return;
    const prev = currentState.text;
    let prefix = 0;
    while (prefix < prev.length && prefix < nextText.length && prev[prefix] === nextText[prefix]) prefix++;
    let ps = prev.length, ns = nextText.length;
    while (ps > prefix && ns > prefix && prev[ps - 1] === nextText[ns - 1]) { ps--; ns--; }

    const mutations = [];
    let ws2 = { text: currentState.text, idList: currentState.idList.clone() };
    const dm = buildDeleteMutation(ws2, prefix, ps, nextClientCounter);
    if (dm) { nextClientCounter++; mutations.push(dm); ws2 = applyClientMutation(ws2, dm); }
    const ins = nextText.slice(prefix, ns);
    if (ins) { const im = buildInsertMutation(ws2, prefix, ins, nextClientCounter, newId); if (im) { nextClientCounter++; mutations.push(im); } }
    if (!mutations.length) { render({ start: prefix, end: prefix, direction: "none" }); return; }
    const cursor = prefix + ins.length;
    applyLocalMutations(mutations, { start: cursor, end: cursor, direction: "none" });
  }

  // ---- WebSocket ----

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const param = noteId ? `noteId=${encodeURIComponent(noteId)}` : `shareId=${encodeURIComponent(shareId)}`;
    ws = new WebSocket(`${protocol}//${location.host}/?${param}`);

    ws.addEventListener("open", () => {});
    ws.addEventListener("message", (event) => {
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "hello") receiveHello(msg);
      else if (msg.type === "mutation") receiveMutation(msg);
      else if (msg.type === "presence") receivePresence(msg);
      else if (msg.type === "presence-leave") receivePresenceLeave(msg);
      else if (msg.type === "threads-updated") onThreadsUpdated?.();
    });
    ws.addEventListener("close", () => {
      if (destroyed) return;
      setConnected(false);
      remoteCursors.clear();
      renderRemoteCursors();
      setTimeout(() => { if (!destroyed) { reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS); connect(); } }, reconnectDelay);
    });
    ws.addEventListener("error", () => { setConnected(false); });
  }

  // ---- Event listeners ----

  textarea.addEventListener("beforeinput", handleBeforeInput);
  textarea.addEventListener("input", handleInput);
  textarea.addEventListener("compositionend", () => { if (textarea.value !== currentState.text) applyDiffFallback(textarea.value); });
  document.addEventListener("selectionchange", () => { if (document.activeElement === textarea) throttledPresence(); });
  textarea.addEventListener("focus", throttledPresence);
  textarea.addEventListener("blur", throttledPresence);
  textarea.addEventListener("scroll", renderRemoteCursors);

  connect();

  return {
    destroy() {
      destroyed = true;
      textarea.removeEventListener("beforeinput", handleBeforeInput);
      textarea.removeEventListener("input", handleInput);
      if (resizeObserver) resizeObserver.disconnect();
      if (ws) ws.close();
      overlay.remove();
      mirror.remove();
    },
    getText() { return currentState.text; },
  };
}
