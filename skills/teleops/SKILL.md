---
name: teleops
description: Use when the user wants to read, search or send Telegram messages, buttons, media, reactions or invite links through their own Telegram bots on a TeleOps MCP server, edit a bot's profile or commands, or install TeleOps and connect an agent to it. Explains every TeleOps tool, the rules for using them and how to chain them.
license: See the TeleOps repository
metadata:
  repository: https://github.com/emrgim/TeleOps
  skill: https://github.com/emrgim/TeleOps/tree/main/skills/teleops
---

# TeleOps

TeleOps is a self-hosted server. It runs the owner's own Telegram bots (made with @BotFather) through the Telegram Bot API and gives them to agents through MCP, a REST API and webhooks. Everything you send goes out **as the bot**.

- Repository: https://github.com/emrgim/TeleOps
- This skill: https://github.com/emrgim/TeleOps/tree/main/skills/teleops
- Skill file to upload: https://github.com/emrgim/TeleOps/raw/main/skills/teleops.skill
- Every tool with all its parameters: [references/tools.md](references/tools.md)

In the examples, `teleops.example.com` stands for the owner's own TeleOps address.

## 1. Install the server (once, by the owner)

1. From source (Node.js 24+): `git clone https://github.com/emrgim/TeleOps.git && cd TeleOps && npm ci && npm run build && npm start`. When a release is published, its installers (`.dmg`, `-setup.exe`, `.deb` / `.rpm`, with Node.js inside) are on https://github.com/emrgim/TeleOps/releases/latest, and on any Linux without root:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/emrgim/TeleOps/main/install/linux.sh | bash
   ```
2. TeleOps listens on **http://127.0.0.1:8811**. First sign-in: `teleops login-link --local` (from source: `node dist/cli.js login-link --local`) prints a one-time link.
3. On Telegram, open **@BotFather**, send `/newbot` and copy the token. In TeleOps: **Bots → Add bot**, paste the token. TeleOps reads the bot's updates itself (long polling): a bot can have only one reader, so stop any other program that uses the same token. If the bot sends its updates to a webhook of another program, TeleOps asks before taking it over.
4. **Settings → General → Your Telegram → Link my Telegram**, then press Start in the bot: login codes for the config page come there.
5. For agents on other machines or in the cloud (Claude, ChatGPT, Gemini, Grok): put TeleOps behind HTTPS (a reverse proxy or a tunnel: Caddy, nginx, Cloudflare Tunnel…) and set that address in **Settings → General → Public URL** (or `TELEOPS_PUBLIC_URL`). OAuth needs it.

## 2. Connect the agent

MCP endpoint: `https://teleops.example.com/mcp`. On the same machine you can also use `http://127.0.0.1:8811/mcp`. In TeleOps, **Connectors → MCP** has a tile with ready-to-paste settings for each app.

| Agent | How |
|---|---|
| Claude (web, desktop) | Settings → Connectors → Add custom connector → the endpoint. Sign in to TeleOps and allow. |
| Claude Code | `claude mcp add --transport http teleops https://teleops.example.com/mcp` |
| ChatGPT | Settings → Apps & Connectors → Advanced settings → Developer mode, then Create a connector with the endpoint and OAuth. |
| Gemini CLI | `gemini mcp add --transport http teleops https://teleops.example.com/mcp`, then `/mcp auth teleops` |
| Cursor | `~/.cursor/mcp.json`: `{"mcpServers": {"teleops": {"url": "https://teleops.example.com/mcp"}}}`; it signs in with OAuth on first use. |
| Grok | Server URL = the endpoint, Client ID `grok`, no secret, authorization `/oauth/authorize`, token `/oauth/token`, scopes `read send`, PKCE. |
| Hermes, scripts | **Connectors → API** → create a key (`tok_…`) with the scopes it needs; send `Authorization: Bearer tok_…`. |
| Grok Bot | The Grok Bot tile makes a key and gives the endpoint with `?token=tok_…` (no OAuth). |
| stdio-only clients | `TELEOPS_MCP_URL=https://teleops.example.com/mcp TELEOPS_API_KEY=tok_… teleops stdio` (from source: `node dist/cli.js stdio`) |

