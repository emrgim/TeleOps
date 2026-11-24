/**
 * Plugins come from public GitHub repositories. The address is resolved to a commit with git's own HTTP
 * protocol (github.com/<owner>/<repo>.git/info/refs — not the REST API, which allows 60 calls an hour per
 * address) and the code is the tarball of that commit (codeload.github.com). No account, no token.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { VERSION } from '../config.js'
import { AppError } from '../util.js'

export type RepoRef = { owner: string; repo: string; ref: string | null }
export type Resolved = RepoRef & { sha: string; branch: string | null }

/** Where GitHub is (the tests point these at a local server). */
const githubBase = () => (process.env.TELEOPS_GITHUB_URL || 'https://github.com').replace(/\/+$/, '')
const codeloadBase = () => (process.env.TELEOPS_CODELOAD_URL || 'https://codeload.github.com').replace(/\/+$/, '')

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const SHA_RE = /^[0-9a-f]{40}$/

const MAX_TARBALL = 30 * 1024 * 1024
const MAX_FILES = 5000
const MAX_BYTES = 150 * 1024 * 1024

const badRepo = () => new AppError('PLUGIN_BAD_REPO', 'Paste the address of a GitHub repository, like https://github.com/owner/repo', 400)
const unreachable = (why: string) => new AppError('GITHUB_UNREACHABLE', 'GitHub cannot be reached: {0}', 502, [why])
const notFound = () => new AppError('PLUGIN_REPO_NOT_FOUND', 'This repository does not exist or is private: TeleOps installs plugins from public GitHub repositories', 404)
const badArchive = () => new AppError('PLUGIN_BAD_ARCHIVE', 'GitHub sent an archive that cannot be opened: try again', 502)
const tooBig = () => new AppError('PLUGIN_TOO_BIG', 'This repository is too big for a plugin (more than {0} MB)', 413, [MAX_TARBALL / 1048576])

export const isSha = (s: string | null | undefined): boolean => !!s && SHA_RE.test(s)

/**
 * What people paste: https://github.com/owner/repo, with .git, /tree/<branch or tag>, /commit/<sha> or
 * /releases/tag/<tag>; github.com/owner/repo; owner/repo; git@github.com:owner/repo.git.
 * Anything else after the repository (a file, the issues) is ignored.
 */
export function parseRepo(input: string): RepoRef {
  let s = String(input ?? '').trim()
  s = s.replace(/^git@github\.com:/i, 'https://github.com/')
  if (/^(www\.)?github\.com\//i.test(s)) s = 'https://' + s
  let owner = ''
  let repo = ''
  let ref: string | null = null
  if (/^https?:\/\//i.test(s)) {
    let u: URL
    try {
      u = new URL(s)
    } catch {
      throw badRepo()
    }
    if (!/^(www\.)?github\.com$/i.test(u.hostname)) throw badRepo()
    let parts: string[]
    try {
      parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p))
    } catch {
      throw badRepo()
    }
    owner = parts[0] ?? ''
    repo = parts[1] ?? ''
    if (parts[2] === 'tree' && parts.length > 3) ref = parts.slice(3).join('/')
    else if (parts[2] === 'commit' && parts[3]) ref = parts[3]
    else if (parts[2] === 'releases' && parts[3] === 'tag' && parts.length > 4) ref = parts.slice(4).join('/')
  } else {
    const m = s.match(/^([^/\s]+)\/([^/\s]+)$/)
    if (!m) throw badRepo()
    owner = m[1]
    repo = m[2]
  }
  repo = repo.replace(/\.git$/i, '')
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') throw badRepo()
  if (ref !== null && (ref.length > 200 || /[\s~^:?*[\\]|\.\.|^\/|\/$/.test(ref))) throw badRepo()
  return { owner, repo, ref }
}

/** The refs a git server advertises (smart HTTP, protocol v0): name → commit, and where HEAD points. */
export function parseAdvertisement(buf: Buffer): { refs: Map<string, string>; head: string | null } {
  const refs = new Map<string, string>()
  let head: string | null = null
  let i = 0
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16)
    if (Number.isNaN(len)) break
    if (len === 0) {
      i += 4 // flush packet
      continue
    }
    if (len < 4 || i + len > buf.length) break
    let line = buf.subarray(i + 4, i + len).toString('utf8')
    i += len
    if (line.endsWith('\n')) line = line.slice(0, -1)
    if (line.startsWith('#')) continue
    const nul = line.indexOf('\0')
    const caps = nul >= 0 ? line.slice(nul + 1) : ''
    if (nul >= 0) line = line.slice(0, nul)
    const m = line.match(/^([0-9a-f]{40}) (.+)$/)
    if (!m) continue
    refs.set(m[2], m[1])
    const sym = caps.match(/(?:^| )symref=HEAD:(\S+)/)
    if (sym) head = sym[1]
  }
  return { refs, head }
}

