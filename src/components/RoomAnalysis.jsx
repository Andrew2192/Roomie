// src/components/RoomAnalysis.jsx
// Roomie — displays AI room observations and organization recommendations
// from the Snowflake Cortex backend.
//
// Usage:
//   import RoomAnalysis from './components/RoomAnalysis.jsx'
//   <RoomAnalysis imageUrl={imageUrl} />   // same imageUrl the Room3D gets
//
// States: idle (no image) → loading → result | error.
// Every new imageUrl cancels/ignores the previous request (stale-result
// protection) and shows an honest backend error message when analysis fails.
// It never fabricates recommendations — only parsed backend output is shown.

import React, { useEffect, useState } from 'react'
import { analyzeImage, ApiError } from '../lib/api.js'

const REFRESH_TIMEOUT_MS = 75_000

const PRIORITY_COLORS = {
  high: '#f87171',
  medium: '#fbbf24',
  low: '#5eead4',
}

/** Minimal shared button/panel styling (inline; no global CSS). */
const STYLE = {
  panel: {
    background: '#0d131d',
    border: '1px solid #1f2937',
    borderRadius: 10,
    padding: 14,
    color: '#e5e7eb',
    fontSize: 13,
    lineHeight: 1.55,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    height: '100%',
    overflowY: 'auto',
  },
  heading: { margin: 0, fontSize: 13, color: '#8b93a1', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 },
  summary: { margin: 0, fontWeight: 500, fontSize: 14 },
  listItem: { margin: 0 },
  suggestion: {
    border: '1px solid #1f2937',
    borderRadius: 8,
    padding: '8px 10px',
    background: '#111827',
  },
  priority: {
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    padding: '1px 7px',
    borderRadius: 999,
    marginBottom: 4,
  },
  error: { color: '#f87171', whiteSpace: 'pre-wrap' },
  dim: { color: '#8b93a1', fontSize: 12 },
  spinner: {
    width: 16,
    height: 16,
    borderRadius: '50%',
    border: '2px solid #334155',
    borderTopColor: '#5eead4',
    animation: 'roomie-spin 0.8s linear infinite',
    flexShrink: 0,
  },
  spinKeyframes: `
@keyframes roomie-spin { to { transform: rotate(360deg); } }
`,
}

export default function RoomAnalysis({ imageUrl, timeoutMs = REFRESH_TIMEOUT_MS }) {
  const [state, setState] = useState({ status: 'idle' }) // idle | loading | done | error
  // Request-sequencing: only the latest request may publish its result, so a
  // second image never shows a first image's analysis (stale-result guard).
  const requestIdRef = React.useRef(0)

  useEffect(() => {
    if (!imageUrl) {
      setState({ status: 'idle' })
      return undefined
    }
    const current = ++requestIdRef.current
    setState({ status: 'loading' })

    let cancelled = false
    analyzeImage(imageUrl, { timeoutMs })
      .then((analysis) => {
        if (cancelled || current !== requestIdRef.current) return
        setState({ status: 'done', analysis })
      })
      .catch((err) => {
        if (cancelled || current !== requestIdRef.current) return
        console.error('[roomie/RoomAnalysis] analysis failed:', err)
        const message =
          err instanceof ApiError
            ? err.message
            : `Unexpected error during analysis: ${err?.message ?? err}`
        setState({ status: 'error', error: message })
      })

    return () => {
      cancelled = true
    }
  }, [imageUrl, timeoutMs])

  return (
    <div style={STYLE.panel}>
      <style>{STYLE.spinKeyframes}</style>

      {state.status === 'idle' && (
        <>
          <h3 style={STYLE.heading}>AI room analysis</h3>
          <p style={STYLE.dim}>Upload a room photo to get observations and organizing tips from Snowflake Cortex.</p>
        </>
      )}

      {state.status === 'loading' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} id="roomie-analysis-loading">
          <div style={STYLE.spinner} />
          <span>Analyzing room with Snowflake Cortex…</span>
        </div>
      )}

      {state.status === 'error' && (
        <div id="roomie-analysis-error">
          <h3 style={{ ...STYLE.heading, color: '#f87171' }}>AI analysis failed</h3>
          <p style={STYLE.error}>{state.error}</p>
          <p style={STYLE.dim}>
            This shows the backend's real error — analysis is not simulated, so results only appear when
            Snowflake Cortex responds successfully.
          </p>
        </div>
      )}

      {state.status === 'done' && (
        <div id="roomie-analysis-result">
          <h3 style={STYLE.heading}>AI room analysis</h3>
          <p style={STYLE.summary}>{state.analysis.summary}</p>

          {state.analysis.observations.length > 0 && (
            <div>
              <h4 style={{ margin: '2px 0 4px', color: '#8b93a1', fontSize: 12 }}>Observations</h4>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {state.analysis.observations.map((o, i) => (
                  <li key={i} style={STYLE.listItem}>{o}</li>
                ))}
              </ul>
            </div>
          )}

          {state.analysis.suggestions.length > 0 && (
            <div>
              <h4 style={{ margin: '2px 0 6px', color: '#8b93a1', fontSize: 12 }}>Recommendations</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {state.analysis.suggestions.map((s, i) => (
                  <div key={i} style={STYLE.suggestion}>
                    <span style={{ ...STYLE.priority, background: `${PRIORITY_COLORS[s.priority]}22`, color: PRIORITY_COLORS[s.priority] }}>
                      {s.priority}
                    </span>
                    <div style={{ fontWeight: 600 }}>{s.title}</div>
                    <div style={STYLE.dim}>{s.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
