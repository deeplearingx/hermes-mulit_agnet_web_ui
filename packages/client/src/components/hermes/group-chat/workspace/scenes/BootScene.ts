// ─── Boot Scene ─────────────────────────────────────────────
// Preloads all workspace assets before handing off to GroupOfficeScene.

import Phaser from 'phaser'
import { loadWorkspaceAssets } from './AssetManifest'

export class BootScene extends Phaser.Scene {
    constructor() {
        super({ key: 'BootScene' })
    }

    preload() {
        // Loading bar
        const w = this.cameras.main.width
        const h = this.cameras.main.height

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

        // Bug 4 fix: handle individual file load errors gracefully
        this.load.on('loaderror', (file: Phaser.Loader.File) => {
            console.warn(`[BootScene] Failed to load asset: ${file.key} (${file.url}), continuing without it`)
        })

        // Load all workspace assets
        loadWorkspaceAssets(this)
    }

    create() {
        // Bug 6 fix: emit drag enable after scene is fully ready
        this.scene.start('GroupOfficeScene')
        // Small delay to ensure GroupOfficeScene.create() has run
        this.time.delayedCall(100, () => {
            window.dispatchEvent(new CustomEvent('workspace:drag:enable', {
                detail: { enabled: true },
            }))
        })
    }
}
