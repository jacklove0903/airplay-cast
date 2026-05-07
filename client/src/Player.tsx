import { useRef, useEffect, useState, useCallback } from 'react'

interface PlayerProps {
  ws: WebSocket | null
  streaming: boolean
}

export default function Player({ ws, streaming }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [connected, setConnected] = useState(false)

  const startWebRTC = useCallback(async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const pc = new RTCPeerConnection({
      iceServers: [],
    })

    pc.ontrack = (event) => {
      if (videoRef.current && event.streams[0]) {
        videoRef.current.srcObject = event.streams[0]
        setConnected(true)
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        ws.send(JSON.stringify({ type: 'ice-candidate', data: event.candidate }))
      }
    }

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] State:', pc.connectionState)
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setConnected(false)
      }
    }

    pcRef.current = pc

    // Request offer from server
    ws.send(JSON.stringify({ type: 'start' }))
  }, [ws])

  // Handle WebSocket messages for WebRTC signaling
  useEffect(() => {
    if (!ws) return

    const handleMessage = async (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data)
        const pc = pcRef.current

        switch (msg.type) {
          case 'offer': {
            if (!pc) break
            await pc.setRemoteDescription(new RTCSessionDescription(msg.data))
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            ws.send(JSON.stringify({ type: 'answer', data: answer }))
            break
          }
          case 'ice-candidate': {
            if (!pc) break
            await pc.addIceCandidate(new RTCIceCandidate(msg.data))
            break
          }
        }
      } catch (err) {
        console.error('[Player] Signaling error:', err)
      }
    }

    ws.addEventListener('message', handleMessage)
    return () => ws.removeEventListener('message', handleMessage)
  }, [ws])

  // Auto-start when streaming begins
  useEffect(() => {
    if (streaming && ws && !pcRef.current) {
      startWebRTC()
    }
  }, [streaming, ws, startWebRTC])

  // Reset WebRTC when WebSocket reconnects
  useEffect(() => {
    return () => {
      pcRef.current?.close()
      pcRef.current = null
    }
  }, [ws])

  // Cleanup when stream ends
  useEffect(() => {
    if (!streaming) {
      pcRef.current?.close()
      pcRef.current = null
      setConnected(false)
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
    }
  }, [streaming])

  // Fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen()
      setFullscreen(true)
    } else {
      document.exitFullscreen()
      setFullscreen(false)
    }
  }, [])

  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  return (
    <div ref={containerRef} className={`video-container ${fullscreen ? 'fullscreen' : ''}`}>
      {streaming && connected ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          controls={false}
          onDoubleClick={toggleFullscreen}
        />
      ) : (
        <div className="waiting">
          <div className="waiting-icon">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
              <path d="M9 10l3-3 3 3" opacity="0.5" />
            </svg>
          </div>
          <p>
            {streaming ? '正在建立连接...' : '等待 iOS 设备投屏'}
          </p>
          <p className="hint">
            在 iPhone 控制中心 → 屏幕镜像 → 选择 "AirPlay Cast"
          </p>
          {streaming && !connected && (
            <button className="btn primary" onClick={startWebRTC}>
              手动连接
            </button>
          )}
        </div>
      )}

      {connected && (
        <div className="controls">
          <button className="btn" onClick={toggleFullscreen}>
            {fullscreen ? '退出全屏' : '全屏'}
          </button>
        </div>
      )}
    </div>
  )
}
