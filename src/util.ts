/** Replace {0}, {1}… with params. */
export function fmt(template: string, params: unknown[] = []): string {
  return template.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < params.length ? String(params[Number(i)]) : m))
}

/** Error with a stable code and an English template; translated at the edge (REST / MCP / pages). */
export class AppError extends Error {
  constructor(
    public code: string,
    public template: string,
    public status = 400,
    public params: unknown[] = [],
  ) {
    super(fmt(template, params))
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function digits(s: string): string {
  return String(s ?? '').replace(/\D+/g, '')
}

export function slugify(s: string): string {
  return (
    String(s ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'account'
  )
}
