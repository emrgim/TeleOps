/**
 * Bilingual (English / Italian) strings for everything the server says:
 * MCP tool titles & descriptions, error messages, login/consent pages, the Telegram login code.
 *
 * Keys are the English source strings (gettext style); keys starting with "@" are long texts.
 * Language resolution:
 *   - server default: settings.language ('auto' | 'en' | 'it'); 'auto' = TELEOPS_LANG env, else the OS locale
 *   - per request: ?lang= (API clients) > Accept-Language > server default — no manual switch in the UI
 */
import type { FastifyRequest } from 'fastify'
import { AppError, fmt } from './util.js'

export type Lang = 'en' | 'it'
export const LANGS: Lang[] = ['en', 'it']

export function normLang(v?: string | null): Lang | null {
  if (!v) return null
  const l = String(v).toLowerCase().trim()
  if (l.startsWith('it')) return 'it'
  if (l.startsWith('en')) return 'en'
  return null
}

/** Language of the operating system the server runs on. */
export function osLang(): Lang {
  const env = process.env
  for (const v of [env.TELEOPS_LANG, env.LC_ALL, env.LC_MESSAGES, (env.LANGUAGE ?? '').split(':')[0], env.LANG]) {
    if (!v || v === 'C' || v.startsWith('C.') || v === 'POSIX') continue
    const l = normLang(v)
    if (l) return l
  }
  try {
    return normLang(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'en'
  } catch {
    return 'en'
  }
}

let serverDefault: Lang = osLang()

export function setServerLanguage(setting: string | undefined): Lang {
  serverDefault = normLang(setting) ?? osLang()
  return serverDefault
}

export function defaultLang(): Lang {
  return serverDefault
}

export function fromAcceptLanguage(h?: string | string[] | null): Lang | null {
  if (!h) return null
  const items = String(Array.isArray(h) ? h.join(',') : h)
    .split(',')
    .map((p) => {
      const [tag, ...rest] = p.trim().split(';')
      const q = rest.find((r) => r.trim().startsWith('q='))
      return { tag, q: q ? Number(q.trim().slice(2)) || 0 : 1 }
    })
    .filter((x) => x.tag && x.tag !== '*' && x.q > 0)
    .sort((a, b) => b.q - a.q)
  for (const it of items) {
    const l = normLang(it.tag)
    if (l) return l
  }
  return null
}

export function reqLang(req: FastifyRequest): Lang {
  const q = (req.query ?? {}) as Record<string, unknown>
  return (
    normLang(typeof q.lang === 'string' ? q.lang : null) ??
    fromAcceptLanguage(req.headers['accept-language']) ??
    serverDefault
  )
}

export function tr(lang: Lang, s: string, params: unknown[] = []): string {
  const dict = lang === 'it' ? IT : EN
  const t = dict[s] ?? EN[s] ?? s
  return fmt(t, params)
}

export function localizeError(e: AppError, lang: Lang): string {
  return tr(lang, e.template, e.params)
}

// ---------------------------------------------------------------------------
// English long texts
// ---------------------------------------------------------------------------
const EN: Record<string, string> = {
  '@instructions': `Telegram bots and Telegram accounts of the owner: each one reads and sends its own messages.
- A bot can write only to people who pressed Start in its chat and to the groups and channels it is in; it cannot write first to anyone else.
- Chats accept a chat id (123456789, -1001234567890), an @username or an exact chat name; find people and chats with telegram_find_contact.
- A bot sees only what happened since it was linked: telegram_list_chats and telegram_get_messages read what TeleOps stored, not older Telegram history.
- In groups, a bot with privacy mode on gets only commands, replies to its messages and mentions (telegram_bots → readsAllGroupMessages).
- Messages go out as the bot: confirm wording and recipient with the user before calling a send tool unless they explicitly asked you to send.
- Buttons under a message: a press comes back as a [button] message in the chat and as the button.pressed event.
- Use telegram_bots to see the bots; pass "bot" (id or @username) to use one that is not the default.
- Telegram accounts of people (telegram_bots → kind user) use the same tools: they read the whole history of their chats from Telegram and write as that person, to anyone the app could; they cannot send buttons. Treat their chats as private.
- Tools named <plugin>_<tool> come from plugins the owner installed: their description says what they do.
- Voice messages (type voice, audio or video_note): read their transcript, or call telegram_transcribe_voice to know what was said.
- Every tool explained, with examples (Agent Skill): https://raw.githubusercontent.com/emrgim/TeleOps/main/skills/teleops/SKILL.md
- Reply to the user in their language.`,
  '@otp': '🔐 TeleOps login code: <code>{0}</code>\nValid for 5 minutes. If you did not ask for it, ignore this message.',
  '@owner_linked': '✅ Done: TeleOps login codes will come here, from {0}.',
  '@owner_link_expired': 'This link has expired or was already used. Make a new one in TeleOps → Settings → General.',
  '@login_hint':
    'First access, or your Telegram not linked yet? Ask your agent for a <i>login link</i> (valid 30 minutes) or run <code>teleops login-link</code> on the server.',
}

// ---------------------------------------------------------------------------
// Italian
// ---------------------------------------------------------------------------
const IT: Record<string, string> = {
  '@instructions': `Bot e account Telegram del proprietario: ognuno legge e invia i propri messaggi.
- Un bot può scrivere solo alle persone che hanno premuto Avvia nella sua chat e ai gruppi e canali in cui si trova; non può scrivere per primo a nessun altro.
- Le chat accettano un id (123456789, -1001234567890), uno @username o il nome esatto della chat; trova persone e chat con telegram_find_contact.
- Un bot vede solo ciò che è successo da quando è collegato: telegram_list_chats e telegram_get_messages leggono quello che TeleOps ha salvato, non la cronologia Telegram precedente.
- Nei gruppi un bot con la privacy attiva riceve solo i comandi, le risposte ai suoi messaggi e le menzioni (telegram_bots → readsAllGroupMessages).
- I messaggi partono come il bot: conferma testo e destinatario con l'utente prima di usare uno strumento di invio, salvo che te l'abbia chiesto esplicitamente.
- Pulsanti sotto un messaggio: quando vengono premuti tornano come messaggio [button] nella chat e come evento button.pressed.
- telegram_bots mostra i bot; passa "bot" (id o @username) per usarne uno diverso da quello predefinito.
- Gli account Telegram delle persone (telegram_bots → kind user) usano gli stessi strumenti: leggono da Telegram tutta la cronologia delle loro chat e scrivono come quella persona, a chiunque potrebbe scrivere dall'app; non possono inviare pulsanti. Tratta le loro chat come private.
- Gli strumenti chiamati <plugin>_<strumento> vengono dai plugin installati dal proprietario: la loro descrizione dice cosa fanno.
- Messaggi vocali (tipo voice, audio o video_note): leggi la trascrizione, oppure usa telegram_transcribe_voice per sapere cosa è stato detto.
- Tutti gli strumenti spiegati, con esempi (Agent Skill): https://raw.githubusercontent.com/emrgim/TeleOps/main/skills/teleops/SKILL.md
- Rispondi all'utente nella sua lingua.`,
  '@otp': '🔐 Codice di accesso TeleOps: <code>{0}</code>\nValido 5 minuti. Se non l’hai chiesto tu, ignora questo messaggio.',
  '@owner_linked': '✅ Fatto: i codici di accesso di TeleOps arriveranno qui, da {0}.',
  '@owner_link_expired': 'Questo link è scaduto o è già stato usato. Creane uno nuovo in TeleOps → Impostazioni → Generale.',
  '@login_hint':
    'Primo accesso o Telegram non ancora collegato? Chiedi al tuo agente un <i>link di accesso</i> (valido 30 minuti) oppure esegui <code>teleops login-link</code> sul server.',

  // ---- server / MCP
  'Unauthorized: sign in with OAuth or send Authorization: Bearer <API key>': 'Non autorizzato: accedi con OAuth oppure invia Authorization: Bearer <chiave API>',
  'Method not allowed (stateless server: use POST)': 'Metodo non consentito (server stateless: usa POST)',
  'List chats': 'Elenca chat',
  'Max chats (default 30)': 'Numero massimo di chat (predefinito 30)',
  'Skip this many chats (paging)': 'Salta questo numero di chat (paginazione)',
  'Only chats with unread messages': 'Solo chat con messaggi non letti',
  'Filter by chat name': 'Filtra per nome della chat',
  'Read chat messages': 'Leggi messaggi della chat',
  'Get messages of one chat in chronological order (oldest → newest). Use before/after (ISO date) to page.':
    'Messaggi di una chat in ordine cronologico (dal più vecchio al più recente). Usa before/after (data ISO) per scorrere.',
  'Max messages (default 30)': 'Numero massimo di messaggi (predefinito 30)',
  'Only messages before this ISO timestamp': 'Solo messaggi precedenti a questa data ISO',
  'Only messages after this ISO timestamp': 'Solo messaggi successivi a questa data ISO',
  'Search messages': 'Cerca messaggi',
  'Text to search for': 'Testo da cercare',
  'ISO date lower bound': 'Data ISO minima',
  'Max results (default 30)': 'Numero massimo di risultati (predefinito 30)',
  'Max results (default 20)': 'Numero massimo di risultati (predefinito 20)',
  'Send text message': 'Invia messaggio di testo',
  'Message text': 'Testo del messaggio',
  'Message id to quote': 'Id del messaggio da citare',
  'Same key = sent at most once': 'Stessa chiave = inviato al massimo una volta',
  'Send media': 'Invia media',
  'since must be an ISO date': 'since deve essere una data ISO',
  'Send an image, video, audio/voice note, document or sticker from a public URL or base64.': 'Invia immagine, video, audio/vocale, documento o sticker da un URL pubblico o in base64.',
  'Media type': 'Tipo di media',
  'http(s) URL of the file': 'URL http(s) del file',
  'File content as base64 (or data: URL)': 'Contenuto del file in base64 (o data: URL)',
  'MIME type, e.g. image/jpeg': 'Tipo MIME, es. image/jpeg',
  'File name (documents)': 'Nome del file (documenti)',
  Caption: 'Didascalia',
  'Send audio as a voice note': 'Invia l’audio come messaggio vocale',
  'Send location': 'Invia posizione',
  'Send a location pin.': 'Invia una posizione sulla mappa.',
  Latitude: 'Latitudine',
  Longitude: 'Longitudine',
  'Place name': 'Nome del luogo',
  Address: 'Indirizzo',
  'React to message': 'Reagisci al messaggio',
  'React to a message with an emoji (empty emoji removes the reaction).': 'Reagisci a un messaggio con un’emoji (emoji vuota = rimuove la reazione).',
  'Message id': 'Id del messaggio',
  'e.g. 👍 — empty string removes': 'es. 👍 — stringa vuota per rimuovere',
  'Mark as read': 'Segna come letto',
  'Mark a chat (or specific messages) as read — sends blue ticks.': 'Segna come letta una chat (o messaggi specifici): invia le spunte blu.',
  'Message ids (default: latest received)': 'Id dei messaggi (predefinito: gli ultimi ricevuti)',
  'Edit message': 'Modifica messaggio',
  'New text': 'Nuovo testo',
  'Delete message for everyone': 'Elimina messaggio per tutti',
  'Delete (revoke) a message for everyone.': 'Elimina (revoca) un messaggio per tutti.',
  'Download media': 'Scarica media',
  'Get the media of a message: returns a temporary download link (1 h) and, for small images, the image itself.':
    'Ottieni il media di un messaggio: restituisce un link temporaneo (1 ora) e, per le immagini piccole, l’immagine stessa.',

  // ---- pages
  'Sign in · TeleOps': 'Accesso · TeleOps',
  'Sign in': 'Entra',
  'Admin password': 'Password amministratore',
  'Sign in with password': 'Entra con password',
  'Code sent to {0} · resend': 'Codice inviato a {0} · reinvia',
  'Authorize · TeleOps': 'Autorizza · TeleOps',
  'Send messages, media and reactions on your behalf': 'Inviare messaggi, media e reazioni a tuo nome',
  'Sign in as the owner first.': 'Prima accedi come proprietario.',
  'After authorizing you will be sent back to <b>{0}</b>. You can revoke access at any time from the config page → Connectors.':
    'Dopo l’autorizzazione verrai rimandato a <b>{0}</b>. Puoi revocare l’accesso in qualsiasi momento dalla pagina di configurazione → Connettori.',
  Deny: 'Rifiuta',
  Authorize: 'Autorizza',
  'Authorization · TeleOps': 'Autorizzazione · TeleOps',
  'Incomplete authorization URL.': 'URL di autorizzazione incompleta.',
  'client_id, redirect_uri or code_challenge (PKCE) is missing. Start the connection from your MCP client (Cursor, Claude, Grok…) using the server address:':
    'Mancano client_id, redirect_uri o code_challenge (PKCE). Avvia la connessione dal client MCP (Cursor, Claude, Grok…) usando l’indirizzo del server:',
  'For clients without OAuth, create an API key on the config page.': 'Per i client senza OAuth crea una chiave API nella pagina di configurazione.',
  'Open config page': 'Apri configurazione',
  Continue: 'Continua',
  'Invalid link': 'Link non valido',
  'Login link expired or already used. Ask for a new one.': 'Link di accesso scaduto o già usato. Chiedine uno nuovo.',
  'Sign in to the TeleOps config first': 'Accedi prima alla configurazione di TeleOps',
  'The owner denied access': 'Il proprietario ha negato l’accesso',
  'Unknown client_id "{0}". Register the client (dynamic registration) or use a known id such as "grok".':
    'client_id "{0}" sconosciuto. Registra il client (registrazione dinamica) o usa un id noto come "grok".',
  'redirect_uri missing or not registered for this client': 'redirect_uri mancante o non registrato per questo client',

  // ---- errors
  'Recipient is empty': 'Destinatario vuoto',
  'This credential lacks the "{0}" scope': 'Questa credenziale non ha il permesso "{0}"',
  'Missing or invalid credentials (Bearer API key, OAuth token or admin session)': 'Credenziali mancanti o non valide (chiave API Bearer, token OAuth o sessione amministratore)',
  'Too many codes requested, wait a few minutes': 'Troppi codici richiesti, attendi qualche minuto',
  'Wrong or expired code': 'Codice errato o scaduto',
  'Wrong password': 'Password errata',
  'Connection failed: {0}': 'Connessione non riuscita: {0}',
  'TELEOPS_DB_URL is set in the service environment; remove it to manage the database from here': 'TELEOPS_DB_URL è impostata nell’ambiente del servizio: rimuovila per gestire il database da qui',
  'Switch aborted, still on the current database: {0}': 'Spostamento annullato, il database attuale resta in uso: {0}',
  'webhook not found': 'webhook non trovato',
  '{0} not found': '{0} non trovato',
  'chat/recipient is required': 'chat/destinatario obbligatorio',
  'Sending to {0} is blocked by the send allowlist (config page → Settings).': 'L’invio a {0} è bloccato dall’elenco dei destinatari consentiti (configurazione → Impostazioni).',
  'A send with this idempotency key is still in progress': 'Un invio con questa chiave di idempotenza è ancora in corso',
  'Message {0} not found in {1}': 'Messaggio {0} non trovato in {1}',
  'text is required': 'il testo è obbligatorio',
  'media url is not a valid URL': 'l’URL del media non è valido',
  'Only http(s) media URLs are allowed': 'Sono ammessi solo URL http(s)',
  'Fetching media failed: HTTP {0}': 'Download del media non riuscito: HTTP {0}',
  'Media larger than {0} MB': 'Media più grande di {0} MB',
  'media too large': 'media troppo grande',
  'Provide url or base64': 'Fornisci url o base64',
  'media is empty': 'il media è vuoto',
  'Only your own messages can be deleted for everyone': 'Puoi eliminare per tutti solo i tuoi messaggi',
  'Message {0} not found': 'Messaggio {0} non trovato',
  'This message has no media': 'Questo messaggio non contiene media',
  'media larger than the configured cap': 'media più grande del limite configurato',
  'Media download failed: {0}': 'Download del media non riuscito: {0}',
  'invalid media link': 'link al media non valido',
  'media link expired': 'link al media scaduto',
  'Too many failed attempts, try again in a few minutes': 'Troppi tentativi falliti, riprova fra qualche minuto',
  'Password must be at least 10 characters': 'La password deve avere almeno 10 caratteri',
  'At least one scope (read, send, admin) is required': 'Serve almeno un permesso (read, send, admin)',
  'Internal error': 'Errore interno',
  '{0} {1} not found': '{0} {1} non trovato',
  'Send feedback about TeleOps': 'Invia un feedback su TeleOps',
  'bug = something does not work, idea = a request or an improvement, other = anything else': 'bug = qualcosa non funziona, idea = una richiesta o un miglioramento, other = altro',
  'Short title (3–120 characters)': 'Titolo breve (3–120 caratteri)',
  'What happened or what you would like, in detail': 'Cosa è successo o cosa vorresti, nel dettaglio',
  'The title must be 3–120 characters': 'Il titolo deve avere 3–120 caratteri',
  'The message must be 5–8000 characters': 'Il messaggio deve avere 5–8000 caratteri',
  'Too many reports from this installation, try again later': 'Troppe segnalazioni da questa installazione, riprova più tardi',
  'GitHub cannot be reached right now, try again later': 'GitHub non è raggiungibile in questo momento, riprova più tardi',
  'GitHub did not accept the report ({0})': 'GitHub non ha accettato la segnalazione ({0})',
  'Report not found': 'Segnalazione non trovata',
  'An update is already running': 'C\'è già un aggiornamento in corso',
  'This installation was not made with git clone: update it by hand': 'Questa installazione non è stata fatta con git clone: aggiornala a mano',
  'Already up to date': 'È già aggiornato',
  'This installation has local changes to its files: update skipped': 'Questa installazione ha modifiche locali ai suoi file: aggiornamento saltato',
  'The update failed; the previous version is still installed': 'L\'aggiornamento non è riuscito; resta installata la versione precedente',
  'Also return the profile photo as an image (default false)': 'Restituisci anche la foto profilo come immagine (predefinito false)',
  'New profile name': 'Nuovo nome del profilo',
  'New info/about text (empty string clears it)': 'Nuovo testo info (stringa vuota per toglierlo)',
  'New profile photo: http(s) image URL, data: URL or base64': 'Nuova foto profilo: URL http(s) di un\'immagine, data: URL o base64',
  'Remove the profile photo': 'Togli la foto profilo',
  'Nothing to change: give a name, an info text or a photo': 'Niente da cambiare: indica un nome, un testo info o una foto',
  'The name must be 1–25 characters': 'Il nome deve avere 1–25 caratteri',
  'The info must be at most 139 characters': 'L\'info può avere al massimo 139 caratteri',
  'Send the photo as url or base64': 'Invia la foto come url o base64',
  'The license service cannot be reached right now, try again later': 'Il servizio licenze non è raggiungibile in questo momento, riprova più tardi',
  'Licenses are not enabled: TeleOps is free': 'Le licenze non sono attive: TeleOps è gratuito',
  'This license key is not valid': 'Questa chiave di licenza non è valida',
  'true = sync on, false = sync off': 'true = sincronizzazione accesa, false = spenta',
  'The name is required': 'Il nome è obbligatorio',
  'If {0} is enabled, the code is on its way · resend': 'Se {0} è abilitato, il codice sta arrivando · rimanda',
  'Hi {0}': 'Ciao {0}',
  'Confirm': 'Conferma',
  'Done: {0} is registered.': 'Fatto: {0} è registrato.',
  'Open TeleOps': 'Apri TeleOps',
  'You are not allowed to do this': 'Non hai il permesso di farlo',
  'This link is not valid or has expired. Ask for a new one.': 'Questo link non è valido o è scaduto. Chiedine uno nuovo.',
  'Choose 2, 5, 15 or 30 minutes': 'Scegli 2, 5, 15 o 30 minuti',
  'Version {0} for this system is not published yet: trying again later': 'La versione {0} per questo sistema non è ancora pubblicata: riprovo più tardi',
  'The country calling code has 1 to 4 digits (e.g. 39, 31, 971)': 'Il prefisso internazionale ha da 1 a 4 cifre (es. 39, 31, 971)',
  // voice messages
  'Listen to a voice message': 'Ascolta un messaggio vocale',
  'Transcribe again even if a transcript is already stored': 'Trascrivi di nuovo anche se la trascrizione è già salvata',
  'For voice / audio messages: also return the audio itself (only for clients that can play or process audio; default false)': 'Per i messaggi vocali / audio: restituisci anche l\'audio (solo per i client che sanno riprodurlo o elaborarlo; predefinito false)',
  'Get the media of a message: returns a temporary download link (1 h) and, for small images, the image itself. For a voice or audio message it also returns what was said (transcript) and, with include_audio, the audio itself.': 'Ottieni il media di un messaggio: restituisce un link di download temporaneo (1 h) e, per le immagini piccole, l\'immagine stessa. Per un messaggio vocale o audio restituisce anche cosa è stato detto (trascrizione) e, con include_audio, l\'audio stesso.',
  'Voice transcription is off: choose an engine in Settings → Voice': 'La trascrizione dei vocali è spenta: scegli un motore in Impostazioni → Voce',
  'faster-whisper is not installed on this server: Settings → Voice → Install faster-whisper': 'faster-whisper non è installato sul server: Impostazioni → Voce → Installa faster-whisper',
  'faster-whisper has no ready-made package for this system ({0})': 'faster-whisper non ha un pacchetto pronto per questo sistema ({0})',
  'faster-whisper could not be installed ({0}): {1}': 'Non sono riuscito a installare faster-whisper ({0}): {1}',
  // backup
  'Not a TeleOps backup file': 'Non è un file di backup di TeleOps',
  'This backup is protected by a password: write it to restore': 'Questo backup è protetto da password: scrivila per ripristinarlo',
  'Wrong password, or the file is damaged': 'Password sbagliata, oppure il file è rovinato',
  'The backup file is damaged': 'Il file di backup è rovinato',
  'Choose off, every hour, every day or every week': 'Scegli spento, ogni ora, ogni giorno o ogni settimana',
  'The folder must be a full path (e.g. {0})': 'La cartella deve essere un percorso completo (per esempio {0})',
  'The backup password needs at least 6 characters': 'La password dei backup deve avere almeno 6 caratteri',
  'A backup or a restore is already running': 'C\'è già un backup o un ripristino in corso',
  'Backup not found': 'Backup non trovato',
  'The file is too big': 'Il file è troppo grande',
  'Cannot write in the folder {0}: {1}': 'Non riesco a scrivere nella cartella {0}: {1}',
  'Folder not found: {0}': 'Cartella non trovata: {0}',
  'Not a valid folder name': 'Nome di cartella non valido',
  'Transcription failed: {0}': 'Trascrizione non riuscita: {0}',
  'Transcription took too long': 'La trascrizione ha impiegato troppo tempo',
  'This message is not a voice or audio message': 'Questo messaggio non è un vocale né un audio',
  'Unknown transcription engine': 'Motore di trascrizione sconosciuto',
  'Not a valid model name': 'Nome del modello non valido',
  'Unknown transcription service': 'Servizio di trascrizione sconosciuto',
  'The service address must start with https://': 'L\'indirizzo del servizio deve iniziare con https://',
  'Language: auto or a two-letter code (it, en, …)': 'Lingua: auto oppure un codice di due lettere (it, en, …)',
  'Write the command that transcribes the file ({file})': 'Scrivi il comando che trascrive il file ({file})',
  'The command must contain {file} where the audio file goes': 'Il comando deve contenere {file} dove va il file audio',
  'Write the address of the transcription service': 'Scrivi l\'indirizzo del servizio di trascrizione',
  'Paste the API key of the transcription service': 'Incolla la chiave API del servizio di trascrizione',
  'Not a valid header name: {0}': 'Nome di header non valido: {0}',
  'TeleOps sets the header {0} itself': 'L\'header {0} lo imposta TeleOps',
  'The value of the header {0} is empty or not valid': 'Il valore dell\'header {0} è vuoto o non valido',
  'Paste the key, or the header as "Name: value" (one per line)': 'Incolla la chiave, oppure l\'header come "Nome: valore" (uno per riga)',
  'At most 10 extra headers': 'Al massimo 10 header aggiuntivi',
  'Duration in seconds: 0 = off, 86400 = 24 hours, 604800 = 7 days, 7776000 = 90 days': 'Durata in secondi: 0 = disattivati, 86400 = 24 ore, 604800 = 7 giorni, 7776000 = 90 giorni',
  'seconds must be a non-negative integer (0 = off, 86400 = 24 hours, 604800 = 7 days, 7776000 = 90 days)': 'seconds deve essere un intero non negativo (0 = disattivati, 86400 = 24 ore, 604800 = 7 giorni, 7776000 = 90 giorni)',
  'Created by {0}': 'Creato da {0}',
  'Name: {0} → {1}': 'Nome: {0} → {1}',
  'Dates: {0} → {1}': 'Date: {0} → {1}',
  'Location: {0} → {1}': 'Location: {0} → {1}',
  'update': 'aggiornamento',
  'General': 'Generale',
  // ---- Telegram
  'Telegram login codes are disabled': 'L’accesso con codice su Telegram è disattivato',
  'This bot has no profile photo': 'Questo bot non ha una foto profilo',
  'This credential cannot use bot "{0}"': 'Questa credenziale non può usare il bot "{0}"',
  'Nothing to change: give a name, a description, commands or a photo': 'Niente da cambiare: indica un nome, una descrizione, dei comandi o una foto',
  'Read and send Telegram messages through your own bots and Telegram accounts.': 'Leggi e invia messaggi Telegram con i tuoi bot e i tuoi account Telegram.',
  'Bot or Telegram account to use: its id or @username. Omit for the default one (see telegram_bots).': 'Bot o account Telegram da usare: id o @username. Ometti per quello predefinito (vedi telegram_bots).',
  'Chat: chat id, @username or exact chat name': 'Chat: id della chat, @username o nome esatto della chat',
  'Text on the button': 'Testo sul pulsante',
  'Link the button opens (https://…)': 'Link che il pulsante apre (https://…)',
  'Data sent back as the event button.pressed when the button is pressed (default: the text)': 'Dati restituiti con l’evento button.pressed quando il pulsante viene premuto (predefinito: il testo)',
  'Buttons under the message: each item is a row (one button, or a list of buttons side by side). A button with url opens the link; the others come back as button.pressed (webhook, events) and as a [button] message in the chat.': 'Pulsanti sotto il messaggio: ogni elemento è una riga (un pulsante, o una lista di pulsanti affiancati). Un pulsante con url apre il link; gli altri tornano come button.pressed (webhook, eventi) e come messaggio [button] nella chat.',
  'Formatting of the text: HTML or MarkdownV2 (Telegram rules, escape special characters); omit for plain text': 'Formattazione del testo: HTML o MarkdownV2 (regole di Telegram, i caratteri speciali vanno protetti); ometti per il testo semplice',
  'New name': 'Nuovo nome',
  'New short description (empty string clears it)': 'Nuova descrizione breve (stringa vuota per toglierla)',
  'New description (empty string clears it)': 'Nuova descrizione (stringa vuota per toglierla)',
  'The command menu: the whole list (empty list removes it), e.g. [{"command":"help","description":"What I can do"}]': 'Il menu dei comandi: la lista completa (lista vuota per toglierlo), es. [{"command":"help","description":"Cosa so fare"}]',
  'true = the bot reads every message of its groups (privacy mode off); false = only commands, replies to it and mentions': 'true = il bot legge tutti i messaggi dei suoi gruppi (privacy disattivata); false = solo comandi, risposte ai suoi messaggi e menzioni',
  'Attach technical info: TeleOps version, operating system, database type, how many bots are linked (no names, no messages). Default true.': 'Allega le info tecniche: versione di TeleOps, sistema operativo, tipo di database, quanti bot sono collegati (niente nomi né messaggi). Predefinito true.',
  'Filter by chat name or @username': 'Filtra per nome della chat o @username',
  'Chat type: all, private, groups or channels': 'Tipo di chat: all (tutte), private (private), groups (gruppi) o channels (canali)',
  'Restrict to one chat (id, @username or name)': 'Limita a una chat (id, @username o nome)',
  'Name, @username or id': 'Nome, @username o id',
  'Recipient: chat id, @username or exact chat name': 'Destinatario: id della chat, @username o nome esatto della chat',
  'Id of a message of the same chat to reply to': 'Id di un messaggio della stessa chat a cui rispondere',
  'Deliver without sound': 'Consegna senza suono',
  'false = no preview of the first link': 'false = nessuna anteprima del primo link',
  'Forum topic (message thread) id': 'Id dell’argomento del forum (thread)',
  'Telegram file_id of a file this bot already sent or received': 'file_id Telegram di un file che questo bot ha già inviato o ricevuto',
  'Chat the message is in': 'Chat in cui si trova il messaggio',
  'true = copy without "forwarded from"': 'true = copia senza "inoltrato da"',
  'true = unpin': 'true = sblocca',
  'Pin without notifying the members': 'Fissa senza avvisare i membri',
  'Name of the link (only administrators see it)': 'Nome del link (lo vedono solo gli amministratori)',
  'Hours until the link expires': 'Ore prima che il link scada',
  'How many people can join with it': 'Quante persone possono entrare con il link',
  'true = people ask to join and an administrator approves': 'true = le persone chiedono di entrare e un amministratore approva',
  'List bots and accounts': 'Elenca bot e account',
  'List the Telegram bots and user accounts linked to this server: kind (bot or user), name, @username, link, connection state, the default one, whether a bot reads all group messages (privacy mode off).': 'Elenca i bot e gli account Telegram collegati a questo server: tipo (bot o user), nome, @username, link, stato della connessione, quello predefinito, se un bot legge tutti i messaggi dei gruppi (privacy disattivata).',
  'Get a bot\'s profile': 'Profilo di un bot',
  'Read the profile of one of the bots: name, @username, short description (about), description (shown in an empty chat), commands, profile photo, privacy mode.': 'Legge il profilo di uno dei bot: nome, @username, descrizione breve (about), descrizione (mostrata in una chat vuota), comandi, foto profilo, privacy.',
  'Edit a bot\'s profile': 'Modifica il profilo di un bot',
  'Change one of the bots ON TELEGRAM ITSELF (everyone sees it): name (1–64 characters, also its name in TeleOps), short description (about, max 120), description (max 512, shown in an empty chat), commands (the / menu), profile photo (http(s) image URL, data: URL or base64) or remove it, and privacy mode (read all group messages or only commands and replies). Confirm the change with the user first.': 'Cambia uno dei bot DIRETTAMENTE SU TELEGRAM (lo vedono tutti): nome (1–64 caratteri, è anche il suo nome in TeleOps), descrizione breve (about, max 120), descrizione (max 512, mostrata in una chat vuota), comandi (il menu /), foto profilo (URL http(s) di un’immagine, data: URL o base64) o la toglie, e privacy (leggere tutti i messaggi dei gruppi o solo comandi e risposte). Conferma prima la modifica con l’utente.',
  'Send feedback about TeleOps itself (a bug, an idea, anything else) to its developers. It opens an issue in the GitHub repository of TeleOps, signed only with this installation code: never put names, chat ids, message contents or keys in it. Show the text to the user and get their OK before sending.': 'Invia agli sviluppatori un feedback su TeleOps (un problema, un’idea, altro). Apre una issue nella repository GitHub di TeleOps, firmata solo con il codice di questa installazione: non metterci mai nomi, id di chat, contenuti di messaggi o chiavi. Mostra il testo all’utente e ottieni il suo ok prima di inviarlo.',
  'List the chats of a bot (most recent first): private chats with the people who started it, groups and channels it is in, with the last message and the bot\'s status there (member, administrator, left, kicked = blocked by the person). A bot sees only chats where something happened since it was linked.': 'Elenca le chat di un bot (dalla più recente): le chat private con le persone che l’hanno avviato, i gruppi e i canali in cui si trova, con l’ultimo messaggio e lo stato del bot lì (member, administrator, left, kicked = bloccato dalla persona). Un bot vede solo le chat in cui è successo qualcosa da quando è collegato.',
  'Get the messages of one chat that the bot or account received or sent, in chronological order (oldest → newest). Use before/after (ISO date) to page. For a Telegram account (kind user) the history is read from Telegram itself, older messages included. Voice messages (type voice, with seconds) carry their transcript when it is ready; when transcript is null, call telegram_transcribe_voice. Button presses appear as type button.': 'Messaggi di una chat ricevuti o inviati dal bot o dall\'account, in ordine cronologico (dal più vecchio al più recente). Usa before/after (data ISO) per scorrere. Per un account Telegram (kind user) la cronologia viene letta da Telegram stesso, anche i messaggi più vecchi. I messaggi vocali (tipo voice, con seconds) portano la trascrizione quando è pronta; se transcript è null, usa telegram_transcribe_voice. I pulsanti premuti compaiono come tipo button.',
  'Full-text search across the stored messages of a bot or account (newest first), including what was said in transcribed voice messages. A Telegram account (kind user) also searches on Telegram itself: all its chats, all the history.': 'Ricerca testuale nei messaggi salvati di un bot o account (dal più recente), compreso ciò che è stato detto nei vocali trascritti. Un account Telegram (kind user) cerca anche su Telegram stesso: tutte le sue chat, tutta la cronologia.',
  'Find people and chats': 'Trova persone e chat',
  'Find the people who wrote to a bot and the groups and channels it is in, by name, @username or id. Returns the chat ids to use with the other tools (a person\'s private chat has the same id as the person).': 'Trova le persone che hanno scritto a un bot e i gruppi e canali in cui si trova, per nome, @username o id. Restituisce gli id delle chat da usare con gli altri strumenti (la chat privata con una persona ha lo stesso id della persona).',
  'Chat details': 'Dettagli della chat',
  'A chat as Telegram describes it now: title, @username, description or bio, number of members, administrators, pinned message, and what the bot may do there (its status and rights).': 'Una chat come la descrive adesso Telegram: titolo, @username, descrizione o bio, numero di membri, amministratori, messaggio fissato e cosa può fare lì il bot (il suo stato e i suoi permessi).',
  'Send a Telegram text message from a bot or a Telegram account. A bot can write only to people who started it and to groups and channels it is in; a Telegram account writes as that person, to anyone it could write to from the app (buttons are for bots only). Plain text longer than 4096 characters is split into several messages. Confirm recipient and text with the user first.': 'Invia un messaggio di testo Telegram da un bot o da un account Telegram. Un bot può scrivere solo alle persone che l’hanno avviato e ai gruppi e canali in cui si trova; un account Telegram scrive come quella persona, a chiunque potrebbe scrivere dall’app (i pulsanti solo per i bot). Il testo semplice oltre 4096 caratteri viene diviso in più messaggi. Conferma prima destinatario e testo con l’utente.',
  'Send a photo, video, audio, voice message, document, sticker, GIF (animation) or round video (video_note) from a public URL, base64 or the file_id of a file the bot already has. Up to 10 MB for photos and 50 MB for other files.': 'Invia una foto, un video, un audio, un messaggio vocale, un documento, uno sticker, una GIF (animation) o un video rotondo (video_note) da un URL pubblico, in base64 o con il file_id di un file che il bot ha già. Fino a 10 MB per le foto e 50 MB per gli altri file.',
  'Send a location pin; with name and address it is sent as a place (venue).': 'Invia una posizione sulla mappa; con nome e indirizzo viene inviata come luogo (venue).',
  'Put a reaction on a message: one emoji among the ones Telegram allows (👍 ❤ 🔥 🎉 👏 😁 🤔 👌 🙏 and others); an empty emoji removes the bot\'s reaction.': 'Mette una reazione a un messaggio: un’emoji tra quelle ammesse da Telegram (👍 ❤ 🔥 🎉 👏 😁 🤔 👌 🙏 e altre); un’emoji vuota toglie la reazione del bot.',
  'Edit a message the bot sent: its text, or its caption for a media message, and its buttons.': 'Modifica un messaggio inviato dal bot: il testo, o la didascalia per un media, e i pulsanti.',
  'Delete message': 'Elimina messaggio',
  'Delete a message for everyone: the bot\'s own messages, messages in a private chat with the bot, and any message of a group where the bot is an administrator allowed to delete (Telegram: within 48 hours).': 'Elimina un messaggio per tutti: i messaggi del bot, i messaggi in una chat privata con il bot e qualsiasi messaggio di un gruppo in cui il bot è amministratore con il permesso di eliminare (Telegram: entro 48 ore).',
  'Forward message': 'Inoltra messaggio',
  'Forward a message to another chat (it shows where it comes from), or copy it (it looks like a new message of the bot).': 'Inoltra un messaggio in un’altra chat (si vede da dove arriva), oppure lo copia (sembra un nuovo messaggio del bot).',
  'Pin message': 'Fissa messaggio',
  'Pin a message in a chat, or unpin it (without message_id: the most recent pinned one). In groups the bot must be an administrator allowed to pin.': 'Fissa un messaggio in una chat, o lo sblocca (senza message_id: l’ultimo fissato). Nei gruppi il bot deve essere amministratore con il permesso di fissare.',
  'Create an invite link': 'Crea un link d’invito',
  'Create a new invite link to a group or channel where the bot is an administrator with the right to invite users: optional name, expiry, member limit, or approval of each request.': 'Crea un nuovo link d’invito a un gruppo o canale in cui il bot è amministratore con il permesso di invitare: nome, scadenza, numero massimo di membri o approvazione di ogni richiesta, facoltativi.',
  'Get the media of a message (Telegram lets bots download files up to 20 MB): returns a temporary download link (1 h) and, for small images, the image itself. For a voice or audio message it also returns what was said (transcript) and, with include_audio, the audio itself.': 'Ottieni il media di un messaggio (Telegram fa scaricare ai bot file fino a 20 MB): restituisce un link di download temporaneo (1 h) e, per le immagini piccole, l’immagine stessa. Per un messaggio vocale o audio restituisce anche cosa è stato detto (trascrizione) e, con include_audio, l’audio stesso.',
  'Transcribe a Telegram voice message, audio file or round video (type voice, audio or video_note) to text, so you know what was said. Returns the transcript, the language and the length in seconds. Transcripts are kept: asking again is instant. Use force to transcribe again.': 'Trascrive in testo un messaggio vocale, un file audio o un video rotondo di Telegram (tipo voice, audio o video_note), così sai cosa è stato detto. Restituisce la trascrizione, la lingua e la durata in secondi. Le trascrizioni restano salvate: richiederle di nuovo è immediato. Usa force per trascrivere di nuovo.',
  'Link a bot first: the code comes from one of your bots': 'Collega prima un bot: il codice arriva da uno dei tuoi bot',
  'Bot "{0}" is not connected (state: {1})': 'Il bot "{0}" non è connesso (stato: {1})',
  'This bot has no username on Telegram': 'Questo bot non ha uno username su Telegram',
  'Link your Telegram account first (Settings → General), or use a login link': 'Collega prima il tuo account Telegram (Impostazioni → Generale), oppure usa un link di accesso',
  'No connected bot to send the code with. Use a login link.': 'Nessun bot connesso con cui inviare il codice. Usa un link di accesso.',
  'The code could not be sent on Telegram: {0}': 'Non sono riuscito a inviare il codice su Telegram: {0}',
  'Feedback is not set up on this installation yet (no key for the issues of {0})': 'Il feedback non è ancora configurato su questa installazione (manca la chiave per le issue di {0})',
  'This person blocked the bot': 'Questa persona ha bloccato il bot',
  'The bot cannot write in this chat: the person must start the bot first, or the bot lacks the rights in the group ({0})': 'Il bot non può scrivere in questa chat: la persona deve prima avviare il bot, oppure al bot mancano i permessi nel gruppo ({0})',
  'Telegram does not know this chat, or the bot is not in it': 'Telegram non conosce questa chat, oppure il bot non ne fa parte',
  'Telegram does not find this message any more': 'Telegram non trova più questo messaggio',
  'Telegram does not allow this on this message: {0}': 'Telegram non lo consente su questo messaggio: {0}',
  'Nothing changes: the message already looks like that': 'Non cambia niente: il messaggio è già così',
  'The bot is not a member of this chat any more': 'Il bot non fa più parte di questa chat',
  'Formatting error in the text: {0}': 'Errore di formattazione nel testo: {0}',
  'Telegram asks to slow down: try again in {0} seconds': 'Telegram chiede di rallentare: riprova fra {0} secondi',
  'Telegram refused: {0}': 'Telegram ha rifiutato: {0}',
  'This bot has no token yet': 'Questo bot non ha ancora un token',
  'The name must be 1–64 characters': 'Il nome deve avere 1–64 caratteri',
  'The short description must be at most 120 characters': 'La descrizione breve può avere al massimo 120 caratteri',
  'The description must be at most 512 characters': 'La descrizione può avere al massimo 512 caratteri',
  'A command is 1–32 characters: lowercase letters, digits and _ ({0})': 'Un comando ha 1–32 caratteri: lettere minuscole, cifre e _ ({0})',
  'Each command needs a description of 1–256 characters ({0})': 'Ogni comando vuole una descrizione di 1–256 caratteri ({0})',
  'At most 100 commands': 'Al massimo 100 comandi',
  'The photo is not an image TeleOps can read': 'La foto non è un’immagine che TeleOps sa leggere',
  'This is not a bot token. Copy it from @BotFather: it looks like 123456789:AAE…': 'Questo non è il token di un bot. Copialo da @BotFather: è fatto così 123456789:AAE…',
  'No Telegram bot is linked yet. Add one in the config page.': 'Nessun bot Telegram collegato. Aggiungine uno nella pagina di configurazione.',
  'Telegram bot "{0}" not found': 'Bot Telegram "{0}" non trovato',
  'Telegram does not accept this token: copy it again from @BotFather (or /revoke there for a new one)': 'Telegram non accetta questo token: copialo di nuovo da @BotFather (oppure lì usa /revoke per averne uno nuovo)',
  'Telegram cannot be reached: {0}': 'Telegram non è raggiungibile: {0}',
  'This bot sends its updates to a webhook ({0}). TeleOps reads them itself: confirm to take the bot over (the webhook is removed, that program stops receiving).': 'Questo bot manda i suoi aggiornamenti a un webhook ({0}). TeleOps li legge da solo: conferma per prendere il controllo del bot (il webhook viene tolto, quel programma smette di ricevere).',
  'Every button needs a text': 'Ogni pulsante vuole un testo',
  'A button link must start with http://, https:// or tg://: {0}': 'Il link di un pulsante deve iniziare con http://, https:// o tg://: {0}',
  'The data of a button is at most 64 bytes: {0}': 'I dati di un pulsante sono al massimo 64 byte: {0}',
  'At most 100 buttons': 'Al massimo 100 pulsanti',
  'No public chat @{0} on Telegram, and nobody with this username wrote to the bot': 'Nessuna chat pubblica @{0} su Telegram, e nessuno con questo username ha scritto al bot',
  'No chat or person named "{0}". Use the chat id or @username.': 'Nessuna chat o persona con nome "{0}". Usa l’id della chat o lo @username.',
  '"{0}" matches several chats: {1}. Use the chat id or @username.': '"{0}" corrisponde a più chat: {1}. Usa l’id della chat o lo @username.',
  'reply_to is the id of a message in the same chat (a number)': 'reply_to è l’id di un messaggio della stessa chat (un numero)',
  'A formatted message is at most {0} characters (plain text is split by itself)': 'Un messaggio formattato ha al massimo {0} caratteri (il testo semplice viene diviso da solo)',
  'Provide url, base64 or file_id': 'Fornisci url, base64 o file_id',
  'Unknown media type {0}': 'Tipo di media sconosciuto: {0}',
  'A {0} has no caption': 'Un {0} non ha didascalia',
  'A caption is at most {0} characters': 'Una didascalia ha al massimo {0} caratteri',
  'Telegram takes a {0} of at most {1} MB from a bot': 'Telegram accetta da un bot un {0} di al massimo {1} MB',
  'message_id is the number of a Telegram message': 'message_id è il numero di un messaggio Telegram',
  'A bot can edit only the messages it sent': 'Un bot può modificare solo i messaggi che ha inviato',
  'At most {0} characters': 'Al massimo {0} caratteri',
  'Which message? message_id is required to pin': 'Quale messaggio? Per fissare serve message_id',
  'A link that asks to join cannot also have a member limit': 'Un link con richiesta di accesso non può avere anche un limite di membri',
  'Telegram lets a bot download files up to 20 MB; this one is {0} MB': 'Telegram fa scaricare a un bot file fino a 20 MB; questo è di {0} MB',
  'Get a login code on <b>your Telegram</b>, from your bot.': 'Ricevi un codice di accesso sul <b>tuo Telegram</b>, dal tuo bot.',
  'Send me the code on Telegram': 'Mandami il codice su Telegram',
  'Read the chats and messages of your bots': 'Leggere le chat e i messaggi dei tuoi bot',
  'Send messages, media and reactions with your bots': 'Inviare messaggi, media e reazioni con i tuoi bot',
  '<b>{0}</b> is asking for access to your Telegram bots.': '<b>{0}</b> chiede accesso ai tuoi bot Telegram.',
  '<b>{0}</b> wants to connect to your Telegram bots.': '<b>{0}</b> vuole collegarsi ai tuoi bot Telegram.',
  'Configuration of the Telegram bots server (bots, database, API keys, MCP connectors).': 'Configurazione del server dei bot Telegram (bot, database, chiavi API, connettori MCP).',
  // plugins
  'Another plugin with the id "{0}" is installed (from {1}): remove it first': 'È già installato un altro plugin con l\'id "{0}" (da {1}): rimuovilo prima',
  'GitHub cannot be reached: {0}': 'GitHub non è raggiungibile: {0}',
  'GitHub sent an archive that cannot be opened: try again': 'GitHub ha mandato un archivio che non si apre: riprova',
  'No plugin "{0}" is installed': 'Nessun plugin "{0}" è installato',
  'Paste the address of a GitHub repository, like https://github.com/owner/repo': 'Incolla l\'indirizzo di un repository GitHub, tipo https://github.com/proprietario/repo',
  'The main file of the plugin ({0}) is not in the repository': 'Il file principale del plugin ({0}) non è nel repository',
  'The new version has another id ("{0}"): remove this plugin and install it again': 'La nuova versione ha un altro id ("{0}"): rimuovi questo plugin e installalo di nuovo',
  'The plugin did not answer within {0} seconds': 'Il plugin non ha risposto entro {0} secondi',
  'The plugin did not finish starting within {0} seconds': 'Il plugin non ha finito di avviarsi entro {0} secondi',
  'The plugin failed too often and was stopped: {0}': 'Il plugin ha dato errore troppe volte ed è stato fermato: {0}',
  'The plugin failed: {0}': 'Errore del plugin: {0}',
  'The plugin has no start function: its main file must export default { start(ctx) }': 'Il plugin non ha una funzione start: il suo file principale deve esportare default { start(ctx) }',
  'The plugin stopped with an error: {0}': 'Il plugin si è fermato per un errore: {0}',
  'The value of "{0}" is not valid': 'Il valore di "{0}" non è valido',
  'This plugin is already installed: use Update on its page': 'Questo plugin è già installato: usa Aggiorna nella sua pagina',
  'This plugin is being installed or updated: wait a moment': 'Questo plugin si sta installando o aggiornando: aspetta un momento',
  'This plugin is stopped': 'Questo plugin è fermo',
  'This plugin needs TeleOps {0} or newer (this one is {1})': 'Questo plugin richiede TeleOps {0} o più recente (questo è {1})',
  'This repository does not exist or is private: TeleOps installs plugins from public GitHub repositories': 'Questo repository non esiste o è privato: TeleOps installa plugin da repository GitHub pubblici',
  'This repository has no branch or tag "{0}"': 'Questo repository non ha un branch o un tag "{0}"',
  'This repository has no commits yet': 'Questo repository non ha ancora commit',
  'This repository is not a TeleOps plugin: teleops-plugin.json is missing at its top': 'Questo repository non è un plugin TeleOps: manca teleops-plugin.json nella cartella principale',
  'This repository is too big for a plugin (more than {0} MB)': 'Questo repository è troppo grande per un plugin (più di {0} MB)',
  'teleops-plugin.json is not valid: {0}': 'teleops-plugin.json non è valido: {0}',
  // Telegram user accounts
  'Account "{0}" is not connected (state: {1})': 'L\'account "{0}" non è connesso (stato: {1})',
  'Add the Telegram app code first (api_id and api_hash from my.telegram.org)': 'Aggiungi prima il codice app Telegram (api_id e api_hash da my.telegram.org)',
  'Buttons under a message are for bots only: a Telegram account cannot send them': 'I pulsanti sotto un messaggio sono solo per i bot: un account Telegram non può inviarli',
  'Only bots have this, not a Telegram account': 'Questo ce l\'hanno solo i bot, non un account Telegram',
  'Telegram asks to wait before trying again ({0})': 'Telegram chiede di aspettare prima di riprovare ({0})',
  'Telegram does not accept this app code (api_id / api_hash): copy both again from my.telegram.org': 'Telegram non accetta questo codice app (api_id / api_hash): copiali di nuovo entrambi da my.telegram.org',
  'Telegram has banned this phone number': 'Telegram ha bloccato questo numero di telefono',
  'Telegram refused the login: {0}': 'Telegram ha rifiutato l\'accesso: {0}',
  'The QR code has expired: start again': 'Il codice QR è scaduto: ricomincia',
  'The app code comes from TELEOPS_API_ID / TELEOPS_API_HASH: change it there': 'Il codice app arriva da TELEOPS_API_ID / TELEOPS_API_HASH: cambialo lì',
  'The code has expired: start again for a new one': 'Il codice è scaduto: ricomincia per averne uno nuovo',
  'This Telegram id is already linked as a bot': 'Questo id Telegram è già collegato come bot',
  'This account can edit only its own messages': 'Questo account può modificare solo i propri messaggi',
  'This account cannot do that in this chat ({0})': 'Questo account non può farlo in questa chat ({0})',
  'This account does not know this chat: use the id or @username of a chat it is in or a person it can write to': 'Questo account non conosce questa chat: usa l\'id o lo @username di una chat in cui si trova o di una persona a cui può scrivere',
  'This account has a two-step verification password': 'Questo account ha una password di verifica in due passaggi',
  'This account is not a member of this chat': 'Questo account non fa parte di questa chat',
  'This file is {0} MB, more than the limit set in Settings ({1} MB)': 'Questo file è di {0} MB, più del limite impostato nelle Impostazioni ({1} MB)',
  'This login is not waiting for a code': 'Questo accesso non sta aspettando un codice',
  'This login is not waiting for a password': 'Questo accesso non sta aspettando una password',
  'This login is over (finished, cancelled or left for 10 minutes): start again': 'Questo accesso è chiuso (finito, annullato o lasciato per 10 minuti): ricomincia',
  'This number has no Telegram account: create it in the Telegram app first': 'Questo numero non ha un account Telegram: crealo prima nell\'app Telegram',
  'This person does not accept messages from this account ({0})': 'Questa persona non accetta messaggi da questo account ({0})',
  'This phone number is not valid: write it with the country code, like +971 50 123 4567': 'Questo numero di telefono non è valido: scrivilo con il prefisso internazionale, tipo +39 333 123 4567',
  'Too many logins in progress: finish or cancel one first': 'Troppi accessi in corso: finiscine o annullane uno prima',
  'Wrong code: check it in Telegram and type it again': 'Codice sbagliato: controllalo in Telegram e scrivilo di nuovo',
  'Wrong password: it is the two-step verification password of this Telegram account': 'Password sbagliata: è la password di verifica in due passaggi di questo account Telegram',
  'You blocked this person on Telegram: unblock them first': 'Hai bloccato questa persona su Telegram: sbloccala prima',
  'api_id is a number and api_hash 32 letters and digits: copy both from my.telegram.org → API development tools': 'api_id è un numero e api_hash 32 lettere e cifre: copiali entrambi da my.telegram.org → API development tools',
}

/** All translatable keys (used by tests to make sure Italian covers every English string). */
export const IT_KEYS = Object.keys(IT)
