import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift'
import { EventEmitter } from 'events'

export class WebRTCBridge extends EventEmitter {
  private pc: RTCPeerConnection | null = null
  private videoTrack: any = null
  private nalBuffer: Buffer[] = []
  private frameTimestamp = 0
  private sendInterval: NodeJS.Timeout | null = null

  constructor() {
    super()
  }

  async createOffer(): Promise<{ sdp: string; type: string }> {
    this.pc = new RTCPeerConnection({
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: 'video/H264',
            clockRate: 90000,
            payloadType: 96,
          }),
        ],
      },
    })

    // Add transceiver for sending video
    const transceiver = this.pc.addTransceiver('video', { direction: 'sendonly' })
    this.videoTrack = transceiver.sender

    // Handle ICE candidates
    this.pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) {
        this.emit('ice-candidate', candidate)
      }
    })

    this.pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Connection state: ${this.pc?.connectionState}`)
      this.emit('connection-state', this.pc?.connectionState)
    }

    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)

    return {
      sdp: offer.sdp!,
      type: offer.type!,
    }
  }

  async handleAnswer(sdp: string, type: string) {
    if (!this.pc) return
    await this.pc.setRemoteDescription({ sdp, type: type as RTCSdpType })
    console.log('[WebRTC] Remote description set')
  }

  async addIceCandidate(candidate: any) {
    if (!this.pc) return
    await this.pc.addIceCandidate(candidate)
  }

  // Feed H.264 NAL units into the WebRTC track
  feedNALUnits(nalUnits: Buffer[], info: { timestamp: number; marker: number }) {
    if (!this.pc || this.pc.connectionState !== 'connected') return

    // Buffer NAL units and send as a frame
    for (const nal of nalUnits) {
      // Add start code prefix for the RTP sender
      const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01])
      const frame = Buffer.concat([startCode, nal])
      this.nalBuffer.push(frame)
    }

    // Send on marker bit (end of frame)
    if (info.marker && this.nalBuffer.length > 0) {
      const fullFrame = Buffer.concat(this.nalBuffer)
      this.nalBuffer = []

      // Use RTCPeerConnection's RTP sender
      // werift uses track.writeRtp or sender.sendRtp
      try {
        if (this.videoTrack?.track) {
          this.frameTimestamp = info.timestamp
          this.videoTrack.track.writeRtp(fullFrame)
        }
      } catch (err) {
        // Silently ignore RTP send errors
      }
    }
  }

  close() {
    if (this.sendInterval) {
      clearInterval(this.sendInterval)
      this.sendInterval = null
    }
    this.pc?.close()
    this.pc = null
    this.videoTrack = null
    this.nalBuffer = []
    console.log('[WebRTC] Connection closed')
  }
}
