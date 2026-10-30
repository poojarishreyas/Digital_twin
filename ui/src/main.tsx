import React from 'react'
import {createRoot} from 'react-dom/client'
import './styles.css'
import {AuthShell} from './auth'
import {App} from './App'

createRoot(document.getElementById('root')!).render(<React.StrictMode><AuthShell><App/></AuthShell></React.StrictMode>)
