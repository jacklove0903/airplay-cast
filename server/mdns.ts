import { Bonjour, Service } from 'bonjour-service'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEVICE_ID_FILE = path.join(__dirname, '..', '.device-id')

export class MDNSAdvertiser {
  private bonjour: Bonjour | null = null
  private service: Service | null = null

  advertise(name: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.bonjour = new Bonjour()

      // Only advertise features we actually support:
      // bit 0: Video
      // bit 7: Photo
      // bit 25: Screen mirroring
      const features = '0x2000081,0x0'

      this.service = this.bonjour.publish({
        name,
        type: 'airplay',
        port,
        txt: {
          deviceid: this.getDeviceId(),
          features,
          model: 'AppleTV2,1',
          srcvers: '220.68',
          flags: '0x44',
          vv: '2',
        },
      })

      this.service.on('up', () => {
        console.log(`[mDNS] AirPlay service published: "${name}" on port ${port}`)
        console.log(`[mDNS] Device ID: ${this.getDeviceId()}`)
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

  private getDeviceId(): string {
    // Try to load persisted device ID
    try {
      if (fs.existsSync(DEVICE_ID_FILE)) {
        const id = fs.readFileSync(DEVICE_ID_FILE, 'utf-8').trim()
        if (id && /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(id)) {
          return id
        }
      }
    } catch {
      // ignore read errors
    }

    // Generate and persist a new device ID
    const id = this.generateDeviceId()
    try {
      fs.writeFileSync(DEVICE_ID_FILE, id, 'utf-8')
    } catch {
      // ignore write errors (e.g. permission issues)
    }
    return id
  }

  private generateDeviceId(): string {
    const bytes = Array.from({ length: 6 }, () =>
      Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
    )
    return bytes.join(':').toUpperCase()
  }
}
