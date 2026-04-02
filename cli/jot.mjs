#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const configDir = path.join(os.homedir(), ".config", "jot");
const configPath = path.join(configDir, "settings.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return { instances: [] };
  }
}

function saveConfig(config) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function getInstance(name) {
  const config = loadConfig();
  const instance = config.instances.find((i) => i.name === name);
  if (!instance) {
    console.error(`Unknown instance: ${name}`);
    console.error(`Run: jot register <name> <baseUrl> <token>`);
    process.exit(1);
  }
  return instance;
}

async function request(instance, method, endpoint, body) {
  const url = `${instance.baseUrl.replace(/\/$/, "")}${endpoint}`;
  const options = {
    method,
    headers: {},
  };

  if (instance.token) {
    options.headers.Authorization = `Bearer ${instance.token}`;
  }

  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const payload = await response.json();

  if (!response.ok) {
    console.error(`Error ${response.status}: ${payload.error || payload.errors?.join(", ") || "Request failed"}`);
    process.exit(1);
  }

  return payload;
}

function isShareInstance(instance) {
  return Boolean(instance.shareId && !instance.token);
}

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  printUsage();
  process.exit(0);
}

if (command === "serve") {
  const portArg = args.find((a) => a.startsWith("--port="));
  const dataArg = args.find((a) => a.startsWith("--data="));
  const cliDir = path.dirname(new URL(import.meta.url).pathname);
  const serverPath = path.join(cliDir, "..", "dist", "server.js");
  if (!fs.existsSync(serverPath)) {
    console.error(`Server not found at ${serverPath}. Run 'npm run build' first.`);
    process.exit(1);
  }
  const serverArgs = [serverPath];
  if (portArg) serverArgs.push(portArg);
  if (dataArg) serverArgs.push(dataArg);
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync(process.execPath, serverArgs, { stdio: "inherit" });
  } catch (e) {
    process.exit(e.status || 1);
  }
  process.exit(0);
}

if (command === "register") {
  const [, name, urlOrBase, token] = args;
  if (!name || !urlOrBase) {
    console.error("Usage: jot register <name> <baseUrl> <token>");
    console.error("       jot register <name> <shareUrl>");
    process.exit(1);
  }

  const config = loadConfig();
  config.instances = config.instances.filter((i) => i.name !== name);

  const shareMatch = urlOrBase.match(/^(https?:\/\/.+)\/s\/([a-z0-9]+)$/i);
  if (shareMatch) {
    config.instances.push({ name, baseUrl: shareMatch[1], shareId: shareMatch[2] });
    saveConfig(config);
    console.log(`Registered shared instance "${name}" at ${shareMatch[1]}`);
  } else {
    if (!token) {
      console.error("Usage: jot register <name> <baseUrl> <token>");
      process.exit(1);
    }
    config.instances.push({ name, baseUrl: urlOrBase, token });
    saveConfig(config);
    console.log(`Registered instance "${name}" at ${urlOrBase}`);
  }
  process.exit(0);
}

if (command === "unregister") {
  const name = args[1];
  if (!name) {
    console.error("Usage: jot unregister <name>");
    process.exit(1);
  }

  const config = loadConfig();
  const before = config.instances.length;
  config.instances = config.instances.filter((i) => i.name !== name);
  if (config.instances.length === before) {
    console.error(`Instance "${name}" not found.`);
    process.exit(1);
  }

  saveConfig(config);
  console.log(`Unregistered instance "${name}".`);
  process.exit(0);
}

if (command === "instances") {
  const config = loadConfig();
  if (config.instances.length === 0) {
    console.log("No registered instances.");
  } else {
    for (const instance of config.instances) {
      console.log(`${instance.name}  ${instance.baseUrl}`);
    }
  }
  process.exit(0);
}

const instanceName = command;
const subCommand = args[1];

if (!subCommand) {
  console.error(`Usage: jot <instance> <command> [args...]`);
  console.error(`Commands: list, search, read, create, edit, delete, update`);
  process.exit(1);
}

const instance = getInstance(instanceName);