Scopes: `read` (bots, chats, messages, people) and `send` (everything that changes Telegram). A credential without `send` gets `This credential lacks the "send" scope`.

**Check:** call `telegram_bots`. Each working bot has state `open`. `conflict` = another program reads the same bot; `unauthorized` = the token was revoked: the owner adds the bot again with its new token.

## 3. Install this skill

The skill is the folder `skills/teleops` of the repository. `teleops.skill` is the same folder as a ZIP.

| Agent | Where |
|---|---|
| Claude (web, desktop) | Customize → Skills → upload `teleops.skill` (needs code execution on in Settings → Capabilities; rename it `.zip` if a ZIP is asked for) |
| Claude Code | `~/.claude/skills/teleops/` |
| Cursor | `~/.cursor/skills/teleops/` |
| Codex | `~/.agents/skills/teleops/` |
| Gemini CLI | `~/.gemini/skills/teleops/` |
| Hermes | `~/.hermes/skills/teleops/` |

macOS / Linux (change the folder for your agent):
```bash
curl -fsSL https://github.com/emrgim/TeleOps/raw/main/skills/teleops.skill -o /tmp/teleops.zip
mkdir -p ~/.claude/skills && unzip -o /tmp/teleops.zip -d ~/.claude/skills
```
Windows (PowerShell):
```powershell
Invoke-WebRequest https://github.com/emrgim/TeleOps/raw/main/skills/teleops.skill -OutFile $env:TEMP\teleops.zip
Expand-Archive -Force $env:TEMP\teleops.zip "$HOME\.claude\skills"
```

## 4. Rules

1. **You speak as the bot.** Before any tool that changes Telegram (send, react, edit, delete, forward, pin, invite link, profile), confirm the chat and the exact text with the user, unless they explicitly asked for exactly that. Delete and profile changes cannot be undone.
2. **A bot cannot write first.** It can write only to people who pressed Start in its chat and to the groups and channels it is in. `CANNOT_WRITE` or `BLOCKED` means exactly that: tell the user; there is no other way round.
3. **Pick the bot.** The owner may have several bots. Call `telegram_bots` and pass `bot` (id or @username) when it is not the default one.
4. **Never guess a chat id.** With only a name, call `telegram_find_contact` and use the id it returns. Chats are written as an id (`123456789` a person, `-1001234567890` a group or channel), an `@username`, or the exact chat name. If a name matches several chats you get `AMBIGUOUS_CHAT` with the candidates: ask the user which one.
5. **Only what the bot saw.** A bot has no access to older Telegram history: `telegram_get_messages` and `telegram_search_messages` read what TeleOps stored since the bot was linked. In groups with privacy mode on (`readsAllGroupMessages: false`) the bot gets only commands, replies to its messages and mentions; `telegram_update_profile` `read_all_group_messages: true` turns that off.
6. **Formatting:** plain text by default. With `parse_mode` `HTML` (`<b>`, `<i>`, `<a href>`, `<code>`) or `MarkdownV2`, follow Telegram's rules; a formatting mistake gives `BAD_FORMATTING`. Plain text longer than 4096 characters is split by itself.
7. **Buttons:** `buttons` is a list of rows; a button with `url` opens a link, a button with `data` (max 64 bytes) comes back when pressed, as a `[button] …` message in the chat and as the `button.pressed` event. Read the answers with `telegram_get_messages`.
8. **Retries:** pass the same `idempotency_key` when you retry a send. The message then goes out at most once.
9. **Voice messages** (`voice`, `audio`, `video_note`): the message carries its `transcript` when it is ready. If it is null, call `telegram_transcribe_voice`.
10. **Media:** `telegram_download_media` gives a link valid 1 hour, plus the image itself when it is small (bots can download files up to 20 MB). Send files with `url` (http/https), `base64` or the `file_id` of a file the bot already has; up to 10 MB for photos and 50 MB for other files.
11. **The owner's settings** may limit the chats a bot may write to (`NOT_ALLOWED`). Tell the user; do not try another way round.
12. **`teleops_feedback` becomes a GitHub issue.** Never put names, chat ids or message text in it.
13. Reply to the user in their language.

