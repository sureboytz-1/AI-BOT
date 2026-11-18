import express from 'express'
import authRouter from './auth/router'
import { API_KEY } from './config/config'
import { errorHandler } from './util/handler'
import { getGroupData, logout, printQR, status } from './whatsapp/controller'
import whatsappRouter from './whatsapp/router'

const app = express()

app.use(express.json())

// public endpoint for Render health checks
app.get('/health', (_req, res) => res.json({ ok: true }))

// every other endpoint needs the API key (header x-api-key or ?key=)
app.use((req, res, next) => {
    if (!API_KEY) return next()

    const provided = req.header('x-api-key') || (req.query.key as string)
    if (provided === API_KEY) return next()

    return res.status(401).json({ data: 'unauthorized' })
})

app.get('/status', status)
app.get('/qr-code', printQR)
app.delete('/logout', logout)

app.get('/group/:id', getGroupData)

app.use('/send', whatsappRouter)
app.use('/auth', authRouter)

app.use(errorHandler)

export default app
