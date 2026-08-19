/**
 * The FactionFiles map API, as far as this tool is concerned. One place that
 * knows the wire shapes, so nothing else has to.
 *
 * The tool is a static page, so these calls go from the browser straight to
 * FactionFiles. Every one of them is a plain GET, or a text/plain POST, which is
 * what keeps them out of preflight territory. The contract is
 * `site/doc/map-api.md` in the FactionFiles repo.
 *
 * Everything here fails soft. The map picker is additive: a search that cannot
 * reach the archive leaves you typing a file name by hand, which is how the
 * rotation was built before any of this existed.
 */

/** the endpoint set, overridable so a local FactionFiles can be pointed at */
const BASE = String(import.meta.env?.VITE_MAP_API ?? 'https://autodl.factionfiles.com/maps/v1/')
  .replace(/\/*$/, '/')

/** what the batch check accepts in one request */
const BATCH = 100

/** past this we post the names instead, rather than build an unwieldy url */
const URL_NAMES = 25

export interface MapCategory {
  id: number
  name: string
  /** which game, since the archive holds more than Red Faction */
  game: { id: number; name: string }
  /** distinct level names in it */
  maps: number
}

export interface MapResult {
  fileId: number
  /** the level file name, exactly as the archive holds it. this is the point */
  rfl: string
  title: string
  author: string
  description: string
  size: number
  /** unix seconds */
  uploadedAt: number
  downloads: number
  category: { id: number; name: string }
  game: { id: number; name: string }
  thumbUrl: string
  imageUrl: string
  siteUrl: string
  downloadUrl: string
}

export interface MapSearch {
  query: string
  /** the whole match count rather than this page, so paging can be described */
  total: number
  limit: number
  offset: number
  results: MapResult[]
}

/** one level the autodownloader will serve. `siteUrl` is null when unlisted */
export interface MapHeld {
  rfl: string
  fileId: number
  title: string
  author: string
  siteUrl: string | null
}

export class MapApiError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'MapApiError'
    this.code = code
  }
}

/** what a person should be told, per error code the api documents */
function sayFor(code: string, status: number) {
  if (code === 'query_too_long') return 'That search is too long.'
  if (code === 'invalid_category') return 'That category is not one FactionFiles knows.'
  if (code === 'too_many_names') return 'Too many maps to check in one go.'
  if (code === 'no_names') return 'There was nothing to look up.'
  if (status === 0) return 'Could not reach FactionFiles.'
  if (status >= 500) return 'FactionFiles had a problem answering.'
  return 'FactionFiles could not answer that.'
}

async function call(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(BASE + path, init)
  } catch (cause) {
    // a blocked origin, a dead host and an aborted call all land here
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new MapApiError('unreachable', sayFor('unreachable', 0))
  }

  let body: Record<string, unknown> = {}
  try {
    body = await response.json()
  } catch {
    // a failure is documented to carry json, so anything else is a broken host
    if (response.ok) throw new MapApiError('bad_response', 'FactionFiles sent something unreadable.')
  }

  if (!response.ok || body.ok !== true) {
    const code = typeof body.error === 'string' ? body.error : 'http_' + response.status
    throw new MapApiError(code, sayFor(code, response.status))
  }
  return body
}

const asText = (value: unknown) => (typeof value === 'string' ? value : '')
const asCount = (value: unknown) => (typeof value === 'number' && isFinite(value) ? value : 0)

function asPair(value: unknown): { id: number; name: string } {
  const pair = (value ?? {}) as Record<string, unknown>
  return { id: asCount(pair.id), name: asText(pair.name) }
}

// the wire is snake case and the rest of the tool is not, so the shapes meet
// here and nowhere else
function asResult(row: Record<string, unknown>): MapResult {
  return {
    fileId: asCount(row.file_id),
    rfl: asText(row.rfl),
    title: asText(row.title),
    author: asText(row.author),
    description: asText(row.description),
    size: asCount(row.size),
    uploadedAt: asCount(row.uploaded_at),
    downloads: asCount(row.downloads),
    category: asPair(row.category),
    game: asPair(row.game),
    thumbUrl: asText(row.thumb_url),
    imageUrl: asText(row.image_url),
    siteUrl: asText(row.site_url),
    downloadUrl: asText(row.download_url),
  }
}

