// src/lib/api.js
// Roomie — Snowflake Cortex AI analysis client (frontend side).
//
// Talks to the Express backend (server/) which authenticates to Snowflake
// Cortex and returns:
//   { summary: string, observations: string[], suggestions: [{title, reason, priority}] }
//
// The frontend never sees a Snowflake credential — all auth stays server-side.

const DEFAULT_TIMEOUT_MS = 75_000; // server allows 60s upstream; leave headroom

/** @typedef {{
 *   summary: string,
 *   observations: string[],
 *   suggestions: Array<{ title: string, reason: string, priority: 'high'|'medium'|'low' }>,
 * }} RoomAnalysis */

export class ApiError extends Error {
  /** @param {string} message user-safe message @param {string} code stable id */
  constructor(message, code = 'api_error') {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/**
 * Analyze an uploaded room photo via the Snowflake Cortex backend.
 *
 * @param {string} imageUrl URL of the image to analyze (blob:, data:, or https(s))
 * @param {{ baseUrl?: string, timeoutMs?: number, signal?: AbortSignal }=} opts
 *   baseUrl: backend origin; default '' → same origin (works with the Vite
 *   proxy at /api) or set VITE_API_BASE_URL at build time.
 * @returns {Promise<RoomAnalysis>}
 */
export async function analyzeImage(imageUrl, { baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const base = baseUrl ?? import.meta.env?.VITE_API_BASE_URL ?? ''
  const endpoint = `${base.replace(/\/+$/, '')}/api/analyze`

  let file
  try {
    // The backend needs the raw bytes as multipart/form-data. Fetching the
    // blob/data/https URL is safe from the browser (CORS-free for blob/data).
    const response = await fetch(imageUrl)
    if (!response.ok) {
      throw new ApiError(`Could not read the uploaded image (${response.status}).`, 'image_read_failed')
    }
    file = await response.blob()
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError(`Could not read the uploaded image.`, 'image_read_failed')
  }
  if (file.size === 0) {
    throw new ApiError('The uploaded image is empty.', 'image_read_failed')
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new ApiError('Image must be 10 MB or smaller.', 'image_too_large')
  }
  const type = file.type || guessTypeFromUrl(imageUrl)
  if (type && !/^image\/(jpeg|png|webp)$/.test(type)) {
    throw new ApiError('Only JPEG, PNG, or WebP images can be analyzed.', 'unsupported_type')
  }

  // Network timeout: prevents the UI hanging forever when the backend or
  // Cortex stalls. An external signal (cancel/cleanup) aborts too.
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const abortSignal = AbortSignal.any?.(signal ? [signal, timeoutSignal] : [timeoutSignal]) ?? timeoutSignal

  const form = new FormData()
  form.append('image', file, 'room.jpg')

  let response
  try {
    response = await fetch(endpoint, { method: 'POST', body: form, signal: abortSignal })
  } catch (err) {
    if (signal?.aborted) throw new ApiError('Analysis cancelled.', 'cancelled')
    if (err?.name === 'TimeoutError') {
      throw new ApiError('The AI analysis request timed out. Please try again.', 'timeout')
    }
    throw new ApiError(
      `Could not reach the Roomie analysis backend at ${endpoint}. Is the server running?`,
      'network',
    )
  }

  let body
  try {
    body = await response.json()
  } catch {
    if (response.status === 200) {
      throw new ApiError('The analysis backend returned an invalid response.', 'bad_response')
    }
    throw new ApiError(`The analysis backend returned HTTP ${response.status}.`, 'bad_response')
  }

  if (!response.ok) {
    throw new ApiError(
      typeof body?.error === 'string' && body.error.trim()
        ? body.error
        : `The analysis backend returned HTTP ${response.status}.`,
      response.status >= 500 ? 'backend_error' : 'bad_request',
    )
  }

  return validateAnalysis(body)
}

function guessTypeFromUrl(url) {
  if (/\.jpe?g(\?|$)/i.test(url)) return 'image/jpeg'
  if (/\.png(\?|$)/i.test(url)) return 'image/png'
  if (/\.webp(\?|$)/i.test(url)) return 'image/webp'
  return ''
}

/** Normalizes and validates the backend's analysis payload defensively. */
function validateAnalysis(body) {
  const summary = typeof body?.summary === 'string' ? body.summary.trim() : ''
  const observations = Array.isArray(body?.observations)
    ? body.observations.filter((o) => typeof o === 'string' && o.trim()).map((o) => o.trim())
    : []
  const suggestions = Array.isArray(body?.suggestions)
    ? body.suggestions
        .filter(
          (s) =>
            s &&
            typeof s === 'object' &&
            typeof s.title === 'string' &&
            typeof s.reason === 'string',
        )
        .map((s) => ({
          title: s.title.trim(),
          reason: s.reason.trim(),
          priority: ['high', 'medium', 'low'].includes(s.priority) ? s.priority : 'medium',
        }))
    : []

  if (!summary || observations.length === 0 || suggestions.length === 0) {
    throw new ApiError(
      'The analysis backend returned an unexpected response shape.',
      'bad_response',
    )
  }

  return { summary, observations, suggestions }
}
