import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// NOTE: intentionally no <React.StrictMode> here — this is a test harness.
// (Room3D is still StrictMode-safe: its effects are ref-guarded and cleanup is complete.)
createRoot(document.getElementById('root')).render(<App />)
