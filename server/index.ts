import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { AirPlayServer } from './rtsp.js'
import { MDNSAdvertiser } from './mdns.js'
import { WebRTCBridge } from './webrtc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = 3000
const AIRPLAY_PORT = 7100
const DEVICE_NAME = 'AirPlay Cast'

// --- State ---
const state = {
  streaming: false,
  clientAddress: null as string | null,
  streamInfo: null as any,
}

// --- Express + WebSocket ---
const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

// Serve static files (built frontend for production)
const clientDir = path.join(__dirname, '..', 'dist', 'client')
app.use(express.static(clientDir))

// API endpoints
app.get('/api/status', (_req, res) => {
  res.json(state)
})

// --- WebSocket Signaling ---
const clients = new Set<WebSocket>()

wss.on('connection', (ws) => {
  clients.add(ws)
  console.log(`[WS] Client connected (${clients.size} total)`)

  // Send current state
  ws.send(JSON.stringify({ type: 'state', data: state }))

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      handleSignaling(ws, msg)
    } catch {
      // ignore invalid messages
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    console.log(`[WS] Client disconnected (${clients.size} total)`)
  })
})

function broadcast(msg: object) {
  const data = JSON.stringify(msg)
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}

// --- WebRTC per-client connections ---
const bridges = new Map<WebSocket, WebRTCBridge>()

async function handleSignaling(ws: WebSocket, msg: any) {
  try {
    switch (msg.type) {
      case 'start': {
        // Client wants to start receiving video
        let bridge = bridges.get(ws)
        if (!bridge) {
          bridge = new WebRTCBridge()
          bridges.set(ws, bridge)

          bridge.on('ice-candidate', (candidate) => {
            ws.send(JSON.stringify({ type: 'ice-candidate', data: candidate }))
          })

          bridge.on('connection-state', (connState) => {
            ws.send(JSON.stringify({ type: 'connection-state', data: connState }))
          })
        }

        const offer = await bridge.createOffer()
        ws.send(JSON.stringify({ type: 'offer', data: offer }))
        break
      }

      case 'answer': {
        const bridge = bridges.get(ws)
        if (bridge) {
          await bridge.handleAnswer(msg.data.sdp, msg.data.type)
        }
        break
      }

      case 'ice-candidate': {
        const bridge = bridges.get(ws)
        if (bridge) {
          await bridge.addIceCandidate(msg.data)
        }
        break
      }
    }
  } catch (err) {
    console.error('[Signaling] Error:', err)
  }
}

// --- AirPlay Server ---
const airplay = new AirPlayServer(AIRPLAY_PORT)

airplay.on('stream-start', (info) => {
  state.streaming = true
  state.streamInfo = info
  broadcast({ type: 'state', data: state })
  console.log('[Server] Stream started')
})

airplay.on('stream-end', () => {
  state.streaming = false
  state.streamInfo = null
  broadcast({ type: 'state', data: state })
  console.log('[Server] Stream ended')
})

airplay.on('video-data', (nalUnits, info) => {
  // Forward video data to all connected WebRTC clients
  for (const bridge of bridges.values()) {
    bridge.feedNALUnits(nalUnits, info)
  }
})

airplay.on('client-connected', (addr) => {
  state.clientAddress = addr
  broadcast({ type: 'state', data: state })
})

airplay.on('client-disconnected', () => {
  state.clientAddress = null
  broadcast({ type: 'state', data: state })
})

// --- mDNS Advertisement ---
const mdns = new MDNSAdvertiser()

// --- Start ---
async function main() {
  try {
    // Start AirPlay RTSP server
    await airplay.start()

    // Advertise via mDNS
    await mdns.advertise(DEVICE_NAME, AIRPLAY_PORT)

    // Start HTTP/WebSocket server
    server.listen(PORT, () => {
      console.log(`[Server] HTTP server at http://localhost:${PORT}`)
      console.log('[Server] Waiting for iOS device to connect...')
      console.log(`[Server] Open http://localhost:${PORT} in your browser`)
    })
  } catch (err) {
    console.error('[Server] Failed to start:', err)
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...')
  mdns.stop()
  airplay.stop()
  for (const bridge of bridges.values()) {
    bridge.close()
  }
  server.close()
  process.exit(0)
})

main()
