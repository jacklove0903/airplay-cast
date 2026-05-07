import net from 'net'
import dgram from 'dgram'
import crypto from 'crypto'
import { EventEmitter } from 'events'

export interface StreamInfo {
  width: number
  height: number
  fps: number
  videoPort: number
  audioPort: number
}

export class AirPlayServer extends EventEmitter {
  private server: net.Server | null = null
  private aesKey: Buffer | null = null
  private aesIV: Buffer | null = null
  private streamInfo: StreamInfo | null = null
  private rtspSession: string = ''
  private controlPort: number
  private videoPort: number
  private audioPort: number
  private fuBuffer: Buffer[] = []
  private udpSockets: dgram.Socket[] = []
  private rtspState: 'init' | 'announced' | 'setup' | 'recording' = 'init'

  private static readonly MAX_BUFFER_SIZE = 1024 * 1024 // 1MB

  constructor(controlPort = 7100) {
    super()
    this.controlPort = controlPort
    this.videoPort = controlPort + 1
    this.audioPort = controlPort + 2
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket)
      })

      this.server.on('error', (err) => {
        this.emit('error', err)
        reject(err)
      })

      this.server.listen(this.controlPort, () => {
        console.log(`[RTSP] AirPlay server listening on port ${this.controlPort}`)
        console.log(`[RTSP] Video RTP on port ${this.videoPort}, Audio RTP on port ${this.audioPort}`)
        this.emit('ready')
        resolve()
      })
    })
  }

  stop() {
    this.server?.close()
    this.server = null
    for (const sock of this.udpSockets) {
      try { sock.close() } catch {}
    }
    this.udpSockets = []
    this.fuBuffer = []
  }

  private handleConnection(socket: net.Socket) {
    let buffer = Buffer.alloc(0)
    const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`
    console.log(`[RTSP] Client connected: ${clientAddr}`)
    this.fuBuffer = []
    this.rtspState = 'init'
    this.emit('client-connected', clientAddr)

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data])

      // Prevent unbounded buffer growth
      if (buffer.length > AirPlayServer.MAX_BUFFER_SIZE) {
        console.error('[RTSP] Buffer overflow, resetting connection')
        socket.destroy()
        return
      }

      // Parse RTSP message(s) from buffer
      while (true) {
        const result = this.parseRTSP(buffer)
        if (!result) break

        const { request, consumed } = result
        buffer = buffer.subarray(consumed)

        const response = this.handleRequest(request, socket)
        if (response) {
          socket.write(response)
        }
      }
    })

    socket.on('close', () => {
      console.log(`[RTSP] Client disconnected: ${clientAddr}`)
      this.emit('client-disconnected', clientAddr)
    })

    socket.on('error', (err) => {
      console.error(`[RTSP] Socket error: ${err.message}`)
    })
  }

  private parseRTSP(buffer: Buffer): { request: RTSPRequest; consumed: number } | null {
    const str = buffer.toString('utf-8')

    // Find end of headers (double CRLF)
    const headerEnd = str.indexOf('\r\n\r\n')
    if (headerEnd === -1) return null

    const headerSection = str.substring(0, headerEnd)
    const lines = headerSection.split('\r\n')

    // Parse request line: METHOD rtsp://host/path RTSP/1.0
    const requestLine = lines[0]
    const [method, uri, version] = requestLine.split(' ')

    // Parse headers
    const headers: Record<string, string> = {}
    for (let i = 1; i < lines.length; i++) {
      const colonIdx = lines[i].indexOf(':')
      if (colonIdx > 0) {
        const key = lines[i].substring(0, colonIdx).trim()
        const value = lines[i].substring(colonIdx + 1).trim()
        headers[key.toLowerCase()] = value
      }
    }

    // Check for body (Content-Length)
    let body = ''
    const contentLength = parseInt(headers['content-length'] || '0', 10)
    const bodyStart = headerEnd + 4

    if (contentLength > 0) {
      if (buffer.length < bodyStart + contentLength) return null // Need more data
      body = buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf-8')
    }

    const consumed = bodyStart + contentLength

    return {
      request: { method, uri, version, headers, body },
      consumed,
    }
  }

  private handleRequest(req: RTSPRequest, socket: net.Socket): string | null {
    const cseq = req.headers['cseq'] || '1'
    console.log(`[RTSP] ${req.method} ${req.uri} (CSeq: ${cseq})`)

    // OPTIONS is always allowed
    if (req.method !== 'OPTIONS' && req.method !== 'GET_PARAMETER') {
      // Validate RTSP method ordering
      const validTransition = this.isValidTransition(req.method)
      if (!validTransition) {
        console.warn(`[RTSP] Invalid state transition: ${req.method} in state ${this.rtspState}`)
        return this.buildResponse(cseq, 455, 'Method Not Valid In This State')
      }
    }

    switch (req.method) {
      case 'OPTIONS':
        return this.handleOptions(cseq)
      case 'ANNOUNCE':
        return this.handleAnnounce(cseq, req)
      case 'SETUP':
        return this.handleSetup(cseq, req, socket)
      case 'RECORD':
        return this.handleRecord(cseq, req)
      case 'FLUSH':
        return this.handleFlush(cseq, req)
      case 'TEARDOWN':
        return this.handleTeardown(cseq)
      case 'SET_PARAMETER':
        return this.handleSetParameter(cseq, req)
      case 'GET_PARAMETER':
        return this.handleGetParameter(cseq)
      default:
        console.log(`[RTSP] Unknown method: ${req.method}`)
        return this.buildResponse(cseq, 400, 'Bad Request')
    }
  }

  private isValidTransition(method: string): boolean {
    switch (method) {
      case 'ANNOUNCE':
        return this.rtspState === 'init'
      case 'SETUP':
        return this.rtspState === 'announced' || this.rtspState === 'setup'
      case 'RECORD':
        return this.rtspState === 'setup'
      case 'FLUSH':
      case 'SET_PARAMETER':
        return this.rtspState === 'recording'
      case 'TEARDOWN':
        return this.rtspState !== 'init'
      default:
        return true
    }
  }

  private handleOptions(cseq: string): string {
    return this.buildResponse(cseq, 200, 'OK', {
      'Public': 'ANNOUNCE, SETUP, RECORD, PAUSE, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER',
    })
  }

  private handleAnnounce(cseq: string, req: RTSPRequest): string {
    console.log('[RTSP] ANNOUNCE - Stream parameters:')
    const sdp = req.body

    // Parse stream info from SDP
    const widthMatch = sdp.match(/x-dimensions:(\d+),(\d+)/)
    const fpsMatch = sdp.match(/x-framerate:(\d+)/)

    if (widthMatch) {
      this.streamInfo = {
        width: parseInt(widthMatch[1]),
        height: parseInt(widthMatch[2]),
        fps: fpsMatch ? parseInt(fpsMatch[1]) : 30,
        videoPort: this.videoPort,
        audioPort: this.audioPort,
      }
      console.log(`[RTSP] Resolution: ${this.streamInfo.width}x${this.streamInfo.height} @ ${this.streamInfo.fps}fps`)
    }

    this.emit('stream-announced', this.streamInfo)
    this.rtspState = 'announced'
    return this.buildResponse(cseq, 200, 'OK')
  }

  private handleSetup(cseq: string, req: RTSPRequest, socket: net.Socket): string {
    this.rtspSession = crypto.randomBytes(16).toString('hex')

    // Extract AES key from transport header
    const transport = req.headers['transport'] || ''
    console.log(`[RTSP] SETUP transport: ${transport}`)

    // Parse server_port from transport
    let serverPort = this.videoPort
    if (req.uri.includes('audio')) {
      serverPort = this.audioPort
    }

    // Look for AES key in headers
    const destInline = req.headers['x-dest-inline']
    if (destInline) {
      const keyIv = Buffer.from(destInline, 'base64')
      this.aesKey = keyIv.subarray(0, 16)
      this.aesIV = keyIv.subarray(16, 32)
      console.log(`[RTSP] AES key received (${this.aesKey.length} bytes)`)
      this.emit('aes-key', this.aesKey, this.aesIV)
    }

    // Start UDP listeners for video/audio RTP
    if (req.uri.includes('audio')) {
      this.startRTPListener('audio', this.audioPort)
    } else {
      this.startRTPListener('video', this.videoPort)
    }

    this.rtspState = 'setup'

    return this.buildResponse(cseq, 200, 'OK', {
      'Transport': `RTP/AVP/UDP;unicast;mode=record;server_port=${serverPort};control_port=${this.controlPort}`,
      'Session': this.rtspSession,
      'Audio-Jack-Type': 'digital',
    })
  }

  private handleRecord(cseq: string, req: RTSPRequest): string {
    console.log('[RTSP] RECORD - Stream starting')
    this.rtspState = 'recording'
    this.emit('stream-start', this.streamInfo)
    return this.buildResponse(cseq, 200, 'OK', {
      'Session': this.rtspSession,
      'RTP-Info': 'seq=1;rtptime=0',
    })
  }

  private handleFlush(cseq: string, req: RTSPRequest): string {
    console.log('[RTSP] FLUSH')
    return this.buildResponse(cseq, 200, 'OK', {
      'Session': this.rtspSession,
      'RTP-Info': 'seq=1;rtptime=0',
    })
  }

  private handleTeardown(cseq: string): string {
    console.log('[RTSP] TEARDOWN - Stream ending')
    this.rtspState = 'init'
    this.emit('stream-end')
    return this.buildResponse(cseq, 200, 'OK')
  }

  private handleSetParameter(cseq: string, req: RTSPRequest): string {
    const body = req.body.trim()
    if (body.startsWith('volume:')) {
      const volume = parseFloat(body.substring(7).trim())
      if (!isNaN(volume)) {
        console.log(`[RTSP] Volume set to ${volume}`)
        this.emit('volume-change', volume)
      }
    }
    return this.buildResponse(cseq, 200, 'OK', {
      'Session': this.rtspSession,
    })
  }

  private handleGetParameter(cseq: string): string {
    return this.buildResponse(cseq, 200, 'OK', {
      'Session': this.rtspSession,
    })
  }

  private buildResponse(cseq: string, code: number, message: string, headers: Record<string, string> = {}): string {
    let resp = `RTSP/1.0 ${code} ${message}\r\n`
    resp += `CSeq: ${cseq}\r\n`
    for (const [key, value] of Object.entries(headers)) {
      resp += `${key}: ${value}\r\n`
    }
    resp += '\r\n'
    return resp
  }

  // --- RTP Listener ---

  private startRTPListener(type: 'video' | 'audio', port: number) {
    const udpSocket = dgram.createSocket('udp4')
    this.udpSockets.push(udpSocket)

    udpSocket.on('message', (msg: Buffer) => {
      if (type === 'video') {
        this.processVideoRTP(msg)
      } else {
        this.processAudioRTP(msg)
      }
    })

    udpSocket.on('error', (err) => {
      console.error(`[RTP] ${type} socket error: ${err.message}`)
    })

    udpSocket.bind(port, () => {
      console.log(`[RTP] ${type} listener bound to port ${port}`)
    })
  }

  private processVideoRTP(packet: Buffer) {
    // RTP header parsing
    const version = (packet[0] >> 6) & 0x03
    const hasPadding = (packet[0] >> 5) & 0x01
    const hasExtension = (packet[0] >> 4) & 0x01
    const csrcCount = packet[0] & 0x0f
    const marker = (packet[1] >> 7) & 0x01
    const seqNum = packet.readUInt16BE(2)
    const timestamp = packet.readUInt32BE(4)
    const ssrc = packet.readUInt32BE(8)

    const headerLen = 12 + csrcCount * 4
    let payloadOffset = headerLen
    let iv = this.aesIV

    // Parse RTP extension header (contains the AES IV)
    if (hasExtension) {
      const extHeaderOffset = headerLen
      if (packet.length > extHeaderOffset + 4) {
        // Extension header: 2 bytes type, 2 bytes length
        const extLength = packet.readUInt16BE(extHeaderOffset + 2) * 4
        payloadOffset = extHeaderOffset + 4 + extLength

        // Extract IV from extension data
        if (extLength >= 16) {
          iv = packet.subarray(extHeaderOffset + 4, extHeaderOffset + 20)
        }
      }
    }

    if (payloadOffset >= packet.length) return

    let payload = packet.subarray(payloadOffset)

    // Decrypt if AES key is available
    if (this.aesKey && iv) {
      try {
        const decipher = crypto.createDecipheriv('aes-128-ctr', this.aesKey, iv)
        payload = Buffer.concat([decipher.update(payload), decipher.final()])
      } catch {
        // If decryption fails, use raw payload (might be unencrypted)
      }
    }

    // Extract H.264 NAL units from payload
    const nalUnits = this.extractNALUnits(payload)
    if (nalUnits.length > 0) {
      this.emit('video-data', nalUnits, { timestamp, seqNum, marker })
    }
  }

  private processAudioRTP(packet: Buffer) {
    // Basic audio RTP handling - skip for MVP
    const headerLen = 12
    if (packet.length <= headerLen) return
    const payload = packet.subarray(headerLen)
    this.emit('audio-data', payload)
  }

  private extractNALUnits(payload: Buffer): Buffer[] {
    const units: Buffer[] = []
    let offset = 0

    while (offset < payload.length) {
      // Check for annex-B start code (0x00000001 or 0x000001)
      if (offset + 3 < payload.length && payload[offset] === 0x00 && payload[offset + 1] === 0x00) {
        let startCodeLen = 0
        if (payload[offset + 2] === 0x00 && offset + 3 < payload.length && payload[offset + 3] === 0x01) {
          startCodeLen = 4
        } else if (payload[offset + 2] === 0x01) {
          startCodeLen = 3
        }

        if (startCodeLen > 0) {
          offset += startCodeLen
          let end = offset
          while (end < payload.length) {
            if (end + 3 < payload.length && payload[end] === 0x00 && payload[end + 1] === 0x00) {
              if ((payload[end + 2] === 0x00 && end + 3 < payload.length && payload[end + 3] === 0x01) || payload[end + 2] === 0x01) {
                break
              }
            }
            end++
          }
          units.push(payload.subarray(offset, end))
          offset = end
          continue
        }
      }

      // RTP-style NAL handling
      const nalType = payload[offset] & 0x1f

      if (nalType >= 1 && nalType <= 23) {
        // Single NAL unit
        units.push(payload.subarray(offset))
        break
      } else if (nalType === 28) {
        // FU-A fragmented NAL
        if (offset + 2 >= payload.length) break

        const fuIndicator = payload[offset]
        const fuHeader = payload[offset + 1]
        const startBit = (fuHeader >> 7) & 0x01
        const endBit = (fuHeader >> 6) & 0x01
        const nalTypeFu = fuHeader & 0x1f
        const nalData = payload.subarray(offset + 2)

        if (startBit) {
          // Reconstruct NAL header: keep NRI bits from indicator, replace type
          const nalHeader = (fuIndicator & 0xe0) | nalTypeFu
          this.fuBuffer = [Buffer.from([nalHeader]), nalData]
        } else if (this.fuBuffer.length > 0) {
          // Middle or end fragment — append data
          this.fuBuffer.push(nalData)
        }

        if (endBit && this.fuBuffer.length > 0) {
          // Final fragment — emit complete NAL unit
          units.push(Buffer.concat(this.fuBuffer))
          this.fuBuffer = []
        }

        break
      } else {
        // Unknown NAL type, skip
        break
      }
    }

    return units
  }
}

interface RTSPRequest {
  method: string
  uri: string
  version: string
  headers: Record<string, string>
  body: string
}
