# TeleOps MCP tools (reference)

<!-- Generated from the MCP server by `npm run skill`: do not edit by hand. -->

20 tools. Scope = what the credential (API key or OAuth grant) needs: `read` or `send` (`admin` includes both). The Telegram tools take `bot` (id or @username of one of the owner's bots; the default bot when omitted).

## What the server tells every agent on connect

> Telegram bots and Telegram accounts of the owner: each one reads and sends its own messages.
> - A bot can write only to people who pressed Start in its chat and to the groups and channels it is in; it cannot write first to anyone else.
> - Chats accept a chat id (123456789, -1001234567890), an @username or an exact chat name; find people and chats with telegram_find_contact.
> - A bot sees only what happened since it was linked: telegram_list_chats and telegram_get_messages read what TeleOps stored, not older Telegram history.
> - In groups, a bot with privacy mode on gets only commands, replies to its messages and mentions (telegram_bots → readsAllGroupMessages).
> - Messages go out as the bot: confirm wording and recipient with the user before calling a send tool unless they explicitly asked you to send.
> - Buttons under a message: a press comes back as a [button] message in the chat and as the button.pressed event.
> - Use telegram_bots to see the bots; pass "bot" (id or @username) to use one that is not the default.
> - Telegram accounts of people (telegram_bots → kind user) use the same tools: they read the whole history of their chats from Telegram and write as that person, to anyone the app could; they cannot send buttons. Treat their chats as private.
> - Voice messages (type voice, audio or video_note): read their transcript, or call telegram_transcribe_voice to know what was said.
> - Every tool explained, with examples (Agent Skill): https://raw.githubusercontent.com/emrgim/TeleOps/main/skills/teleops/SKILL.md
> - Reply to the user in their language.

## Bots and profile

### `telegram_bots` — List bots and accounts

Scope `read` · reads only

List the Telegram bots and user accounts linked to this server: kind (bot or user), name, @username, link, connection state, the default one, whether a bot reads all group messages (privacy mode off).

No parameters.

### `telegram_get_profile` — Get a bot's profile

Scope `read` · reads only

Read the profile of one of the bots: name, @username, short description (about), description (shown in an empty chat), commands, profile photo, privacy mode.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |
| `include_photo` | boolean | no | Also return the profile photo as an image (default false) |

### `telegram_update_profile` — Edit a bot's profile

Scope `send` · changes Telegram

Change one of the bots ON TELEGRAM ITSELF (everyone sees it): name (1–64 characters, also its name in TeleOps), short description (about, max 120), description (max 512, shown in an empty chat), commands (the / menu), profile photo (http(s) image URL, data: URL or base64) or remove it, and privacy mode (read all group messages or only commands and replies). Confirm the change with the user first.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |
| `name` | string (1–64 chars) | no | New name |
| `about` | string (max 120 chars) | no | New short description (empty string clears it) |
| `description` | string (max 512 chars) | no | New description (empty string clears it) |
| `commands` | object[] | no | The command menu: the whole list (empty list removes it), e.g. [{"command":"help","description":"What I can do"}] |
| `photo` | string | no | New profile photo: http(s) image URL, data: URL or base64 |
| `remove_photo` | boolean | no | Remove the profile photo |
| `read_all_group_messages` | boolean | no | true = the bot reads every message of its groups (privacy mode off); false = only commands, replies to it and mentions |

## Read chats and messages

### `telegram_list_chats` — List chats

Scope `read` · reads only

List the chats of a bot (most recent first): private chats with the people who started it, groups and channels it is in, with the last message and the bot's status there (member, administrator, left, kicked = blocked by the person). A bot sees only chats where something happened since it was linked.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |
| `limit` | integer 1–200 | no | Max chats (default 30) |
| `offset` | integer ≥ 0 | no | Skip this many chats (paging) |
| `query` | string | no | Filter by chat name or @username |
| `type` | "all" \| "private" \| "groups" \| "channels" | no | Chat type: all, private, groups or channels |

### `telegram_get_messages` — Read chat messages

Scope `read` · reads only

Get the messages of one chat that the bot or account received or sent, in chronological order (oldest → newest). Use before/after (ISO date) to page. For a Telegram account (kind user) the history is read from Telegram itself, older messages included. Voice messages (type voice, with seconds) carry their transcript when it is ready; when transcript is null, call telegram_transcribe_voice. Button presses appear as type button.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | yes | Chat: chat id, @username or exact chat name |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |
| `limit` | integer 1–500 | no | Max messages (default 30) |
| `before` | string | no | Only messages before this ISO timestamp |
| `after` | string | no | Only messages after this ISO timestamp |

### `telegram_search_messages` — Search messages

Scope `read` · reads only

Full-text search across the stored messages of a bot or account (newest first), including what was said in transcribed voice messages. A Telegram account (kind user) also searches on Telegram itself: all its chats, all the history.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `query` | string (not empty) | yes | Text to search for |
| `chat` | string | no | Restrict to one chat (id, @username or name) |
| `since` | string | no | ISO date lower bound |
| `limit` | integer 1–200 | no | Max results (default 30) |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

### `telegram_download_media` — Download media

Scope `read` · reads only

Get the media of a message (Telegram lets bots download files up to 20 MB): returns a temporary download link (1 h) and, for small images, the image itself. For a voice or audio message it also returns what was said (transcript) and, with include_audio, the audio itself.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `message_id` | string | yes | Message id |
| `chat` | string | no | Chat: chat id, @username or exact chat name |
| `include_audio` | boolean | no | For voice / audio messages: also return the audio itself (only for clients that can play or process audio; default false) |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

### `telegram_transcribe_voice` — Listen to a voice message

Scope `read` · reads only

Transcribe a Telegram voice message, audio file or round video (type voice, audio or video_note) to text, so you know what was said. Returns the transcript, the language and the length in seconds. Transcripts are kept: asking again is instant. Use force to transcribe again.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `message_id` | string | yes | Message id |
| `chat` | string | no | Chat: chat id, @username or exact chat name |
| `force` | boolean | no | Transcribe again even if a transcript is already stored |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

## People and chats

### `telegram_find_contact` — Find people and chats

Scope `read` · reads only

Find the people who wrote to a bot and the groups and channels it is in, by name, @username or id. Returns the chat ids to use with the other tools (a person's private chat has the same id as the person).

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `query` | string (not empty) | yes | Name, @username or id |
| `limit` | integer 1–100 | no | Max results (default 20) |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

### `telegram_get_chat` — Chat details

Scope `read` · reads only

A chat as Telegram describes it now: title, @username, description or bio, number of members, administrators, pinned message, and what the bot may do there (its status and rights).

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | yes | Chat: chat id, @username or exact chat name |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

## Send

### `telegram_send_text` — Send text message

Scope `send` · changes Telegram

Send a Telegram text message from a bot or a Telegram account. A bot can write only to people who started it and to groups and channels it is in; a Telegram account writes as that person, to anyone it could write to from the app (buttons are for bots only). Plain text longer than 4096 characters is split into several messages. Confirm recipient and text with the user first.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `to` | string | yes | Recipient: chat id, @username or exact chat name |
| `text` | string (1–65000 chars) | yes | Message text |
| `parse_mode` | "HTML" \| "MarkdownV2" \| "Markdown" | no | Formatting of the text: HTML or MarkdownV2 (Telegram rules, escape special characters); omit for plain text |
| `reply_to` | string | no | Id of a message of the same chat to reply to |
| `buttons` | object \| object[][] | no | Buttons under the message: each item is a row (one button, or a list of buttons side by side). A button with url opens the link; the others come back as button.pressed (webhook, events) and as a [button] message in the chat. |
| `silent` | boolean | no | Deliver without sound |
| `link_preview` | boolean | no | false = no preview of the first link |
| `thread_id` | string | no | Forum topic (message thread) id |
| `idempotency_key` | string | no | Same key = sent at most once |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

### `telegram_send_media` — Send media

Scope `send` · changes Telegram

Send a photo, video, audio, voice message, document, sticker, GIF (animation) or round video (video_note) from a public URL, base64 or the file_id of a file the bot already has. Up to 10 MB for photos and 50 MB for other files.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `to` | string | yes | Recipient: chat id, @username or exact chat name |
| `type` | "photo" \| "image" \| "video" \| "audio" \| "voice" \| "document" \| "sticker" \| "animation" \| "video_note" | yes | Media type |
| `url` | string | no | http(s) URL of the file |
| `base64` | string | no | File content as base64 (or data: URL) |
| `file_id` | string | no | Telegram file_id of a file this bot already sent or received |
| `mimetype` | string | no | MIME type, e.g. image/jpeg |
| `file_name` | string | no | File name (documents) |
| `caption` | string (max 1024 chars) | no | Caption |
| `parse_mode` | "HTML" \| "MarkdownV2" \| "Markdown" | no | Formatting of the text: HTML or MarkdownV2 (Telegram rules, escape special characters); omit for plain text |
| `reply_to` | string | no | Id of a message of the same chat to reply to |
| `buttons` | object \| object[][] | no | Buttons under the message: each item is a row (one button, or a list of buttons side by side). A button with url opens the link; the others come back as button.pressed (webhook, events) and as a [button] message in the chat. |
| `silent` | boolean | no | Deliver without sound |
| `thread_id` | string | no | Forum topic (message thread) id |
| `idempotency_key` | string | no | Same key = sent at most once |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

### `telegram_send_location` — Send location

Scope `send` · changes Telegram

Send a location pin; with name and address it is sent as a place (venue).

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `to` | string | yes | Recipient: chat id, @username or exact chat name |
| `latitude` | number | yes | Latitude |
| `longitude` | number | yes | Longitude |
| `name` | string | no | Place name |
| `address` | string | no | Address |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

## Act on messages and chats

### `telegram_react` — React to message

Scope `send` · changes Telegram

Put a reaction on a message: one emoji among the ones Telegram allows (👍 ❤ 🔥 🎉 👏 😁 🤔 👌 🙏 and others); an empty emoji removes the bot's reaction.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | yes | Chat: chat id, @username or exact chat name |
| `message_id` | string | yes | Message id |
| `emoji` | string | yes | e.g. 👍 — empty string removes |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

### `telegram_edit_message` — Edit message

Scope `send` · changes Telegram

Edit a message the bot sent: its text, or its caption for a media message, and its buttons.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | yes | Chat: chat id, @username or exact chat name |
| `message_id` | string | yes | Message id |
| `text` | string (not empty) | yes | New text |
| `parse_mode` | "HTML" \| "MarkdownV2" \| "Markdown" | no | Formatting of the text: HTML or MarkdownV2 (Telegram rules, escape special characters); omit for plain text |
| `buttons` | object \| object[][] | no | Buttons under the message: each item is a row (one button, or a list of buttons side by side). A button with url opens the link; the others come back as button.pressed (webhook, events) and as a [button] message in the chat. |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

### `telegram_delete_message` — Delete message

Scope `send` · changes Telegram, cannot be undone

Delete a message for everyone: the bot's own messages, messages in a private chat with the bot, and any message of a group where the bot is an administrator allowed to delete (Telegram: within 48 hours).

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | yes | Chat: chat id, @username or exact chat name |
| `message_id` | string | yes | Message id |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

### `telegram_forward_message` — Forward message

Scope `send` · changes Telegram

Forward a message to another chat (it shows where it comes from), or copy it (it looks like a new message of the bot).

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `from_chat` | string | yes | Chat the message is in |
| `message_id` | string | yes | Message id |
| `to` | string | yes | Recipient: chat id, @username or exact chat name |
| `copy` | boolean | no | true = copy without "forwarded from" |
| `silent` | boolean | no | Deliver without sound |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

### `telegram_pin_message` — Pin message

Scope `send` · changes Telegram

Pin a message in a chat, or unpin it (without message_id: the most recent pinned one). In groups the bot must be an administrator allowed to pin.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | yes | Chat: chat id, @username or exact chat name |
| `message_id` | string | no | Message id |
| `unpin` | boolean | no | true = unpin |
| `silent` | boolean | no | Pin without notifying the members |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

### `telegram_invite_link` — Create an invite link

Scope `send` · changes Telegram

Create a new invite link to a group or channel where the bot is an administrator with the right to invite users: optional name, expiry, member limit, or approval of each request.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `chat` | string | yes | Chat: chat id, @username or exact chat name |
| `name` | string (max 32 chars) | no | Name of the link (only administrators see it) |
| `expire_hours` | number 0.1–8760 | no | Hours until the link expires |
| `member_limit` | integer 1–99999 | no | How many people can join with it |
| `join_request` | boolean | no | true = people ask to join and an administrator approves |
| `bot` | string | no | Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots). |

## TeleOps itself

### `teleops_feedback` — Send feedback about TeleOps

Scope `read` · changes Telegram

Send feedback about TeleOps itself (a bug, an idea, anything else) to its developers. It opens an issue in the GitHub repository of TeleOps, signed only with this installation code: never put names, chat ids, message contents or keys in it. Show the text to the user and get their OK before sending.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `kind` | "bug" \| "idea" \| "other" | yes | bug = something does not work, idea = a request or an improvement, other = anything else |
| `title` | string (3–120 chars) | yes | Short title (3–120 characters) |
| `message` | string (5–8000 chars) | yes | What happened or what you would like, in detail |
| `include_diagnostics` | boolean | no | Attach technical info: TeleOps version, operating system, database type, how many bots are linked (no names, no messages). Default true. |
