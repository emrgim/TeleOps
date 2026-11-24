<p align="center">
  <img src="assets/logo.svg" width="120" alt="TeleOps">
</p>

<h1 align="center">TeleOps</h1>

<p align="center">
  <b>Your Telegram bots, for your agents.</b><br>
  A self-hosted <b>MCP server + REST API + webhooks</b> on the Telegram Bot API: several bots, OAuth 2.1, a config page, English / Italian.
</p>

---

TeleOps is the Telegram sibling of [WhatsOps](https://github.com/emrgim/WhatsOps): the same server (config page, MCP, REST, webhooks, OAuth, backups, voice transcription, updates), but instead of linking a WhatsApp number it runs **Telegram bots** made with [@BotFather](https://t.me/BotFather). Each bot reads its updates itself (long polling): Telegram needs no public URL, only remote agents do.

- **MCP** (`/mcp`, Streamable HTTP, stateless) for Claude, ChatGPT, Cursor, Gemini, Grok, Grok Bot, Hermes: OAuth 2.1 with PKCE and dynamic registration, or API keys (`Authorization: Bearer tok_…`).
- **REST API** with the same functions, OpenAPI at `/docs`.
- **Several bots** in one server; each bot's id is its Telegram id (the number before `:` in the token), with a default bot for calls that do not name one.
- **Messages are stored as they arrive** (SQLite by default, or PostgreSQL / MySQL, switchable from the config page with a copy of the data). A bot has no access to older Telegram history: TeleOps keeps what it sees.
- **Buttons**: inline keyboards on any message; a press is answered at once, stored as a `[button] …` message of the chat and sent as the `button.pressed` event.
- **Bot profile on Telegram**: name, short description, description, `/` commands, profile photo and privacy mode (read every group message, or only commands and replies), from the config page, MCP or REST.
- **Webhooks**, signed (`X-TeleOps-Signature: sha256=HMAC(secret, X-TeleOps-Timestamp + "." + body)`), retried, with the receiver's own key or header and a `context` line in plain words for agents. Events: `message.received`, `message.sent`, `message.edited`, `message.reaction`, `message.transcribed`, `button.pressed`, `chat.member` (added / removed / blocked), `connection.update`, `profile.update`. Live events also as SSE (`GET /v1/events`).
- **Voice messages → text** (Settings → Voice): faster-whisper installed by TeleOps itself, a command, or an online service (xAI, OpenAI, Groq…). Agents get `transcript` on voice messages.
- **Sign-in to the config page** with a code sent **by your bot to your own Telegram** (link your account once: Settings → General → Your Telegram, then press Start), a password, or a one-time link.
- **Flood limits** handled: sends are queued per chat, `retry_after` is waited out, a group that becomes a supergroup is followed.
- **Safety**: optional allowlist of the chats a bot may write to; the bot token never appears in logs or errors; another program reading the same bot is detected (`conflict`); a bot that sends its updates to someone else's webhook is taken over only when you confirm.
- **Backup** (one file, optional password), **auto-update** from GitHub releases, **feedback and crash reports** as GitHub issues, **web app** (installable PWA), Light / Dark / System theme.

## MCP tools

Explained one by one, with parameters, in the [agent skill](skills/teleops/references/tools.md).

`telegram_bots`, `telegram_get_profile`, `telegram_update_profile`, `telegram_list_chats`, `telegram_get_messages`, `telegram_search_messages`, `telegram_download_media`, `telegram_transcribe_voice`, `telegram_find_contact`, `telegram_get_chat`, `telegram_send_text`, `telegram_send_media`, `telegram_send_location`, `telegram_react`, `telegram_edit_message`, `telegram_delete_message`, `telegram_forward_message`, `telegram_pin_message`, `telegram_invite_link`, `teleops_feedback`.

## Plugins

A plugin adds features — MCP tools, automations on messages, web addresses for other services — and is a **public GitHub repository** with a `teleops-plugin.json` at its top. **Connectors → Plugins → +**, paste the repository's address, **Check**, **Install**. Build yours from the [plugin template](https://github.com/emrgim/teleops-plugin-template); everything a plugin can do is in the [plugin guide](docs/plugins.md).

## Install

From source (Node.js 24+):

```bash
git clone https://github.com/emrgim/TeleOps.git && cd TeleOps
npm ci && npm run build
npm start                              # listens on http://127.0.0.1:8811
node dist/cli.js login-link --local    # one-time sign-in link
```

Installers with Node.js inside (`.dmg`, `-setup.exe`, `.deb`, `.rpm`, and `install/linux.sh` for any Linux without root) are built by the *packages* workflow and attached to [releases](https://github.com/emrgim/TeleOps/releases).

As a service on Linux: `deploy/teleops.service` (systemd user unit).

### Add a bot

1. On Telegram, open **@BotFather** → `/newbot` (or `/mybots` → API Token for a bot you already have) and copy the token.
2. TeleOps → **Accounts → + → Bot** → paste the token.
3. Optional: in the bot's **Profile**, set the descriptions, the `/` commands, and *Read every message in groups* if the bot must see all group messages (privacy mode off).

A bot can be read by one program at a time: if another program uses the same token, stop it (TeleOps shows *Another reader*). If the bot sends its updates to a webhook, TeleOps asks before removing it.

### Add a Telegram account

A person's account (yours or a colleague's) instead of a bot: it reads the whole history of its chats and writes as that person.

1. Once for each TeleOps, create a **Telegram app**: Telegram lets a program log in to an account only through an app registered by its owner — without it, linking does not work. Open [my.telegram.org](https://my.telegram.org/apps), log in with your number, open **API development tools**, create an app (any name) and copy **api_id** and **api_hash**. TeleOps asks for them the first time (they stay in **Settings → General → Telegram app**), or set `TELEOPS_API_ID` / `TELEOPS_API_HASH`.
2. TeleOps → **Accounts → + → Telegram account** → **QR code** (on the phone: Telegram → Settings → Devices → Link Desktop Device) or **Phone number** (then the code Telegram sends, and the password if the account has one).

The session is stored sealed with a key kept next to the data (`user-sessions.key`): a copy of the database alone does not open the account. It appears in Telegram → Settings → Devices as TeleOps, and can be closed from there.

### Connect an agent

MCP endpoint: `https://<your TeleOps>/mcp` (or `http://127.0.0.1:8811/mcp` on the same machine). **Connectors → MCP** has ready-to-paste settings for each app; the [agent skill](skills/teleops/SKILL.md) (`skills/teleops.skill`) explains every tool to the agent. For agents in the cloud, publish TeleOps over HTTPS (Caddy, nginx, Cloudflare Tunnel…) and set **Settings → General → Public URL**.

## Configuration

Everything (bots, keys, webhooks, database, appearance) is set from the config page. Environment variables (see `.env.example`):

| Variable | Default | |
|---|---|---|
| `TELEOPS_HOST` / `TELEOPS_PORT` | `127.0.0.1` / `8811` | HTTP listener |
| `TELEOPS_PUBLIC_URL` | — | Public base URL (OAuth issuer, links) |
| `TELEOPS_DATA_DIR` | `~/.local/share/teleops` (macOS `~/Library/Application Support/TeleOps`, Windows `%LOCALAPPDATA%\TeleOps`) | Database, logs, backups |
| `TELEOPS_DB_URL` | `sqlite://<data dir>/teleops.db` | or `postgres://…`, `mysql://…` |
| `TELEOPS_LANG` | OS language | `en` or `it` for MCP tools, errors, login code |
| `TELEOPS_BOT_API` | `https://api.telegram.org` | A [local Bot API server](https://github.com/tdlib/telegram-bot-api), or a test double |
| `WEBHOOK_ALLOW_CHATS` | unset | Only forward webhook events from these chat ids / @usernames |

## REST examples

```bash
KEY=tok_…   # Connectors → API → Create key
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8811/v1/bots
curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:8811/v1/chats?type=private"
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
     http://127.0.0.1:8811/v1/messages/text \
     -d '{"to":"@mario","text":"Tonight?","buttons":[[{"text":"Yes","data":"yes"},{"text":"No","data":"no"}]]}'
```

## Development

```bash
npm run typecheck
npm test                         # includes an end-to-end test against a fake Bot API (test/telegram.test.ts)
npm run build && npm run skill   # after changing an MCP tool: regenerates skills/teleops
```

Layout: `src/tg/` is the Telegram layer (`api.ts` Bot API client; `account.ts` one bot: polling, updates, sending, profile; `manager.ts` the bots; `service.ts` what MCP and REST call; `store.ts` chats, people and messages in the database). `src/mcp/server.ts` has the MCP tools, `src/api/routes.ts` the REST API and the config page API, `public/` the config page.