function asHeld(row: Record<string, unknown>): MapHeld {
  return {
    rfl: asText(row.rfl),
    fileId: asCount(row.file_id),
    title: asText(row.title),
    author: asText(row.author),
    siteUrl: typeof row.site_url === 'string' ? row.site_url : null,
  }
}

/**
 * A level name written however somebody had it, turned into the name the archive
 * stores. The same shapes the api itself accepts, done here as well so a name
 * asked about twice is only ever fetched once.
 */
export function levelName(written: string): string {
  let name = written.trim()
  if (name.slice(0, 5).toLowerCase() === '$map:') name = name.slice(5)
  name = name.trim().replace(/^["']|["']$/g, '').trim()
  if (!name) return ''
  return name.slice(-4).toLowerCase() === '.rfl' ? name : name + '.rfl'
}

const searches = new Map<string, MapSearch>()
const held = new Map<string, MapHeld | null>()
let categories: MapCategory[] | null = null

export interface SearchOptions {
  query?: string
  category?: number | null
  limit?: number
  offset?: number
  signal?: AbortSignal
}

export async function searchMaps(options: SearchOptions = {}): Promise<MapSearch> {
  const query = (options.query ?? '').trim()
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (options.category) params.set('cat', String(options.category))
  if (options.limit) params.set('limit', String(options.limit))
  if (options.offset) params.set('offset', String(options.offset))

  const key = params.toString()
  const cached = searches.get(key)
  if (cached) return cached

  const body = await call('search.php?' + key, { signal: options.signal })
  const rows = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : []
  const search: MapSearch = {
    query: asText(body.query),
    total: asCount(body.total),
    limit: asCount(body.limit),
    offset: asCount(body.offset),
    results: rows.map(asResult),
  }

  searches.set(key, search)
  // every map the picker offers is one the autodownloader serves, so a search is
  // also an answer about the names it returned
  for (const map of search.results) {
    held.set(map.rfl.toLowerCase(), {
      rfl: map.rfl,
      fileId: map.fileId,
      title: map.title,
      author: map.author,
      siteUrl: map.siteUrl || null,
    })
  }
  return search
}

export async function mapCategories(signal?: AbortSignal): Promise<MapCategory[]> {
  if (categories) return categories
  const body = await call('categories.php', { signal })
  const rows = Array.isArray(body.categories) ? (body.categories as Record<string, unknown>[]) : []
  categories = rows.map(row => ({
    id: asCount(row.id),
    name: asText(row.name),
    game: asPair(row.game),
    maps: asCount(row.maps),
  }))
  return categories
}

/**
 * Which of these levels the autodownloader will serve, keyed by the name asked
 * about. A null means it will not, which is the finding worth raising: everyone
 * who joins on that map fails to download it.
 *
 * Names already answered for are not asked about again, so checking a rotation
 * after adding one map costs one name rather than fifty.
 */
export async function checkMaps(names: string[], signal?: AbortSignal): Promise<Map<string, MapHeld | null>> {
  const wanted = new Map<string, string>()
  for (const written of names) {
    const name = levelName(written)
    if (name) wanted.set(name.toLowerCase(), name)
  }

  const missing = [...wanted].filter(([key]) => !held.has(key)).map(([, name]) => name)
  for (let at = 0; at < missing.length; at += BATCH) {
    const batch = missing.slice(at, at + BATCH)
    // a comma in a name would read as two names in the url, so those names go
    // in the body where the separator is a newline instead
    const posted = batch.length > URL_NAMES || batch.some(name => name.includes(','))
    const body = posted
      ? await call('have.php', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: batch.join('\n'),
          signal,
        })
      : await call('have.php?rfl=' + encodeURIComponent(batch.join(',')), { signal })

    const answers = (body.results ?? {}) as Record<string, unknown>
    for (const name of batch) {
      const answer = answers[name]
      held.set(name.toLowerCase(), answer ? asHeld(answer as Record<string, unknown>) : null)
    }
  }

  const out = new Map<string, MapHeld | null>()
  for (const [key, name] of wanted) out.set(name, held.get(key) ?? null)
  return out
}

/** what is already known about a level name without asking anyone */
export function knownMap(written: string): MapHeld | null | undefined {
  return held.get(levelName(written).toLowerCase())
}
