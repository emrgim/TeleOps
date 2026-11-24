import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { VERSION } from '../config.js'
import { logger } from '../log.js'
import { accountFor, authenticate, requireScope, visibleAccounts, type App } from '../app.js'
import type { Principal } from '../security/auth.js'
import { publicOrigin } from '../security/auth.js'
import { localizeError, reqLang, tr, type Lang } from '../i18n.js'
import { AppError } from '../util.js'

type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | { type: 'audio'; data: string; mimeType: string })[]; isError?: boolean }

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

/** The scope each tool needs (filled when the tools are registered; read by the skill builder). */
export const TOOL_SCOPES = new Map<string, 'read' | 'send'>()

/** Build a per-request MCP server; titles, descriptions and errors follow `lang`. */
export function buildMcpServer(app: App, p: Principal, origin: string, lang: Lang): McpServer {
  const L = (s: string) => tr(lang, s)
  const server = new McpServer(
    {
      name: 'teleops',
      title: 'TeleOps',
      version: VERSION,
      description: L('Read and send Telegram messages through your own bots and Telegram accounts.'),
      websiteUrl: origin,
      icons: [
        { src: `${origin}/favicon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
        { src: `${origin}/favicon-192.png`, mimeType: 'image/png', sizes: ['192x192'] },
      ],
    },
    { capabilities: { tools: {}, logging: {} }, instructions: L('@instructions') },
  )

  const bot = z.string().optional().describe(L('Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots).'))
  const chatArg = z.string().describe(L('Chat: chat id, @username or exact chat name'))
  const button = z.object({
    text: z.string().min(1).max(64).describe(L('Text on the button')),
    url: z.string().optional().describe(L('Link the button opens (https://…)')),
    data: z.string().max(64).optional().describe(L('Data sent back as the event button.pressed when the button is pressed (default: the text)')),
  })
  const buttons = z
    .array(z.union([button, z.array(button)]))
    .max(100)
    .optional()
    .describe(L('Buttons under the message: each item is a row (one button, or a list of buttons side by side). A button with url opens the link; the others come back as button.pressed (webhook, events) and as a [button] message in the chat.'))
  const parseMode = z.enum(['HTML', 'MarkdownV2', 'Markdown']).optional().describe(L('Formatting of the text: HTML or MarkdownV2 (Telegram rules, escape special characters); omit for plain text'))

  const tool = <S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    scope: 'read' | 'send',
    shape: S,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean },
    fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown | ToolResult>,
  ) => {
    const t = L(title)
    TOOL_SCOPES.set(name, scope)
    server.registerTool(name, { title: t, description: L(description), inputSchema: shape, annotations: { title: t, ...annotations } }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        requireScope(p, scope)
        const r = await fn(args)
        if (r && typeof r === 'object' && 'content' in (r as object) && Array.isArray((r as ToolResult).content)) return r
        return ok(r)
      } catch (e) {
        const msg = e instanceof AppError ? `${e.code}: ${localizeError(e, lang)}` : `ERROR: ${String((e as Error)?.message ?? e)}`
        if (!(e instanceof AppError)) logger.warn({ tool: name, err: String((e as Error)?.stack ?? e) }, 'tool failed')
        return { isError: true, content: [{ type: 'text', text: msg }] }
      }
    }) as never)
  }

  const acc = (id?: string) => accountFor(app, p, id)

  tool('telegram_bots', 'List bots and accounts', 'List the Telegram bots and user accounts linked to this server: kind (bot or user), name, @username, link, connection state, the default one, whether a bot reads all group messages (privacy mode off).', 'read', {}, { readOnlyHint: true }, async () =>
    visibleAccounts(app, p).map((a) => {
      const s = a.status()
      return { id: s.id, kind: s.kind, name: s.name, username: s.username, link: s.link, about: s.about, state: s.state, default: s.default, readsAllGroupMessages: s.readsAllGroupMessages }
    }),
  )

  tool(
    'telegram_get_profile',
    'Get a bot\'s profile',
    'Read the profile of one of the bots: name, @username, short description (about), description (shown in an empty chat), commands, profile photo, privacy mode.',
    'read',
    { bot, include_photo: z.boolean().optional().describe(L('Also return the profile photo as an image (default false)')) },
    { readOnlyHint: true },
    async (a) => {
      const ac = acc(a.bot)
      const pr = await ac.profile()
      const photo = a.include_photo ? ac.photoData() : null
      if (!photo) return pr
      return { content: [{ type: 'text', text: JSON.stringify(pr, null, 2) }, { type: 'image', data: photo.data.toString('base64'), mimeType: photo.type }] }
    },
  )

  tool(
    'telegram_update_profile',
    'Edit a bot\'s profile',
    'Change one of the bots ON TELEGRAM ITSELF (everyone sees it): name (1–64 characters, also its name in TeleOps), short description (about, max 120), description (max 512, shown in an empty chat), commands (the / menu), profile photo (http(s) image URL, data: URL or base64) or remove it, and privacy mode (read all group messages or only commands and replies). Confirm the change with the user first.',
    'send',
    {
      bot,
      name: z.string().min(1).max(64).optional().describe(L('New name')),
      about: z.string().max(120).optional().describe(L('New short description (empty string clears it)')),
      description: z.string().max(512).optional().describe(L('New description (empty string clears it)')),
      commands: z
        .array(z.object({ command: z.string().min(1).max(33), description: z.string().min(1).max(256) }))
        .max(100)
        .optional()
        .describe(L('The command menu: the whole list (empty list removes it), e.g. [{"command":"help","description":"What I can do"}]')),
      photo: z.string().optional().describe(L('New profile photo: http(s) image URL, data: URL or base64')),
      remove_photo: z.boolean().optional().describe(L('Remove the profile photo')),
      read_all_group_messages: z.boolean().optional().describe(L('true = the bot reads every message of its groups (privacy mode off); false = only commands, replies to it and mentions')),
    },
    { destructiveHint: false, idempotentHint: true },
    async (a) => {
      const ac = acc(a.bot)
      let photo: Buffer | null | undefined
      if (a.remove_photo) photo = null
      else if (a.photo) photo = /^https?:\/\//i.test(a.photo) ? (await app.svc.fetchMedia(a.photo)).buf : Buffer.from(a.photo.replace(/^data:[^;]+;base64,/, ''), 'base64')
      if (a.name === undefined && a.about === undefined && a.description === undefined && a.commands === undefined && photo === undefined && a.read_all_group_messages === undefined)
        throw new AppError('PROFILE_EMPTY', 'Nothing to change: give a name, a description, commands or a photo', 400)
      return ac.editProfile({ name: a.name, about: a.about, description: a.description, commands: a.commands, photo, readAllGroupMessages: a.read_all_group_messages })
    },
  )

  tool(
    'teleops_feedback',
    'Send feedback about TeleOps',
    'Send feedback about TeleOps itself (a bug, an idea, anything else) to its developers. It opens an issue in the GitHub repository of TeleOps, signed only with this installation code: never put names, chat ids, message contents or keys in it. Show the text to the user and get their OK before sending.',
    'read',
    {
      kind: z.enum(['bug', 'idea', 'other']).describe(L('bug = something does not work, idea = a request or an improvement, other = anything else')),
      title: z.string().min(3).max(120).describe(L('Short title (3–120 characters)')),
      message: z.string().min(5).max(8000).describe(L('What happened or what you would like, in detail')),
      include_diagnostics: z.boolean().optional().describe(L('Attach technical info: TeleOps version, operating system, database type, how many bots are linked (no names, no messages). Default true.')),
    },
    { openWorldHint: true },
    async (a) => {
      const r = await app.reports.sendFeedback({ kind: a.kind, title: a.title, message: a.message, diagnostics: a.include_diagnostics ?? true }, 'mcp')
      return { issue: r.number, url: r.url, installation: app.reports.code }
    },
  )

  tool(
    'telegram_list_chats',
    'List chats',
    'List the chats of a bot (most recent first): private chats with the people who started it, groups and channels it is in, with the last message and the bot\'s status there (member, administrator, left, kicked = blocked by the person). A bot sees only chats where something happened since it was linked.',
    'read',
    {
      bot,
      limit: z.number().int().min(1).max(200).optional().describe(L('Max chats (default 30)')),
      offset: z.number().int().min(0).optional().describe(L('Skip this many chats (paging)')),
      query: z.string().optional().describe(L('Filter by chat name or @username')),
      type: z.enum(['all', 'private', 'groups', 'channels']).optional().describe(L('Chat type: all, private, groups or channels')),
    },
    { readOnlyHint: true },
    async (a) => app.svc.listChats(acc(a.bot), { limit: a.limit, offset: a.offset, query: a.query, type: a.type }),
  )

  tool(
    'telegram_get_messages',
    'Read chat messages',
    'Get the messages of one chat that the bot or account received or sent, in chronological order (oldest → newest). Use before/after (ISO date) to page. For a Telegram account (kind user) the history is read from Telegram itself, older messages included. Voice messages (type voice, with seconds) carry their transcript when it is ready; when transcript is null, call telegram_transcribe_voice. Button presses appear as type button.',
    'read',
    {
      chat: chatArg,
      bot,
      limit: z.number().int().min(1).max(500).optional().describe(L('Max messages (default 30)')),
      before: z.string().optional().describe(L('Only messages before this ISO timestamp')),
      after: z.string().optional().describe(L('Only messages after this ISO timestamp')),
    },
    { readOnlyHint: true },
    async (a) => app.svc.getMessages(acc(a.bot), a.chat, { limit: a.limit, before: a.before, after: a.after }),
  )

  tool(
    'telegram_search_messages',
    'Search messages',
    'Full-text search across the stored messages of a bot or account (newest first), including what was said in transcribed voice messages. A Telegram account (kind user) also searches on Telegram itself: all its chats, all the history.',
    'read',
    {
      query: z.string().min(1).describe(L('Text to search for')),
      chat: z.string().optional().describe(L('Restrict to one chat (id, @username or name)')),
      since: z.string().optional().describe(L('ISO date lower bound')),
      limit: z.number().int().min(1).max(200).optional().describe(L('Max results (default 30)')),
      bot,
    },
    { readOnlyHint: true },
    async (a) => app.svc.searchMessages(acc(a.bot), a.query, { chat: a.chat, since: a.since, limit: a.limit }),
  )

  tool(
    'telegram_find_contact',
    'Find people and chats',
    'Find the people who wrote to a bot and the groups and channels it is in, by name, @username or id. Returns the chat ids to use with the other tools (a person\'s private chat has the same id as the person).',
    'read',
    { query: z.string().min(1).describe(L('Name, @username or id')), limit: z.number().int().min(1).max(100).optional().describe(L('Max results (default 20)')), bot },
    { readOnlyHint: true },
    async (a) => app.svc.findContacts(acc(a.bot), a.query, a.limit ?? 20),
  )

  tool(
    'telegram_get_chat',
    'Chat details',
    'A chat as Telegram describes it now: title, @username, description or bio, number of members, administrators, pinned message, and what the bot may do there (its status and rights).',
    'read',
    { chat: chatArg, bot },
    { readOnlyHint: true, openWorldHint: true },
    async (a) => app.svc.getChat(acc(a.bot), a.chat),
  )

  tool(
    'telegram_send_text',
    'Send text message',
    'Send a Telegram text message from a bot or a Telegram account. A bot can write only to people who started it and to groups and channels it is in; a Telegram account writes as that person, to anyone it could write to from the app (buttons are for bots only). Plain text longer than 4096 characters is split into several messages. Confirm recipient and text with the user first.',
    'send',
    {
      to: z.string().describe(L('Recipient: chat id, @username or exact chat name')),
      text: z.string().min(1).max(65000).describe(L('Message text')),
      parse_mode: parseMode,
      reply_to: z.string().optional().describe(L('Id of a message of the same chat to reply to')),
      buttons,
      silent: z.boolean().optional().describe(L('Deliver without sound')),
      link_preview: z.boolean().optional().describe(L('false = no preview of the first link')),
      thread_id: z.string().optional().describe(L('Forum topic (message thread) id')),
      idempotency_key: z.string().optional().describe(L('Same key = sent at most once')),
      bot,
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (a) =>
      app.svc.sendText(acc(a.bot), { to: a.to, text: a.text, parseMode: a.parse_mode, replyTo: a.reply_to, buttons: a.buttons, silent: a.silent, linkPreview: a.link_preview, threadId: a.thread_id, idempotencyKey: a.idempotency_key }),
  )

  tool(
    'telegram_send_media',
    'Send media',
    'Send a photo, video, audio, voice message, document, sticker, GIF (animation) or round video (video_note) from a public URL, base64 or the file_id of a file the bot already has. Up to 10 MB for photos and 50 MB for other files.',
    'send',
    {
      to: z.string().describe(L('Recipient: chat id, @username or exact chat name')),
      type: z.enum(['photo', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'animation', 'video_note']).describe(L('Media type')),
      url: z.string().optional().describe(L('http(s) URL of the file')),
      base64: z.string().optional().describe(L('File content as base64 (or data: URL)')),
      file_id: z.string().optional().describe(L('Telegram file_id of a file this bot already sent or received')),
      mimetype: z.string().optional().describe(L('MIME type, e.g. image/jpeg')),
      file_name: z.string().optional().describe(L('File name (documents)')),
      caption: z.string().max(1024).optional().describe(L('Caption')),
      parse_mode: parseMode,
      reply_to: z.string().optional().describe(L('Id of a message of the same chat to reply to')),
      buttons,
      silent: z.boolean().optional().describe(L('Deliver without sound')),
      thread_id: z.string().optional().describe(L('Forum topic (message thread) id')),
      idempotency_key: z.string().optional().describe(L('Same key = sent at most once')),
      bot,
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (a) =>
      app.svc.sendMedia(acc(a.bot), {
        to: a.to,
        type: a.type,
        url: a.url,
        base64: a.base64,
        fileId: a.file_id,
        mimetype: a.mimetype,
        fileName: a.file_name,
        caption: a.caption,
        parseMode: a.parse_mode,
        replyTo: a.reply_to,
        buttons: a.buttons,
        silent: a.silent,
        threadId: a.thread_id,
        idempotencyKey: a.idempotency_key,
      }),
  )

  tool(
    'telegram_send_location',
    'Send location',
    'Send a location pin; with name and address it is sent as a place (venue).',
    'send',
    {
      to: z.string().describe(L('Recipient: chat id, @username or exact chat name')),
      latitude: z.number().describe(L('Latitude')),
      longitude: z.number().describe(L('Longitude')),
      name: z.string().optional().describe(L('Place name')),
      address: z.string().optional().describe(L('Address')),
      bot,
    },
    { readOnlyHint: false, openWorldHint: true },
    async (a) => app.svc.sendLocation(acc(a.bot), { to: a.to, latitude: a.latitude, longitude: a.longitude, name: a.name, address: a.address }),
  )

  tool(
    'telegram_react',
    'React to message',
    'Put a reaction on a message: one emoji among the ones Telegram allows (👍 ❤ 🔥 🎉 👏 😁 🤔 👌 🙏 and others); an empty emoji removes the bot\'s reaction.',
    'send',
    { chat: chatArg, message_id: z.string().describe(L('Message id')), emoji: z.string().describe(L('e.g. 👍 — empty string removes')), bot },
    { readOnlyHint: false, openWorldHint: true },
    async (a) => app.svc.react(acc(a.bot), { chat: a.chat, messageId: a.message_id, emoji: a.emoji }),
  )

  tool(
    'telegram_edit_message',
    'Edit message',
    'Edit a message the bot sent: its text, or its caption for a media message, and its buttons.',
    'send',
    { chat: chatArg, message_id: z.string().describe(L('Message id')), text: z.string().min(1).describe(L('New text')), parse_mode: parseMode, buttons, bot },
    { readOnlyHint: false, openWorldHint: true },
    async (a) => app.svc.editMessage(acc(a.bot), { chat: a.chat, messageId: a.message_id, text: a.text, parseMode: a.parse_mode, buttons: a.buttons }),
  )

  tool(
    'telegram_delete_message',
    'Delete message',
    'Delete a message for everyone: the bot\'s own messages, messages in a private chat with the bot, and any message of a group where the bot is an administrator allowed to delete (Telegram: within 48 hours).',
    'send',
    { chat: chatArg, message_id: z.string().describe(L('Message id')), bot },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async (a) => app.svc.deleteMessage(acc(a.bot), { chat: a.chat, messageId: a.message_id }),
  )

  tool(
    'telegram_forward_message',
    'Forward message',
    'Forward a message to another chat (it shows where it comes from), or copy it (it looks like a new message of the bot).',
    'send',
    {
      from_chat: z.string().describe(L('Chat the message is in')),
      message_id: z.string().describe(L('Message id')),
      to: z.string().describe(L('Recipient: chat id, @username or exact chat name')),
      copy: z.boolean().optional().describe(L('true = copy without "forwarded from"')),
      silent: z.boolean().optional().describe(L('Deliver without sound')),
      bot,
    },
    { readOnlyHint: false, openWorldHint: true },
    async (a) => app.svc.forwardMessage(acc(a.bot), { from: a.from_chat, messageId: a.message_id, to: a.to, copy: a.copy, silent: a.silent }),
  )

  tool(
    'telegram_pin_message',
    'Pin message',
    'Pin a message in a chat, or unpin it (without message_id: the most recent pinned one). In groups the bot must be an administrator allowed to pin.',
    'send',
    { chat: chatArg, message_id: z.string().optional().describe(L('Message id')), unpin: z.boolean().optional().describe(L('true = unpin')), silent: z.boolean().optional().describe(L('Pin without notifying the members')), bot },
    { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    async (a) => app.svc.pinMessage(acc(a.bot), { chat: a.chat, messageId: a.message_id, unpin: a.unpin, silent: a.silent }),
  )

  tool(
    'telegram_invite_link',
    'Create an invite link',
    'Create a new invite link to a group or channel where the bot is an administrator with the right to invite users: optional name, expiry, member limit, or approval of each request.',
    'send',
    {
      chat: chatArg,
      name: z.string().max(32).optional().describe(L('Name of the link (only administrators see it)')),
      expire_hours: z.number().min(0.1).max(8760).optional().describe(L('Hours until the link expires')),
      member_limit: z.number().int().min(1).max(99999).optional().describe(L('How many people can join with it')),
      join_request: z.boolean().optional().describe(L('true = people ask to join and an administrator approves')),
      bot,
    },
    { readOnlyHint: false, openWorldHint: true },
    async (a) => app.svc.inviteLink(acc(a.bot), { chat: a.chat, name: a.name, expireHours: a.expire_hours, memberLimit: a.member_limit, joinRequest: a.join_request }),
  )

  tool(
    'telegram_download_media',
    'Download media',
    'Get the media of a message (Telegram lets bots download files up to 20 MB): returns a temporary download link (1 h) and, for small images, the image itself. For a voice or audio message it also returns what was said (transcript) and, with include_audio, the audio itself.',
    'read',
    {
      message_id: z.string().describe(L('Message id')),
      chat: z.string().optional().describe(L('Chat: chat id, @username or exact chat name')),
      include_audio: z.boolean().optional().describe(L('For voice / audio messages: also return the audio itself (only for clients that can play or process audio; default false)')),
      bot,
    },
    { readOnlyHint: true },
    async (a) => {
      const ac = acc(a.bot)
      const m = await app.svc.downloadMedia(ac, a.chat, a.message_id)
      const link = `${origin}/media/${app.svc.signMediaToken(ac.id, m.row.chat_id, a.message_id)}`
      const info: Record<string, unknown> = { fileName: m.fileName, mimetype: m.mimetype, bytes: m.buf.length, url: link, expiresIn: '1h' }
      if (m.row.type === 'voice' || m.row.type === 'audio' || m.row.type === 'video_note') {
        // an agent that cannot hear still gets what was said
        try {
          const t = await app.voice.transcribe(ac, m.row.chat_id, m.row.id)
          Object.assign(info, { transcript: t.text, language: t.language, seconds: t.seconds })
        } catch (e) {
          info.transcript = null
          info.transcriptError = e instanceof AppError ? localizeError(e, lang) : String((e as Error)?.message ?? e)
        }
      }
      const content: ToolResult['content'] = [{ type: 'text', text: JSON.stringify(info, null, 2) }]
      if (m.mimetype.startsWith('image/') && m.mimetype !== 'image/webp' && m.buf.length < 1_500_000) content.push({ type: 'image', data: m.buf.toString('base64'), mimeType: m.mimetype })
      if (a.include_audio && m.mimetype.startsWith('audio/') && m.buf.length < 8_000_000) content.push({ type: 'audio', data: m.buf.toString('base64'), mimeType: m.mimetype })
      return { content }
    },
  )

  tool(
    'telegram_transcribe_voice',
    'Listen to a voice message',
    'Transcribe a Telegram voice message, audio file or round video (type voice, audio or video_note) to text, so you know what was said. Returns the transcript, the language and the length in seconds. Transcripts are kept: asking again is instant. Use force to transcribe again.',
    'read',
    {
      message_id: z.string().describe(L('Message id')),
      chat: z.string().optional().describe(L('Chat: chat id, @username or exact chat name')),
      force: z.boolean().optional().describe(L('Transcribe again even if a transcript is already stored')),
      bot,
    },
    { readOnlyHint: true, openWorldHint: true },
    async (a) => {
      const t = await app.voice.transcribe(acc(a.bot), a.chat, a.message_id, { force: a.force })
      return { messageId: t.id, chat: t.chat, transcript: t.text, language: t.language, seconds: t.seconds, engine: t.engine, cached: t.cached }
    },
  )

  return server
}

/** Stateless Streamable HTTP endpoint (POST /mcp and POST /). */
export async function handleMcpRequest(app: App, req: FastifyRequest, reply: FastifyReply, path: string): Promise<unknown> {
  const lang = reqLang(req)
  const p = await authenticate(app, req, false)
  if (!p) {
    return reply
      .code(401)
      .header('www-authenticate', app.oauth.wwwAuthenticate(req, path))
      .header('access-control-expose-headers', 'WWW-Authenticate')
      .header('cache-control', 'no-store')
      .send({ jsonrpc: '2.0', error: { code: -32001, message: tr(lang, 'Unauthorized: sign in with OAuth or send Authorization: Bearer <API key>') }, id: null })
  }
  if (req.method !== 'POST') {
    return reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: tr(lang, 'Method not allowed (stateless server: use POST)') }, id: null })
  }
  const origin = publicOrigin(req, app.settings.get().publicUrl)
  const server = buildMcpServer(app, p, origin, lang)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  try {
    await server.connect(transport)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || k === 'content-length' || k === 'transfer-encoding') continue
      headers.set(k, Array.isArray(v) ? v.join(', ') : String(v))
    }
    // be lenient with clients that send only one of the two required Accept types
    headers.set('accept', 'application/json, text/event-stream')
    headers.set('content-type', 'application/json')
    const request = new Request(`${origin}${req.url}`, { method: 'POST', headers, body: JSON.stringify(req.body ?? {}) })
    const res = await transport.handleRequest(request, { parsedBody: req.body })
    reply.code(res.status)
    res.headers.forEach((v, k) => {
      if (k !== 'content-length') reply.header(k, v)
    })
    return reply.send(await res.text())
  } finally {
    void transport.close().catch(() => undefined)
    void server.close().catch(() => undefined)
  }
}