## 5. Recipes

| The user asks | Do |
|---|---|
| "What did Mario write to the bot today?" | `telegram_find_contact` `Mario` → `telegram_get_messages` with `chat` and `after` = today 00:00 (ISO) |
| "Who wrote to the bot?" | `telegram_list_chats` `type: "private"`, then `telegram_get_messages` on the chats that matter |
| "Find the message about the invoice" | `telegram_search_messages` `query: "invoice"` (it also searches voice transcripts) |
| "Reply to his last message" | `telegram_get_messages` (oldest → newest: the last one is the newest) → confirm → `telegram_send_text` with `reply_to` = its id |
| "Ask the crew group who comes tonight, with Yes / No buttons" | confirm → `telegram_send_text` `to: "Crew"`, `buttons: [[{"text":"Yes","data":"yes"},{"text":"No","data":"no"}]]`; later `telegram_get_messages` shows each `[button] Yes (yes)` with who pressed it |
| "Send them the PDF" | confirm → `telegram_send_media` `type: "document"`, `url` or `base64`, `file_name` |
| "Send the venue" | `telegram_send_location` `latitude`, `longitude`, with `name` and `address` it goes out as a place |
| "What did the voice message say?" | `telegram_transcribe_voice` `message_id` (+ `chat`) |
| "Who is in the group, and can the bot pin there?" | `telegram_get_chat` `chat: "Crew"` |
| "Fix the typo in the bot's last message" | `telegram_get_messages` → confirm → `telegram_edit_message` |
| "Give me an invite link valid one day for 10 people" | `telegram_invite_link` `chat`, `expire_hours: 24`, `member_limit: 10` (the bot must be an administrator allowed to invite) |
| "Change the bot's description and its / menu" | confirm → `telegram_update_profile` `description`, `commands: [{"command":"help","description":"What I can do"}]` |

## 6. Tools at a glance

<!-- tools:start (generated by `npm run skill`) -->
**Bots and profile**

| Tool | Scope | What it does |
|---|---|---|
| `telegram_bots` | read | List the Telegram bots and user accounts linked to this server: kind (bot or user), name, @username, link, connection state, the default one, whether a bot reads all group messages (privacy mode off). |
| `telegram_get_profile` | read | Read the profile of one of the bots: name, @username, short description (about), description (shown in an empty chat), commands, profile photo, privacy mode. |
| `telegram_update_profile` | send | Change one of the bots ON TELEGRAM ITSELF (everyone sees it): name (1–64 characters, also its name in TeleOps), short description (about, max 120), description (max 512, shown in an empty chat), commands (the / menu), profile photo (http(s) image URL, data: URL or base64) or remove it, and privacy mode (read all group messages or only commands and replies). |

**Read chats and messages**

| Tool | Scope | What it does |
|---|---|---|
| `telegram_list_chats` | read | List the chats of a bot (most recent first): private chats with the people who started it, groups and channels it is in, with the last message and the bot's status there (member, administrator, left, kicked = blocked by the person). |
| `telegram_get_messages` | read | Get the messages of one chat that the bot or account received or sent, in chronological order (oldest → newest). |
| `telegram_search_messages` | read | Full-text search across the stored messages of a bot or account (newest first), including what was said in transcribed voice messages. |
| `telegram_download_media` | read | Get the media of a message (Telegram lets bots download files up to 20 MB): returns a temporary download link (1 h) and, for small images, the image itself. |
| `telegram_transcribe_voice` | read | Transcribe a Telegram voice message, audio file or round video (type voice, audio or video_note) to text, so you know what was said. |

**People and chats**

| Tool | Scope | What it does |
|---|---|---|
| `telegram_find_contact` | read | Find the people who wrote to a bot and the groups and channels it is in, by name, @username or id. |
| `telegram_get_chat` | read | A chat as Telegram describes it now: title, @username, description or bio, number of members, administrators, pinned message, and what the bot may do there (its status and rights). |

