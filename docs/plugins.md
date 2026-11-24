# TeleOps plugins

A plugin adds features to TeleOps — MCP tools for agents, automations on Telegram messages, web addresses for other services — without changing TeleOps itself. Every plugin is a **public GitHub repository**: you build it on GitHub, then you paste its address in TeleOps.

- Start from the template: <https://github.com/emrgim/teleops-plugin-template> (**Use this template**).
- Install: **Connectors → Plugins → +**, paste `https://github.com/<owner>/<repo>`, **Check**, **Install**.

> A plugin is a program that runs inside TeleOps with the same rights: it can read and send the messages of every bot and Telegram account. Install only plugins you trust; the page shows the exact commit before you install it.

## How installing works

- TeleOps reads the repository from GitHub with no account and no token: it must be **public**.
- It installs one **commit**: the latest of the default branch, or of the branch or tag in the address (`…/tree/<branch or tag>`). An address with `…/commit/<sha>` is pinned and never updates.
- **Check for updates** on the plugin's page looks at the branch (or tag) again; **Update** moves to the newer commit. Settings and data stay.
- Nothing is built: there is no `npm install`. The repository holds JavaScript that runs as it is (ES modules). Node's own modules (`node:crypto`, `node:fs`…) are available; npm packages must be bundled into your file (for example with esbuild) and committed.
- Limits: an archive of at most 30 MB, 5000 files, 150 MB unpacked.
- The code is kept in the TeleOps data folder (`plugins/<id>/<commit>/`); after a backup is restored on another computer, the same commit is downloaded again.

## The repository

```
teleops-plugin.json   who the plugin is (required, at the top)
index.mjs             the code ("main")
icon.svg              optional, square
README.md
```

### teleops-plugin.json

```json
{
  "id": "example",
  "name": "Example plugin",
  "description": "What it does, in one line.",
  "version": "1.0.0",
  "author": "Your name",
  "main": "index.mjs",
  "icon": "icon.svg",
  "settings": [
    { "key": "greeting", "label": "Greeting", "type": "text", "default": "Hello" },
    { "key": "apiKey", "label": "API key of the other service", "type": "secret", "required": true },
    { "key": "account", "label": "Account", "type": "account", "help": "Empty: the default one." }
  ],
  "i18n": {
    "it": { "name": "Plugin di esempio", "settings": { "greeting": { "label": "Saluto" } } }
  }
}
```

| Field | | |
|---|---|---|
| `id` | required | a-z, 0-9 and `-`, starting with a letter, 2–32 characters, unique on a TeleOps. Its MCP tools are named `<id>_<tool>` (`-` becomes `_`). `telegram` and `teleops` are reserved. |
| `name` | required | shown in the page, at most 60 characters |
| `description` | | one or two lines |
| `version`, `author`, `homepage` | | shown in the page |
| `main` | | the file TeleOps imports, `index.mjs` when omitted (`.mjs`, or `.js` as an ES module) |
| `icon` | | an `.svg`, `.png`, `.jpg` or `.webp` file of the repository |
| `teleops` | | the oldest TeleOps it works with, like `">=0.1.0"` |
| `settings` | | the form TeleOps draws on the plugin's page |
| `i18n` | | translations by language: `name`, `description`, and `settings.<key>.label / help / placeholder` |

### Settings

Each setting has a `key` (letters, digits, `_`), a `label` and a `type`; optional: `help`, `placeholder`, `required`, `default`, `options`.

| type | the page shows | the plugin gets |
|---|---|---|
| `text` | a line | a string |
| `textarea` | a box | a string |
| `secret` | a password field, never shown again (left empty = keep it) | a string |
| `number` | a number | a number |
| `boolean` | a checkbox | `true` / `false` |
| `select` | a list from `options`: `["a", "b"]` or `[{ "value": "a", "label": "A" }]` | a string |
| `url` | an http(s) address | a string |
| `account` | the bots and Telegram accounts of this TeleOps | the account id |

A plugin with an empty `required` setting does not start: its page says **Needs settings**. Saving the settings restarts the plugin.

## The code

The main file exports `start(ctx)`:

```js
export default {
  async start(ctx) {
    // tools, event handlers, web addresses, timers
    return () => {
      // optional: what to close when the plugin stops
    }
  },
}
```

`start` runs when the plugin is turned on, after an update or a change of its settings, and when TeleOps starts; it has 30 seconds. When the plugin stops, TeleOps removes its tools, event handlers, web addresses and timers by itself, then calls the function `start` returned (or an exported `stop(ctx)`).

### ctx

