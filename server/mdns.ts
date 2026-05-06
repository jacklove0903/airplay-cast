import { Bonjour, Service } from 'bonjour-service'

export class MDNSAdvertiser {
  private bonjour: Bonjour | null = null
  private service: Service | null = null

  advertise(name: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.bonjour = new Bonjour()

      // AirPlay feature flags (bitmask)
      // Supports video, photo, videoFairPlay, videoVolumeControl, etc.
      const features = '0x5A7FFFF7,0x1E' // AirPlay 1 + basic features

      this.service = this.bonjour.publish({
        name,
        type: 'airplay',
        port,
        txt: {
          deviceid: this.generateDeviceId(),
          features,
          model: 'AppleTV2,1',
          srcvers: '220.68',
          flags: '0x44',
          vv: '2',
        },
      })

      this.service.on('up', () => {
        console.log(`[mDNS] AirPlay service published: "${name}" on port ${port}`)
        resolve()
      })

      this.service.on('error', (err: Error) => {
        console.error(`[mDNS] Error: ${err.message}`)
        reject(err)
      })
    })
  }

  stop() {
    ;(this.service as any)?.stop()
    this.bonjour?.destroy()
    this.service = null
    this.bonjour = null
    console.log('[mDNS] Service stopped')
  }

  private generateDeviceId(): string {
    // Generate a random MAC-style device ID
    const bytes = Array.from({ length: 6 }, () =>
      Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
    )
    return bytes.join(':').toUpperCase()
  }
}