**Send**

| Tool | Scope | What it does |
|---|---|---|
| `telegram_send_text` | send | Send a Telegram text message from a bot or a Telegram account. |
| `telegram_send_media` | send | Send a photo, video, audio, voice message, document, sticker, GIF (animation) or round video (video_note) from a public URL, base64 or the file_id of a file the bot already has. |
| `telegram_send_location` | send | Send a location pin; with name and address it is sent as a place (venue). |

**Act on messages and chats**

| Tool | Scope | What it does |
|---|---|---|
| `telegram_react` | send | Put a reaction on a message: one emoji among the ones Telegram allows (👍 ❤ 🔥 🎉 👏 😁 🤔 👌 🙏 and others); an empty emoji removes the bot's reaction. |
| `telegram_edit_message` | send | Edit a message the bot sent: its text, or its caption for a media message, and its buttons. |
| `telegram_delete_message` | send | Delete a message for everyone: the bot's own messages, messages in a private chat with the bot, and any message of a group where the bot is an administrator allowed to delete (Telegram: within 48 hours). |
| `telegram_forward_message` | send | Forward a message to another chat (it shows where it comes from), or copy it (it looks like a new message of the bot). |
| `telegram_pin_message` | send | Pin a message in a chat, or unpin it (without message_id: the most recent pinned one). |
| `telegram_invite_link` | send | Create a new invite link to a group or channel where the bot is an administrator with the right to invite users: optional name, expiry, member limit, or approval of each request. |

**TeleOps itself**

| Tool | Scope | What it does |
|---|---|---|
| `teleops_feedback` | read | Send feedback about TeleOps itself (a bug, an idea, anything else) to its developers. |
<!-- tools:end -->

## 7. Errors you can meet

| Error | Meaning | Do |
|---|---|---|
| `NOT_CONNECTED` | The bot is not running right now (stopped, another reader, token revoked) | `telegram_bots` shows its state; the owner fixes it in TeleOps → Bots |
| `ACCOUNT_NOT_FOUND`, `NO_ACCOUNT` | Wrong `bot`, or no bot yet | `telegram_bots` |
| `CHAT_NOT_FOUND`, `AMBIGUOUS_CHAT`, `INVALID_CHAT` | No chat, or several chats, with that name; or Telegram does not know it | `telegram_find_contact`, then the chat id |
| `CANNOT_WRITE`, `BLOCKED` | The person never pressed Start, blocked the bot, or the bot lacks the rights in the group | Tell the user |
| `NOT_A_MEMBER` | The bot was removed from that chat | Tell the user |
| `FLOOD_WAIT` | Telegram asks to slow down (short waits are waited out by TeleOps) | Try again after the seconds it says |
| `BAD_FORMATTING` | `parse_mode` text that Telegram cannot read | Fix the HTML / MarkdownV2, or send plain text |
| `BAD_BUTTON`, `BAD_COMMAND` | A button or a command Telegram would refuse | Follow the message |
| `NOT_OWN_MESSAGE`, `NOT_ALLOWED`, `MESSAGE_NOT_FOUND` | A bot edits only its own messages; the owner's allowlist blocks this chat; the message is gone | — |
| `FORBIDDEN` | The key or grant lacks a scope, or cannot use that bot | The owner changes it in **Connectors** |
| `STT_OFF`, `STT_LOCAL_MISSING` | Voice transcription is off or not installed | The owner: **Settings → Voice** |
| `MEDIA_TOO_LARGE`, `MEDIA_FETCH_FAILED` | The file is too big, or its URL could not be read | A smaller file, or `base64` |

## 8. Beyond MCP

- REST API with the same functions: `https://teleops.example.com/docs`.
- Webhooks (**Connectors → Webhooks**) for automations: `message.received`, `message.sent`, `message.edited`, `message.reaction`, `message.transcribed`, `button.pressed`, `chat.member`, `connection.update`, `profile.update`. Each body has `context`, one line in plain words that an agent can read as it is, and is signed with `X-TeleOps-Signature`.
- Live events as SSE: `GET /v1/events`.