| | |
|---|---|
| `ctx.settings` | the values of the form, defaults included (read-only) |
| `ctx.plugin` | `{ id, name, version, repo, sha }` |
| `ctx.teleops` | `{ version, language }` |
| `ctx.log.info / warn / error(message, extra?)` | lines in Settings → Log |
| `ctx.accounts()` | `[{ id, kind: 'bot' or 'user', name, username, state, default }]` |
| `ctx.send({ account?, to, text, parseMode?, replyTo?, silent?, threadId?, buttons? })` | send a text message; `account` is an id or @username (the default one when omitted); buttons only from bots |
| `ctx.messages({ account?, chat, limit?, before?, after? })` | the messages of a chat |
| `ctx.chats({ account?, limit?, query? })` | the chats |
| `ctx.search({ account?, query, chat?, limit?, since? })` | full-text search |
| `ctx.on(type, handler)` | events (below) |
| `ctx.tool({ name, title?, description, scope?, input?, run })` | an MCP tool |
| `ctx.route(method, path, handler, { auth? })` | a web address |
| `ctx.reply(status, body?, headers?)` | an answer with a status, from a web address |
| `ctx.url(path?)` | the public address of the plugin's web addresses |
| `ctx.store.get / set / delete / keys` | the plugin's own data (JSON, at most 1 MB a value), in the TeleOps database |
| `ctx.dataDir` | a folder for the plugin's files |
| `ctx.every(ms, fn)`, `ctx.after(ms, fn)` | timers; both return a function that cancels them |
| `ctx.fetch` | `fetch` |

### Events

```js
ctx.on('message.received', async (ev) => {
  if (ev.data.chatType === 'private' && ev.data.text === 'ping') {
    await ctx.send({ account: ev.account, to: ev.data.chat, text: 'pong', replyTo: ev.data.id })
  }
})
```

The type is one event, `message.*` or `*`. Events are the ones of the webhooks: `message.received`, `message.sent`, `message.edited`, `message.reaction`, `message.transcribed`, `button.pressed`, `chat.member`, `connection.update`, `profile.update`.

`ev` is `{ id, type, account, at, data, context }`: `account` is the bot or Telegram account it happened to, `context` a line in plain words. For a message `data` is:

```json
{
  "id": "1201",
  "chat": "123456789",
  "chatName": "Mario Rossi",
  "chatType": "private",
  "fromMe": false,
  "sender": "123456789",
  "senderName": "Mario Rossi",
  "senderUsername": "mario",
  "timestamp": "2026-01-01T09:00:00.000Z",
  "type": "text",
  "text": "ping",
  "hasMedia": false,
  "replyTo": null
}
```

`chatType` is `private`, `group`, `supergroup` or `channel`. A handler that throws (or whose promise fails) is written in the log; a plugin that fails 20 times in a minute is stopped.

### MCP tools

```js
ctx.tool({
  name: 'hello', // agents see example_hello
  title: 'Say hello',
  description: 'What it does and when to use it: the agent decides from this.',
  scope: 'read', // 'read' or 'send' (default): the caller's key must have it
  input: { type: 'object', properties: { name: { type: 'string', description: 'Who' } }, required: ['name'] },
  run: async (args, { accounts }) => ({ text: `Hello ${args.name}` }),
})
```

`input` is the JSON Schema of an object (`string` with an optional `enum`, `number`, `integer`, `boolean`, `array`, `object`). `run` returns any JSON value and has 120 seconds. `accounts` is `'*'` or the account ids the caller's key may use: respect it when the tool reads or sends for an account. Agents connected to TeleOps (`/mcp`) see the tools of the running plugins when they list the tools again (a new session).

### Web addresses

```js
ctx.route('POST', 'hook/:name', async (req) => {
  // req: { method, path, params, query, headers, body, rawBody }
  return ctx.reply(202, { ok: true })
}, { auth: 'none' })
```

The address is `<TeleOps address>/plugins/<id>/<path>` — `ctx.url('hook/x')` writes it. `auth` is `admin` (the default), `send` or `read` — an API key or OAuth token with that scope, or the owner signed in to the page — or `none` (public: check a signature or a secret yourself; `rawBody` holds the exact bytes received). Return a value (JSON), a string (text), a Buffer, nothing (204) or `ctx.reply(status, body, headers)`; 60 seconds.

### Errors

An error thrown by the plugin's code that nobody catches stops that plugin, not TeleOps. Its page shows the error; **Turn on** or **Restart** starts it again.

## REST API

The same actions as the page, with an admin key: `GET /v1/plugins`, `POST /v1/plugins/preview {url}`, `POST /v1/plugins {url}`, `GET /v1/plugins/{id}`, `PATCH /v1/plugins/{id} {enabled?, settings?}`, `GET` and `POST /v1/plugins/{id}/update`, `POST /v1/plugins/{id}/restart`, `DELETE /v1/plugins/{id}`. Details at `/docs` on your TeleOps.