if (isShareInstance(instance)) {
  const sid = instance.shareId;
  const nameArg = args.find((a) => a.startsWith("--name="));
  const agentName = nameArg ? nameArg.split("=").slice(1).join("=") : "Agent";

  switch (subCommand) {
    case "read": {
      const payload = await request(instance, "GET", `/api/share/${sid}/note`);
      const note = payload.note;
      console.log(`# ${note.title}`);
      console.log(`# id: ${note.id}`);
      console.log(`# updated: ${note.updatedAt}`);
      console.log(`# access: ${note.shareAccess}`);
      console.log();
      console.log(note.markdown);

      if (payload.threads && payload.threads.length > 0) {
        console.log();
        console.log("--- Comments ---");
        for (const thread of payload.threads) {
          const anchor = thread.anchor?.quote ? `"${thread.anchor.quote.slice(0, 60)}"` : "(no anchor)";
          console.log();
          console.log(`Thread ${thread.id} on ${anchor}${thread.resolved ? " [resolved]" : ""}`);
          for (const msg of thread.messages) {
            console.log(`  ${msg.authorName} (${msg.updatedAt}): ${msg.body}`);
          }
        }
      }
      break;
    }

    case "edit": {
      const editsJson = args[2];
      if (!editsJson) {
        console.error("Usage: jot <instance> edit '<json edits>'");
        process.exit(1);
      }
      let edits;
      try { edits = JSON.parse(editsJson); } catch { console.error("Invalid JSON."); process.exit(1); }
      const payload = await request(instance, "POST", `/api/share/${sid}/edit`, { edits });
      console.log(`Saved at ${payload.savedAt}`);
      break;
    }

    case "comment": {
      const quote = args[2];
      const body = args.slice(3).join(" ");
      if (!quote || !body) {
        console.error('Usage: jot <instance> comment <quote> <body>');
        process.exit(1);
      }
      const payload = await request(instance, "POST", `/api/share/${sid}/threads`, { anchor: { quote, prefix: "", suffix: "", start: 0, end: 0 }, body, name: agentName });
      console.log("Comment added");
      break;
    }

    case "reply": {
      const threadId = args[2];
      const body = args.slice(3).join(" ");
      if (!threadId || !body) {
        console.error("Usage: jot <instance> reply <threadId> <body>");
        process.exit(1);
      }
      await request(instance, "POST", `/api/share/${sid}/threads/${threadId}/replies`, { body, name: agentName });
      console.log("Reply added");
      break;
    }

    default:
      console.error(`Unknown command for shared instance: ${subCommand}`);
      console.error("Available: read, edit, comment, reply");
      process.exit(1);
  }
} else {

switch (subCommand) {
  case "list": {
    const payload = await request(instance, "GET", "/api/notes");
    for (const note of payload.notes) {
      console.log(`${note.id}\t${note.title}\t${note.updatedAt}`);
    }
    break;
  }

  case "search": {
    const query = args.slice(2).join(" ");
    if (!query) {
      console.error("Usage: jot <instance> search <query>");
      process.exit(1);
    }
    const payload = await request(instance, "GET", `/api/notes?q=${encodeURIComponent(query)}`);
    for (const note of payload.notes) {
      console.log(`${note.id}\t${note.title}\t${note.updatedAt}`);
    }
    break;
  }

  case "read": {
    const noteId = args[2];
    if (!noteId) {
      console.error("Usage: jot <instance> read <id> [--offset=N] [--limit=M]");
      process.exit(1);
    }

    const offsetArg = args.find((a) => a.startsWith("--offset="));
    const limitArg = args.find((a) => a.startsWith("--limit="));
    const offset = offsetArg ? offsetArg.split("=")[1] : null;
    const limit = limitArg ? limitArg.split("=")[1] : null;

    let endpoint = `/api/notes/${noteId}`;
    const params = [];
    if (offset) params.push(`offset=${offset}`);
    if (limit) params.push(`limit=${limit}`);
    if (params.length) endpoint += `?${params.join("&")}`;

    const payload = await request(instance, "GET", endpoint);
    const note = payload.note;

    if (note.content !== undefined) {
      console.log(`# ${note.title}`);
      console.log(`# id: ${note.id}`);
      console.log(`# lines: ${note.offset}-${note.offset + note.limit - 1} of ${note.totalLines}${note.remaining > 0 ? ` (${note.remaining} more)` : ""}`);
      console.log();
      console.log(note.content);
    } else {
      console.log(`# ${note.title}`);
      console.log(`# id: ${note.id}`);
      console.log(`# updated: ${note.updatedAt}`);
      console.log(`# share: ${note.shareUrl}`);
      console.log();
      console.log(note.markdown);

      if (payload.threads && payload.threads.length > 0) {
        console.log();
        console.log("--- Comments ---");
        for (const thread of payload.threads) {
          const anchor = thread.anchor?.quote ? `"${thread.anchor.quote.slice(0, 60)}"` : "(no anchor)";
          console.log();
          console.log(`Thread ${thread.id} on ${anchor}${thread.resolved ? " [resolved]" : ""}`);
          for (const msg of thread.messages) {
            console.log(`  ${msg.authorName} (${msg.updatedAt}): ${msg.body}`);
          }
        }
      }
    }
    break;
  }

  case "create": {
    const title = args.slice(2).join(" ") || "untitled";
    const payload = await request(instance, "POST", "/api/notes");
    if (title !== "untitled") {
      await request(instance, "PUT", `/api/notes/${payload.note.id}`, { title, markdown: "" });
    }
    console.log(`${payload.note.id}\t${title}`);
    break;
  }

  case "comment": {
    const noteId = args[2];
    const quote = args[3];
    const body = args.slice(4).join(" ");
    if (!noteId || !quote || !body) {
      console.error("Usage: jot <instance> comment <id> <quote> <body>");
      console.error('Example: jot myserver comment abc123 "some text" "my comment"');
      process.exit(1);
    }
    const payload = await request(instance, "POST", `/api/notes/${noteId}/threads`, { quote, body });
    console.log(`Comment added (thread ${payload.thread.id})`);
    break;
  }

  case "reply": {
    const noteId = args[2];
    const threadId = args[3];
    const body = args.slice(4).join(" ");
    if (!noteId || !threadId || !body) {
      console.error("Usage: jot <instance> reply <noteId> <threadId> <body>");
      process.exit(1);
    }
    await request(instance, "POST", `/api/notes/${noteId}/threads/${threadId}/replies`, { body });
    console.log("Reply added");
    break;
  }

  case "edit": {
    const noteId = args[2];
    const editsJson = args[3];
    if (!noteId || !editsJson) {
      console.error("Usage: jot <instance> edit <id> '<json edits>'");
      console.error('Example: jot myserver edit abc123 \'[{"oldText":"hello","newText":"world"}]\'');
      process.exit(1);
    }

    let edits;
    try {
      edits = JSON.parse(editsJson);
    } catch {
      console.error("Invalid JSON for edits.");
      process.exit(1);
    }

    const payload = await request(instance, "POST", `/api/notes/${noteId}/edit`, { edits });
    console.log(`Saved at ${payload.savedAt}`);
    break;
  }

  case "update": {
    const noteId = args[2];
    const field = args[3];
    const value = args.slice(4).join(" ");
    if (!noteId || !field || !value) {
      console.error("Usage: jot <instance> update <id> title <value>");
      console.error("       jot <instance> update <id> markdown <value>");
      process.exit(1);
    }

    const body = {};
    if (field === "title") {
      body.title = value;
      body.markdown = undefined;
      const current = await request(instance, "GET", `/api/notes/${noteId}`);
      body.markdown = current.note.markdown;
    } else if (field === "markdown") {
      body.markdown = value;
      const current = await request(instance, "GET", `/api/notes/${noteId}`);
      body.title = current.note.title;
    } else {
      console.error(`Unknown field: ${field}. Use 'title' or 'markdown'.`);
      process.exit(1);
    }

    const payload = await request(instance, "PUT", `/api/notes/${noteId}`, body);
    console.log(`Saved at ${payload.savedAt}`);
    break;
  }

  case "delete": {
    const noteId = args[2];
    if (!noteId) {
      console.error("Usage: jot <instance> delete <id>");
      process.exit(1);
    }
    await request(instance, "DELETE", `/api/notes/${noteId}`);
    console.log(`Deleted ${noteId}`);
    break;
  }

  default:
    console.error(`Unknown command: ${subCommand}`);
    printUsage();
    process.exit(1);
}

} // end owner mode

function printUsage() {
  console.log(`Usage: jot <command> [args...]

Server:
  jot serve [--port=N] [--data=path]      Run the jot server

Instance management:
  jot register <name> <baseUrl> <token>   Register with API key (owner)
  jot register <name> <shareUrl>          Register with share link
  jot unregister <name>                   Remove a registered instance
  jot instances                           List registered instances

Owner commands:
  jot <instance> list                     List all notes
  jot <instance> search <query>           Search notes
  jot <instance> read <id>                Read a note with comments
  jot <instance> create [title]           Create a new note
  jot <instance> comment <id> <quote> <b> Comment on quoted text
  jot <instance> reply <id> <threadId> <b> Reply to a comment thread
  jot <instance> edit <id> '<edits>'      Apply edits (JSON array of {oldText, newText})
  jot <instance> update <id> title <val>  Update note title
  jot <instance> update <id> markdown <v> Replace full markdown
  jot <instance> delete <id>              Delete a note

Shared note commands:
  jot <instance> read                     Read the shared note
  jot <instance> edit '<edits>'           Edit (if edit access)
  jot <instance> comment <quote> <body>   Comment on text
  jot <instance> reply <threadId> <body>  Reply to a thread
  Use --name="Name" to set display name for comments`);
}
