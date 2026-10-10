import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { registerServiceWorker } from './share'

registerServiceWorker()

createRoot(document.getElementById('root')).render(<App />)