/** The commit an address points to: the default branch, a branch, a tag, or the commit itself. */
export async function resolveRepo(r: RepoRef): Promise<Resolved> {
  if (isSha(r.ref)) return { ...r, sha: r.ref as string, branch: null }
  const url = `${githubBase()}/${r.owner}/${r.repo}.git/info/refs?service=git-upload-pack`
  let res: Response
  try {
    res = await fetch(url, { headers: { 'user-agent': `git/2.0 TeleOps/${VERSION}` }, signal: AbortSignal.timeout(20_000) })
  } catch (e) {
    throw unreachable(String((e as Error)?.message ?? e))
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    await res.body?.cancel().catch(() => undefined)
    throw notFound()
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw unreachable(`HTTP ${res.status}`)
  }
  const { refs, head } = parseAdvertisement(Buffer.from(await res.arrayBuffer()))
  if (!r.ref) {
    const sha = refs.get('HEAD')
    if (!sha) throw new AppError('PLUGIN_REPO_EMPTY', 'This repository has no commits yet', 404)
    return { ...r, sha, branch: head ? head.replace(/^refs\/heads\//, '') : null }
  }
  const sha = refs.get(`refs/heads/${r.ref}`) ?? refs.get(`refs/tags/${r.ref}^{}`) ?? refs.get(`refs/tags/${r.ref}`)
  if (!sha) throw new AppError('PLUGIN_REF_NOT_FOUND', 'This repository has no branch or tag "{0}"', 404, [r.ref])
  return { ...r, sha, branch: refs.has(`refs/heads/${r.ref}`) ? r.ref : null }
}

/** Download the code of one commit into dest (a folder that does not exist yet). */
export async function downloadCommit(r: { owner: string; repo: string; sha: string }, dest: string): Promise<{ files: number; bytes: number }> {
  const url = `${codeloadBase()}/${r.owner}/${r.repo}/tar.gz/${r.sha}`
  let res: Response
  try {
    res = await fetch(url, { headers: { 'user-agent': `TeleOps/${VERSION}` }, signal: AbortSignal.timeout(120_000) })
  } catch (e) {
    throw unreachable(String((e as Error)?.message ?? e))
  }
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined)
    throw notFound()
  }
  if (!res.ok || !res.body) throw unreachable(`HTTP ${res.status}`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += c.length
    if (size > MAX_TARBALL) throw tooBig()
    chunks.push(Buffer.from(c))
  }
  let tar: Buffer
  try {
    tar = zlib.gunzipSync(Buffer.concat(chunks), { maxOutputLength: MAX_BYTES + 16 * 1024 * 1024 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw tooBig()
    throw badArchive()
  }
  return untar(tar, dest)
}

function cstr(b: Buffer, start: number, len: number): string {
  const x = b.subarray(start, start + len)
  const z = x.indexOf(0)
  return (z >= 0 ? x.subarray(0, z) : x).toString('utf8')
}

/** The path of a pax extended header ("<len> path=<value>\n" records), if it has one. */
function paxPath(data: Buffer): string | null {
  let i = 0
  let out: string | null = null
  while (i < data.length) {
    const sp = data.indexOf(0x20, i)
    if (sp < 0) break
    const len = parseInt(data.subarray(i, sp).toString('ascii'), 10)
    if (!len || len < 0) break
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8')
    const eq = rec.indexOf('=')
    if (eq > 0 && rec.slice(0, eq) === 'path') out = rec.slice(eq + 1)
    i += len
  }
  return out
}

/**
 * Unpack a GitHub tarball into dest without its top folder (<repo>-<sha>/). Only files and folders are kept
 * (links and special files are skipped) and nothing can land outside dest.
 */
export function untar(tar: Buffer, dest: string, limits = { files: MAX_FILES, bytes: MAX_BYTES }): { files: number; bytes: number } {
  const root = path.resolve(dest)
  fs.mkdirSync(root, { recursive: true })
  let off = 0
  let files = 0
  let bytes = 0
  let longName: string | null = null
  let pax: string | null = null
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512)
    if (h.every((b) => b === 0)) break
    const size = parseInt(cstr(h, 124, 12).trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) throw badArchive()
    const type = String.fromCharCode(h[156] || 0x30)
    const data = tar.subarray(off + 512, off + 512 + size)
    if (data.length < size) throw badArchive()
    off += 512 + Math.ceil(size / 512) * 512
    if (type === 'g') continue // pax global header (GitHub: the commit)
    if (type === 'x') {
      pax = paxPath(data)
      continue
    }
    if (type === 'L') {
      longName = cstr(data, 0, data.length)
      continue
    }
    const prefix = cstr(h, 345, 155)
    const name = longName ?? pax ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100))
    longName = pax = null
    const rel = name.split('/').slice(1).filter((p) => p && p !== '.').join('/')
    if (!rel) continue
    if (type !== '0' && type !== '5' && type !== '7') continue // symlinks, hard links, devices
    const target = path.resolve(root, rel)
    if (target !== root && !target.startsWith(root + path.sep)) throw badArchive()
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    files += 1
    bytes += size
    if (files > limits.files || bytes > limits.bytes) throw tooBig()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
  }
  return { files, bytes }
}
