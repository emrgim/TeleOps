/**
 * teleops-plugin.json, at the top of the plugin's repository: who the plugin is, which file starts it and
 * the settings it asks for (TeleOps draws the form). Names, descriptions and labels can be translated in i18n.
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { VERSION } from '../config.js'
import type { Lang } from '../i18n.js'
import { AppError } from '../util.js'

export const MANIFEST_FILE = 'teleops-plugin.json'

const text = (max: number) => z.string().trim().min(1).max(max)

const option = z.union([z.string().max(200), z.object({ value: z.string().max(200), label: text(200) })])

const settingSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  label: text(100),
  /** account = one of the bots or Telegram accounts of this TeleOps (the page shows a list) */
  type: z.enum(['text', 'textarea', 'secret', 'number', 'boolean', 'select', 'url', 'account']).default('text'),
  help: z.string().max(500).optional(),
  placeholder: z.string().max(200).optional(),
  required: z.boolean().optional(),
  default: z.union([z.string().max(2000), z.number(), z.boolean()]).optional(),
  options: z.array(option).max(200).optional(),
})

const localized = z.object({
  name: text(60).optional(),
  description: z.string().max(500).optional(),
  settings: z.record(z.string(), z.object({ label: text(100).optional(), help: z.string().max(500).optional(), placeholder: z.string().max(200).optional() })).optional(),
})

export const manifestSchema = z.object({
  /** a-z, 0-9 and -, starting with a letter: the plugin's MCP tools are named <id>_<tool> */
  id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  name: text(60),
  description: z.string().max(500).optional(),
  version: z.string().max(32).optional(),
  author: z.string().max(100).optional(),
  homepage: z.string().max(300).optional(),
  /** the file TeleOps imports: an ES module (built: no npm install happens) */
  main: z.string().max(200).default('index.mjs'),
  icon: z.string().max(200).optional(),
  /** oldest TeleOps it works with: ">=0.1.0" or "0.1.0" */
  teleops: z.string().max(32).optional(),
  settings: z.array(settingSchema).max(50).default([]),
  i18n: z.record(z.string(), localized).optional(),
})

export type Manifest = z.infer<typeof manifestSchema>
export type SettingDef = Manifest['settings'][number]

const ICON_TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** A path of the repository that stays inside it. */
function inside(dir: string, rel: string): string | null {
  const root = path.resolve(dir)
  const p = path.resolve(root, rel)
  return p.startsWith(root + path.sep) ? p : null
}

const parts = (v: string) => v.replace(/^[^\d]*/, '').split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0)

/** a < b as versions (1.10.0 > 1.9.3). */
export function olderThan(a: string, b: string): boolean {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}

/** Read and check the manifest of an unpacked plugin. */
export function readManifest(dir: string): Manifest {
  const file = path.join(dir, MANIFEST_FILE)
  if (!fs.existsSync(file)) throw new AppError('PLUGIN_NO_MANIFEST', 'This repository is not a TeleOps plugin: teleops-plugin.json is missing at its top', 400)
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new AppError('PLUGIN_BAD_MANIFEST', 'teleops-plugin.json is not valid: {0}', 400, [String((e as Error)?.message ?? e).slice(0, 200)])
  }
  const r = manifestSchema.safeParse(raw)
  if (!r.success) {
    const i = r.error.issues[0]
    throw new AppError('PLUGIN_BAD_MANIFEST', 'teleops-plugin.json is not valid: {0}', 400, [`${i?.path?.join('.') || '(top)'}: ${i?.message ?? 'invalid'}`])
  }
  const m = r.data
  if (m.id === 'telegram' || m.id === 'teleops') throw new AppError('PLUGIN_BAD_MANIFEST', 'teleops-plugin.json is not valid: {0}', 400, [`id: "${m.id}" is reserved`])
  const keys = new Set<string>()
  for (const s of m.settings) {
    if (keys.has(s.key)) throw new AppError('PLUGIN_BAD_MANIFEST', 'teleops-plugin.json is not valid: {0}', 400, [`settings: "${s.key}" appears twice`])
    keys.add(s.key)
    if (s.type === 'select' && !s.options?.length) throw new AppError('PLUGIN_BAD_MANIFEST', 'teleops-plugin.json is not valid: {0}', 400, [`settings.${s.key}: a select needs options`])
  }
  const main = inside(dir, m.main)
  if (!main || !/\.(m?js)$/.test(main) || !fs.existsSync(main)) throw new AppError('PLUGIN_NO_MAIN', 'The main file of the plugin ({0}) is not in the repository', 400, [m.main])
  if (m.icon && (!inside(dir, m.icon) || !ICON_TYPES[path.extname(m.icon).toLowerCase()])) throw new AppError('PLUGIN_BAD_MANIFEST', 'teleops-plugin.json is not valid: {0}', 400, ['icon: an .svg, .png, .jpg or .webp file of the repository'])
  if (m.teleops && olderThan(VERSION, m.teleops)) throw new AppError('PLUGIN_NEEDS_NEWER', 'This plugin needs TeleOps {0} or newer (this one is {1})', 409, [m.teleops.replace(/^[^\d]*/, ''), VERSION])
  return m
}

/** The icon file of the plugin and its type, if it has one. */
export function iconOf(dir: string, m: Manifest): { file: string; type: string } | null {
  if (!m.icon) return null
  const file = inside(dir, m.icon)
  const type = ICON_TYPES[path.extname(m.icon).toLowerCase()]
  if (!file || !type || !fs.existsSync(file)) return null
  return { file, type }
}

/** Name, description and settings in the language of the page (the manifest's own words otherwise). */
export function localize(m: Manifest, lang?: Lang) {
  const tr = (lang && m.i18n?.[lang]) || undefined
  return {
    name: tr?.name ?? m.name,
    description: tr?.description ?? m.description ?? '',
    settings: m.settings.map((s) => {
      const t = tr?.settings?.[s.key]
      return { ...s, label: t?.label ?? s.label, help: t?.help ?? s.help, placeholder: t?.placeholder ?? s.placeholder }
    }),
  }
}
