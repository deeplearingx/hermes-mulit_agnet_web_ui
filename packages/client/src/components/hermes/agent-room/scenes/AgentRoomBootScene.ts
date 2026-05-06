// ─── Agent Room Boot Scene ────────────────────────────────────
// Preloads all workspace assets before handing off to AgentRoomOfficeScene.
// Load failures are logged as warnings and do not block scene transition.

import Phaser from 'phaser'
import { loadAgentRoomAssets } from './AgentRoomAssetManifest'

export class AgentRoomBootScene extends Phaser.Scene {
    private instanceId: string

    constructor(instanceId: string) {
        super({ key: 'AgentRoomBootScene' })
        this.instanceId = instanceId
    }

    preload() {
        const w = this.cameras.main.width
        const h = this.cameras.main.height

        // Loading bar
        const barBg = this.add.graphics()
        barBg.fillStyle(0x1e293b, 0.8)
        barBg.fillRect(w / 2 - 100, h / 2 - 10, 200, 20)

        const bar = this.add.graphics()

        this.load.on('progress', (value: number) => {
            bar.clear()
            bar.fillStyle(0x3b82f6, 1)
            bar.fillRect(w / 2 - 98, h / 2 - 8, 196 * value, 16)
        })

        this.load.on('complete', () => {
            bar.destroy()
            barBg.destroy()
        })

        // Handle individual file load errors gracefully — warn and continue
        this.load.on('loaderror', (file: Phaser.Loader.File) => {
            console.warn(`[AgentRoomBootScene] Failed to load asset: ${file.key} (${file.url}), continuing without it`)
        })

        // Load all Agent Room workspace assets
        loadAgentRoomAssets(this)
    }

    create() {
        // Acknowledge instanceId for future use (e.g. scene-level event scoping)
        void this.instanceId
        // Start the office scene — instanceId is injected via constructor in AgentRoomWorkspace
        this.scene.start('AgentRoomOfficeScene')
    }
}
