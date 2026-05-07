import { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack, RtpPacket, RtpHeader } from 'werift'
import { EventEmitter } from 'events'

export class WebRTCBridge extends EventEmitter {
  private pc: RTCPeerConnection | null = null
  private videoTrack: MediaStreamTrack | null = null
  private seqNumber = 0
  private timestamp = 0
  private ssrc = 0

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

    // Create a MediaStreamTrack for sending
    this.videoTrack = new MediaStreamTrack({ kind: 'video' })
    const transceiver = this.pc.addTransceiver(this.videoTrack, { direction: 'sendonly' })
    this.ssrc = transceiver.sender.ssrc

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

  // Feed H.264 NAL units into the WebRTC track as RTP packets
  feedNALUnits(nalUnits: Buffer[], info: { timestamp: number; marker: number }) {
    if (!this.pc || this.pc.connectionState !== 'connected' || !this.videoTrack) return

    // 90kHz clock: ~3000 ticks per frame at 30fps
    this.timestamp += 3000

    for (let i = 0; i < nalUnits.length; i++) {
      let nal = nalUnits[i]

      // Strip start code prefix if present (annex-B format)
      if (nal.length >= 4 && nal[0] === 0x00 && nal[1] === 0x00) {
        if (nal[2] === 0x00 && nal[3] === 0x01) {
          nal = nal.subarray(4)
        } else if (nal[2] === 0x01) {
          nal = nal.subarray(3)
        }
      }

      const isLast = i === nalUnits.length - 1
      const header = new RtpHeader({
        payloadType: 96,
        sequenceNumber: this.seqNumber++,
        timestamp: this.timestamp,
        ssrc: this.ssrc,
        marker: isLast,
      })

      try {
        this.videoTrack.writeRtp(new RtpPacket(header, nal))
      } catch (err) {
        console.error('[WebRTC] writeRtp error:', err)
      }
    }
  }

  close() {
    this.pc?.close()
    this.pc = null
    this.videoTrack = null
    this.seqNumber = 0
    this.timestamp = 0
    console.log('[WebRTC] Connection closed')
  }
}
