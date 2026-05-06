import { useState, useEffect, useRef, useCallback } from 'react'
import Player from './Player'

interface AppState {
  streaming: boolean
  clientAddress: string | null
  streamInfo: { width: number; height: number; fps: number } | null
  connectionState: string
}

export default function App() {
  const [state, setState] = useState<AppState>({
    streaming: false,
    clientAddress: null,
    streamInfo: null,
    connectionState: 'new',
  })

  const wsRef = useRef<WebSocket | null>(null)

  const connectWS = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

    ws.onopen = () => {
      console.log('[WS] Connected')
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        switch (msg.type) {
          case 'state':
            setState((prev) => ({ ...prev, ...msg.data }))
            break
          case 'connection-state':
            setState((prev) => ({ ...prev, connectionState: msg.data }))
            break
        }
      } catch {}
    }

    ws.onclose = () => {
      console.log('[WS] Disconnected, reconnecting in 2s...')
      setTimeout(connectWS, 2000)
    }

    ws.onerror = () => {
      ws.close()
    }

    wsRef.current = ws
  }, [])

  useEffect(() => {
    connectWS()
    return () => wsRef.current?.close()
  }, [connectWS])

  return (
    <div className="app">
      <header className="header">
        <h1>
          <span>AirPlay</span> Cast
        </h1>
        <div className="status-bar">
          <div className={`status-dot ${state.streaming ? 'active' : ''}`} />
          <span>{state.streaming ? '投屏中' : '等待连接'}</span>
        </div>
      </header>

      <main className="main">
        <Player ws={wsRef.current} streaming={state.streaming} />

        {state.streaming && state.streamInfo && (
          <div className="stream-info">
            <div>
              <span className="label">分辨率 </span>
              <span className="value">
                {state.streamInfo.width} x {state.streamInfo.height}
              </span>
            </div>
            <div>
              <span className="label">帧率 </span>
              <span className="value">{state.streamInfo.fps} fps</span>
            </div>
            {state.clientAddress && (
              <div>
                <span className="label">设备 </span>
                <span className="value">{state.clientAddress}</span>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
