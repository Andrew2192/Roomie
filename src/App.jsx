import React, { useEffect, useRef, useState } from 'react'
import Room3D from './components/Room3D.jsx'
import RoomAnalysis from './components/RoomAnalysis.jsx'

/**
 * Roomie web frontend — main page.
 *
 * Upload flow:
 *   1. File is chosen → object URL (blob:) is created and shown as a preview.
 *   2. The same blob URL is handed to <Room3D> (depth + 3D point cloud) and
 *      <RoomAnalysis> (Snowflake Cortex recommendations) independently, so
 *      heavy inference in one never blocks the other.
 */

const STYLE = {
  page: {
    fontFamily: 'system-ui, sans-serif',
    background: '#0b0f16',
    color: '#e5e7eb',
    minHeight: '100vh',
    padding: 16,
    boxSizing: 'border-box',
  },
  header: { fontSize: 20, margin: '0 0 6px', fontWeight: 600 },
  subtitle: { margin: '0 0 14px', fontSize: 13, color: '#8b93a1' },
  uploadRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    alignItems: 'center',
    marginBottom: 14,
    background: '#0d131d',
    border: '1px solid #1f2937',
    borderRadius: 10,
    padding: 12,
  },
  button: {
    background: '#5eead4',
    color: '#06281f',
    border: 'none',
    borderRadius: 8,
    padding: '7px 16px',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  },
  fileLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    background: '#111827',
    border: '1px dashed #374151',
    borderRadius: 8,
    padding: '7px 14px',
    cursor: 'pointer',
    fontSize: 13,
    color: '#8b93a1',
  },
  preview: {
    width: 96,
    height: 72,
    objectFit: 'cover',
    borderRadius: 6,
    border: '1px solid #1f2937',
    display: 'block',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(300px, 380px)',
    gap: 12,
    alignItems: 'stretch',
  },
  viewerFrame: {
    height: '68vh',
    minHeight: 420,
    border: '1px solid #1f2937',
    borderRadius: 10,
    overflow: 'hidden',
  },
}

export default function App() {
  const [imageUrl, setImageUrl] = useState(null)
  const fileRef = useRef(null)

  // Expo Go bridge: the mobile app embeds this page in a WebView and injects
  // the captured room photo with:
  //   window.dispatchEvent(new MessageEvent('message', { data: {
  //     type: 'ROOMIE_IMAGE', imageDataUrl: 'data:image/jpeg;base64,…' } }))
  // so the phone can scan with the camera and still use this full web
  // pipeline (Room3D + Snowflake analysis) without a browser file picker.
  useEffect(() => {
    const handler = (event) => {
      const payload = event?.data
      if (
        payload?.type === 'ROOMIE_IMAGE' &&
        typeof payload.imageDataUrl === 'string' &&
        payload.imageDataUrl.startsWith('data:image/')
      ) {
        setImageUrl(payload.imageDataUrl)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  // Revoke the previous blob URL only after the new one is set; the memory
  // for the last shown image is intentionally left alive (preview needs it).
  const previousUrlRef = useRef(null)
  const onFile = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    previousUrlRef.current = url
    setImageUrl((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
      return url
    })
  }

  return (
    <div style={STYLE.page}>
      <h1 style={STYLE.header}>Roomie — AI room analysis</h1>
      <p style={STYLE.subtitle}>
        Upload a room photo: get real depth-estimated 3D reconstruction (left) and
        Snowflake Cortex recommendations (right) — computed independently.
      </p>

      <div style={STYLE.uploadRow}>
        <label style={STYLE.fileLabel}>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={onFile} style={{ display: 'none' }} />
          <button type="button" id="btn-upload" onClick={() => fileRef.current?.click()} style={STYLE.button}>
            Upload room photo
          </button>
          <span>or drop a JPEG / PNG / WebP</span>
        </label>
        {imageUrl && (
          <img id="upload-preview" src={imageUrl} alt="Uploaded room preview" style={STYLE.preview} />
        )}
        {imageUrl && (
          <span style={{ color: '#8b93a1', fontSize: 12 }} id="upload-ok">
            Image ready — 3D scan and AI analysis are both running.
          </span>
        )}
      </div>

      {imageUrl && (
        <div style={STYLE.grid}>
          <div style={STYLE.viewerFrame}>
            <Room3D imageUrl={imageUrl} />
          </div>
          <div style={{ height: '68vh', minHeight: 420 }}>
            <RoomAnalysis imageUrl={imageUrl} />
          </div>
        </div>
      )}
    </div>
  )
}
