// ─── Group Office Scene ──────────────────────────────────────
// Phaser scene that renders a pixel-art office with agent workstations.
// Uses real pixel assets from group_assets/ loaded via BootScene.

import Phaser from 'phaser'
import type { AgentWorkspaceState, AgentWorkStatus } from '../runtime/types'
import { DEFAULT_SEATS, ZONE_COLORS, STATUS_VISUALS } from '../runtime/types'
import { agentColor } from '../runtime/agent-state'

const SCENE_W = 720
const SCENE_H = 560
const TILE = 16

// ─── Color constants ────────────────────────────────────────
const C = {
    floor:       0x0f1729,
    floorGrid:   0x1a2744,
    wall:        0x1e293b,
    wallTop:     0x334155,
    labelBg:     0x000000,
    labelText:   0xe2e8f0,
    bubbleBg:    0x1e293b,
    bubbleBorder:0x475569,
}

/** Status → icon texture key mapping */
const STATUS_ICON_MAP: Record<AgentWorkStatus, string | null> = {
    idle: null,
    compressing: 'item_life_pot',
    replying: 'item_scroll',
    thinking: 'item_heart',
    calling_tool: 'weapon_hammer',
    completed: 'item_gold_coin',
    failed: 'fx_fail',
}

/** Status → tint color for the icon */
const STATUS_TINT_MAP: Record<AgentWorkStatus, number> = {
    idle: 0x6b7280,
    compressing: 0xf59e0b,
    replying: 0x3b82f6,
    thinking: 0xa855f7,
    calling_tool: 0x8b5cf6,
    completed: 0x22c55e,
    failed: 0xef4444,
}

export class GroupOfficeScene extends Phaser.Scene {
    private agentSprites: Map<string, Phaser.GameObjects.Container> = new Map()
    private agentBubbles: Map<string, Phaser.GameObjects.Container> = new Map()
    private agentIcons: Map<string, Phaser.GameObjects.Image> = new Map()
    private agentStates: Map<string, AgentWorkspaceState> = new Map()
    private selectedAgentId: string | null = null
    private pulseTimers: Map<string, Phaser.Time.TimerEvent> = new Map()
    private idleTweens: Map<string, Phaser.Tweens.Tween> = new Map()
    private dragEnabled = false

    constructor() {
        super({ key: 'GroupOfficeScene' })
    }

    create() {
        this.drawFloor()
        this.drawWalls()
        this.drawZones()
        this.drawFurniture()
        this.drawZoneDecorations()

        // Environment animations
        this.addScanline()
        this.addFloatingParticles()
        this.addMonitorAnimations()
        this.addZonePulse()
        this.addClock()

        // Listen for Vue → Phaser state updates
        window.addEventListener('workspace:agents:update', this.onAgentsUpdate as EventListener)
        window.addEventListener('workspace:drag:enable', this.onDragEnable as EventListener)

        // Set up Phaser drag events
        this.input.on('drag', (_pointer: Phaser.Input.Pointer, gameObject: Phaser.GameObjects.Container, dragX: number, dragY: number) => {
            gameObject.x = dragX
            gameObject.y = dragY
            // Move bubble and icon with agent
            const agentId = this.findAgentIdBySprite(gameObject)
            if (agentId) {
                const bubble = this.agentBubbles.get(agentId)
                if (bubble) {
                    bubble.x = dragX
                    bubble.y = dragY - 28
                }
                const icon = this.agentIcons.get(agentId)
                if (icon) {
                    icon.x = dragX + 16
                    icon.y = dragY - 8
                }
            }
        })

        this.input.on('dragend', (_pointer: Phaser.Input.Pointer, gameObject: Phaser.GameObjects.Container) => {
            const agentId = this.findAgentIdBySprite(gameObject)
            if (agentId) {
                const zone = this.detectZone(gameObject.x, gameObject.y)
                window.dispatchEvent(new CustomEvent('workspace:layout:changed', {
                    detail: {
                        agentId,
                        x: Math.round(gameObject.x),
                        y: Math.round(gameObject.y),
                        zone,
                    },
                }))
            }
        })
    }

    // ─── Drawing ─────────────────────────────────────────────

    private drawFloor() {
        // Use office tilemap as background if loaded, otherwise fallback to code
        if (this.textures.exists('office_tilemap')) {
            const tilemap = this.add.image(SCENE_W / 2, SCENE_H / 2, 'office_tilemap')
            tilemap.setDisplaySize(SCENE_W, SCENE_H)
            tilemap.setAlpha(0.3)
        }

        // Grid overlay
        const g = this.add.graphics()
        g.fillStyle(C.floor, 0.85)
        g.fillRect(0, 0, SCENE_W, SCENE_H)
        g.lineStyle(1, C.floorGrid, 0.3)
        for (let x = 0; x <= SCENE_W; x += TILE * 4) {
            g.lineBetween(x, 0, x, SCENE_H)
        }
        for (let y = 0; y <= SCENE_H; y += TILE * 4) {
            g.lineBetween(0, y, SCENE_W, y)
        }
    }

    private drawWalls() {
        const g = this.add.graphics()
        // Top wall
        g.fillStyle(C.wall)
        g.fillRect(0, 0, SCENE_W, TILE * 2)
        g.fillStyle(C.wallTop)
        g.fillRect(0, TILE * 2 - 2, SCENE_W, 2)
        // Left wall
        g.fillStyle(C.wall)
        g.fillRect(0, 0, TILE, SCENE_H)
        // Right wall
        g.fillRect(SCENE_W - TILE, 0, TILE, SCENE_H)
    }

    private drawZones() {
        const g = this.add.graphics()
        const zones = [
            { key: 'requirement', x: TILE * 2, y: TILE * 3, w: TILE * 20, h: TILE * 16 },
            { key: 'coding',      x: TILE * 24, y: TILE * 3, w: TILE * 20, h: TILE * 16 },
            { key: 'review',      x: TILE * 2, y: TILE * 21, w: TILE * 20, h: TILE * 14 },
            { key: 'delivery',    x: TILE * 24, y: TILE * 21, w: TILE * 20, h: TILE * 14 },
        ]

        for (const z of zones) {
            const colors = ZONE_COLORS[z.key]
            // Zone background
            g.fillStyle(colors.bg, 0.4)
            g.fillRect(z.x, z.y, z.w, z.h)
            // Zone border (dashed effect)
            g.lineStyle(2, colors.border, 0.6)
            g.strokeRect(z.x, z.y, z.w, z.h)
            // Corner accents
            const cs = 8
            g.lineStyle(2, colors.border, 0.9)
            g.lineBetween(z.x, z.y, z.x + cs, z.y)
            g.lineBetween(z.x, z.y, z.x, z.y + cs)
            g.lineBetween(z.x + z.w, z.y, z.x + z.w - cs, z.y)
            g.lineBetween(z.x + z.w, z.y, z.x + z.w, z.y + cs)
            g.lineBetween(z.x, z.y + z.h, z.x + cs, z.y + z.h)
            g.lineBetween(z.x, z.y + z.h, z.x, z.y + z.h - cs)
            g.lineBetween(z.x + z.w, z.y + z.h, z.x + z.w - cs, z.y + z.h)
            g.lineBetween(z.x + z.w, z.y + z.h, z.x + z.w, z.y + z.h - cs)

            // Zone label
            this.add.text(z.x + 8, z.y + 6, colors.label, {
                fontSize: '11px',
                fontFamily: 'monospace',
                color: '#94a3b8',
            })
        }
    }

    private drawFurniture() {
        for (const seat of DEFAULT_SEATS) {
            const x = seat.x
            const y = seat.y

            // Use loaded desk texture or fallback to code
            if (this.textures.exists('desk')) {
                const desk = this.add.image(x, y, 'desk')
                desk.setScale(0.8)
            } else {
                const g = this.add.graphics()
                g.fillStyle(0x374151)
                g.fillRect(x - 24, y - 8, 48, 16)
                g.fillStyle(0x4b5563)
                g.fillRect(x - 24, y - 8, 48, 3)
            }

            // Monitor — use loaded texture or code
            if (this.textures.exists('monitor')) {
                const monitor = this.add.image(x, y - 14, 'monitor')
                monitor.setScale(0.7)
            } else {
                const g = this.add.graphics()
                g.fillStyle(0x111827)
                g.fillRect(x - 8, y - 20, 16, 12)
                g.fillStyle(0x3b82f6, 0.3)
                g.fillRect(x - 6, y - 18, 12, 8)
                g.fillStyle(0x111827)
                g.fillRect(x - 2, y - 8, 4, 4)
            }

            // Chair
            if (this.textures.exists('chair')) {
                const chair = this.add.image(x, y + 16, 'chair')
                chair.setScale(0.6)
                chair.setAlpha(0.7)
            } else {
                const g = this.add.graphics()
                g.fillStyle(0x6b7280, 0.5)
                g.fillRect(x - 6, y + 12, 12, 8)
            }
        }
    }

    private drawZoneDecorations() {
        // Add decorative items in zones using loaded assets
        const decorations: Array<{ texture: string; x: number; y: number; scale: number }> = [
            // Requirement zone — scrolls and keys
            { texture: 'item_scroll', x: TILE * 4, y: TILE * 5, scale: 0.8 },
            { texture: 'item_gold_key', x: TILE * 8, y: TILE * 8, scale: 0.6 },
            // Coding zone — weapons/tools
            { texture: 'weapon_sword', x: TILE * 26, y: TILE * 5, scale: 0.7 },
            { texture: 'weapon_katana', x: TILE * 30, y: TILE * 8, scale: 0.7 },
            // Review zone — hearts and potions
            { texture: 'item_heart', x: TILE * 4, y: TILE * 23, scale: 0.6 },
            { texture: 'item_life_pot', x: TILE * 8, y: TILE * 26, scale: 0.6 },
            // Delivery zone — coins and keys
            { texture: 'item_gold_coin', x: TILE * 26, y: TILE * 23, scale: 0.6 },
            { texture: 'item_silver_coin', x: TILE * 30, y: TILE * 26, scale: 0.6 },
        ]

        for (const d of decorations) {
            if (this.textures.exists(d.texture)) {
                const img = this.add.image(d.x, d.y, d.texture)
                img.setScale(d.scale)
                img.setAlpha(0.4)
                // Gentle float animation
                this.tweens.add({
                    targets: img,
                    y: d.y - 4,
                    duration: 2000 + Math.random() * 1000,
                    yoyo: true,
                    repeat: -1,
                    ease: 'Sine.easeInOut',
                    delay: Math.random() * 2000,
                })
            }
        }
    }

    // ─── Environment Animations ────────────────────────────────

    private addScanline() {
        const scanline = this.add.graphics()
        scanline.fillStyle(0x60a5fa, 0.03)
        scanline.fillRect(0, 0, SCENE_W, 2)
        
        this.tweens.add({
            targets: scanline,
            y: SCENE_H,
            duration: 8000,
            repeat: -1,
            ease: 'Linear',
        })
    }

    private addFloatingParticles() {
        for (let i = 0; i < 15; i++) {
            const particle = this.add.graphics()
            const x = Phaser.Math.Between(TILE * 2, SCENE_W - TILE * 2)
            const y = Phaser.Math.Between(TILE * 4, SCENE_H - TILE * 2)
            const size = Phaser.Math.Between(1, 3)
            const alpha = 0.1 + Math.random() * 0.2
            
            particle.fillStyle(0x60a5fa, alpha)
            particle.fillCircle(0, 0, size)
            particle.setPosition(x, y)
            
            this.tweens.add({
                targets: particle,
                y: y - Phaser.Math.Between(20, 60),
                alpha: { from: alpha, to: 0 },
                duration: 3000 + Math.random() * 4000,
                repeat: -1,
                yoyo: true,
                delay: Math.random() * 2000,
            })
        }
    }

    private addMonitorAnimations() {
        for (const seat of DEFAULT_SEATS) {
            const glow = this.add.graphics()
            const colors = [0x3b82f6, 0x22c55e, 0xf59e0b, 0xa855f7]
            let colorIdx = 0
            
            this.time.addEvent({
                delay: 2000 + Math.random() * 3000,
                loop: true,
                callback: () => {
                    glow.clear()
                    const color = colors[colorIdx % colors.length]
                    glow.fillStyle(color, 0.15)
                    glow.fillRect(seat.x - 6, seat.y - 18, 12, 8)
                    colorIdx++
                    this.time.delayedCall(500, () => {
                        glow.clear()
                    })
                }
            })
        }
    }

    private addZonePulse() {
        const zones = [
            { x: TILE * 2, y: TILE * 3, w: TILE * 20, h: TILE * 16, color: 0x3b82f6 },
            { x: TILE * 24, y: TILE * 3, w: TILE * 20, h: TILE * 16, color: 0x22c55e },
            { x: TILE * 2, y: TILE * 21, w: TILE * 20, h: TILE * 14, color: 0xf59e0b },
            { x: TILE * 24, y: TILE * 21, w: TILE * 20, h: TILE * 14, color: 0xa855f7 },
        ]
        
        for (const zone of zones) {
            const border = this.add.graphics()
            border.lineStyle(1, zone.color, 0)
            border.strokeRect(zone.x, zone.y, zone.w, zone.h)
            
            this.tweens.add({
                targets: border,
                alpha: { from: 0, to: 0.4 },
                duration: 2000,
                yoyo: true,
                repeat: -1,
                delay: Math.random() * 3000,
            })
        }
    }

    private addClock() {
        const clockText = this.add.text(SCENE_W - TILE * 2 - 60, TILE * 1, '', {
            fontSize: '10px',
            fontFamily: 'monospace',
            color: '#475569',
        })
        
        this.time.addEvent({
            delay: 1000,
            loop: true,
            callback: () => {
                const now = new Date()
                clockText.setText(
                    `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
                )
            }
        })
    }

    // ─── Agent Management ────────────────────────────────────

    private onAgentsUpdate = (e: Event) => {
        const { agents } = (e as CustomEvent).detail as { agents: AgentWorkspaceState[] }
        const newIds = new Set(agents.map(a => a.agentId))

        // Remove agents no longer present
        for (const [id, container] of this.agentSprites) {
            if (!newIds.has(id)) {
                container.destroy()
                this.agentSprites.delete(id)
                this.agentBubbles.get(id)?.destroy()
                this.agentBubbles.delete(id)
                this.agentIcons.get(id)?.destroy()
                this.agentIcons.delete(id)
                this.pulseTimers.get(id)?.destroy()
                this.pulseTimers.delete(id)
                this.idleTweens.get(id)?.destroy()
                this.idleTweens.delete(id)
                this.agentStates.delete(id)
            }
        }

        // Add or update agents
        for (const agent of agents) {
            this.agentStates.set(agent.agentId, agent)
            if (this.agentSprites.has(agent.agentId)) {
                this.updateAgentVisual(agent)
            } else {
                this.createAgentSprite(agent)
            }
        }
    }

    private onDragEnable = (e: Event) => {
        const { enabled } = (e as CustomEvent).detail as { enabled: boolean }
        this.dragEnabled = enabled
        for (const [, container] of this.agentSprites) {
            container.setInteractive({ draggable: enabled })
        }
    }

    private findAgentIdBySprite(sprite: Phaser.GameObjects.Container): string | null {
        for (const [id, container] of this.agentSprites) {
            if (container === sprite) return id
        }
        return null
    }

    private detectZone(x: number, y: number): string {
        const zones = [
            { key: 'requirement', x: TILE * 2, y: TILE * 3, w: TILE * 20, h: TILE * 16 },
            { key: 'coding',      x: TILE * 24, y: TILE * 3, w: TILE * 20, h: TILE * 16 },
            { key: 'review',      x: TILE * 2, y: TILE * 21, w: TILE * 20, h: TILE * 14 },
            { key: 'delivery',    x: TILE * 24, y: TILE * 21, w: TILE * 20, h: TILE * 14 },
        ]
        for (const z of zones) {
            if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) {
                return z.key
            }
        }
        return 'unknown'
    }

    private createAgentSprite(agent: AgentWorkspaceState) {
        const seat = DEFAULT_SEATS[agent.seatIndex % DEFAULT_SEATS.length]
        const x = agent.x ?? seat.x
        const y = agent.y ?? seat.y
        const container = this.add.container(x, y - 32)

        // Character sprite — use loaded character or fallback to colored circle
        const charIndex = (agent.seatIndex % 25) + 1
        const charKey = `char_${charIndex}`
        let bodyDisplay: Phaser.GameObjects.Image | Phaser.GameObjects.Graphics

        if (this.textures.exists(charKey)) {
            const charImg = this.add.image(0, 0, charKey)
            charImg.setScale(1.2)
            // Tint with agent color for differentiation
            charImg.setTint(agentColor(agent.agentName))
            bodyDisplay = charImg
        } else {
            // Fallback: colored circle
            const color = agentColor(agent.agentName)
            const body = this.add.graphics()
            body.fillStyle(color)
            body.fillCircle(0, 0, 12)
            body.fillStyle(0xffffff, 0.2)
            body.fillCircle(-3, -3, 4)
            bodyDisplay = body
        }

        // Name label
        const nameText = this.add.text(0, 22, agent.agentName, {
            fontSize: '10px',
            fontFamily: 'monospace',
            color: '#e2e8f0',
            align: 'center',
        }).setOrigin(0.5)

        // Status indicator dot
        const statusDot = this.add.graphics()
        this.drawStatusDot(statusDot, agent.status)

        container.add([bodyDisplay, nameText, statusDot])
        container.setSize(32, 44)
        container.setInteractive({ draggable: this.dragEnabled })

        container.on('pointerdown', () => {
            this.selectedAgentId = agent.agentId
            window.dispatchEvent(new CustomEvent('workspace:agent:selected', {
                detail: { agentId: agent.agentId, agentName: agent.agentName },
            }))
        })

        this.agentSprites.set(agent.agentId, container)

        // Create bubble container
        const bubble = this.add.container(x, y - 60)
        bubble.setVisible(false)
        this.agentBubbles.set(agent.agentId, bubble)

        // Status icon (floating above agent)
        const iconKey = STATUS_ICON_MAP[agent.status]
        if (iconKey && this.textures.exists(iconKey)) {
            const icon = this.add.image(x + 16, y - 40, iconKey)
            icon.setScale(0.5)
            icon.setVisible(false)
            this.agentIcons.set(agent.agentId, icon)
        }

        // Entrance animation
        container.setAlpha(0)
        container.setScale(0.5)
        this.tweens.add({
            targets: container,
            alpha: 1,
            scaleX: 1,
            scaleY: 1,
            duration: 300,
            ease: 'Back.easeOut',
        })

        // Idle breathing animation
        const idleTween = this.tweens.add({
            targets: container,
            y: container.y - 2,
            duration: 1500 + Math.random() * 500,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
        })
        this.idleTweens.set(agent.agentId, idleTween)
    }

    private updateAgentVisual(agent: AgentWorkspaceState) {
        const container = this.agentSprites.get(agent.agentId)
        if (!container) return

        // Update status dot (3rd child)
        const statusDot = container.getAt(2) as Phaser.GameObjects.Graphics
        if (statusDot) {
            statusDot.clear()
            this.drawStatusDot(statusDot, agent.status)
        }

        // Bug 2 fix: only setTint on Image, not Graphics (Graphics also has setTint in Phaser 3)
        const charDisplay = container.getAt(0)
        if (charDisplay instanceof Phaser.GameObjects.Image) {
            const tint = STATUS_TINT_MAP[agent.status]
            if (agent.status !== 'idle') {
                charDisplay.setTint(tint)
            } else {
                charDisplay.setTint(agentColor(agent.agentName))
            }
        }

        // Update status icon
        const iconKey = STATUS_ICON_MAP[agent.status]
        let icon = this.agentIcons.get(agent.agentId)
        if (iconKey && this.textures.exists(iconKey)) {
            if (!icon) {
                icon = this.add.image(container.x + 16, container.y - 8, iconKey)
                icon.setScale(0.5)
                this.agentIcons.set(agent.agentId, icon)
            }
            icon.setTexture(iconKey)
            icon.setVisible(true)
            // Icon bounce animation
            this.tweens.add({
                targets: icon,
                y: icon.y - 4,
                duration: 300,
                yoyo: true,
                ease: 'Sine.easeInOut',
            })
        } else if (icon) {
            icon.setVisible(false)
        }

        // Bug 7 fix: only rebuild bubble when status actually changes
        const prev = this.agentStates.get(agent.agentId)
        const statusChanged = !prev || prev.status !== agent.status
        const bubble = this.agentBubbles.get(agent.agentId)
        if (bubble && statusChanged) {
            bubble.removeAll(true)
            if (agent.status !== 'idle') {
                const visual = STATUS_VISUALS[agent.status]

                // Use loaded bubble texture or fallback
                if (this.textures.exists('hud_bubble')) {
                    const bubbleImg = this.add.image(0, 0, 'hud_bubble')
                    bubbleImg.setScale(0.6)
                    bubbleImg.setAlpha(0.9)
                    bubble.add(bubbleImg)
                } else {
                    const bg = this.add.graphics()
                    bg.fillStyle(C.bubbleBg, 0.9)
                    bg.fillRoundedRect(-30, -12, 60, 20, 4)
                    bg.lineStyle(1, C.bubbleBorder, 0.8)
                    bg.strokeRoundedRect(-30, -12, 60, 20, 4)
                    bubble.add(bg)
                }

                const text = this.add.text(0, -2, `${visual.emoji} ${visual.label}`, {
                    fontSize: '10px',
                    fontFamily: 'monospace',
                    color: '#e2e8f0',
                    align: 'center',
                }).setOrigin(0.5)
                bubble.add(text)
                bubble.setVisible(true)

                // Pulse animation for active states
                if (!this.pulseTimers.has(agent.agentId)) {
                    const timer = this.time.addEvent({
                        delay: 800,
                        loop: true,
                        callback: () => {
                            this.tweens.add({
                                targets: bubble,
                                alpha: { from: 1, to: 0.6 },
                                duration: 400,
                                yoyo: true,
                            })
                        },
                    })
                    this.pulseTimers.set(agent.agentId, timer)
                }
            } else {
                bubble.setVisible(false)
                this.pulseTimers.get(agent.agentId)?.destroy()
                this.pulseTimers.delete(agent.agentId)
            }
        }

        // Bug 7 fix: only trigger status animations on actual status change
        if (!statusChanged) return

        // Status-specific animations
        if (agent.status === 'replying' || agent.status === 'thinking') {
            // Working animation — slight bounce
            this.tweens.add({
                targets: container,
                y: container.y - 2,
                duration: 200,
                yoyo: true,
                repeat: 2,
            })
        } else if (agent.status === 'calling_tool') {
            // Tool call — shake animation
            this.tweens.add({
                targets: container,
                x: container.x + 2,
                duration: 50,
                yoyo: true,
                repeat: 4,
            })
            // FX sparkle if available
            if (this.textures.exists('fx_sparkle')) {
                const sparkle = this.add.image(container.x, container.y - 10, 'fx_sparkle')
                sparkle.setScale(0.5)
                sparkle.setAlpha(0.8)
                this.tweens.add({
                    targets: sparkle,
                    alpha: 0,
                    scaleX: 1.5,
                    scaleY: 1.5,
                    duration: 800,
                    onComplete: () => sparkle.destroy(),
                })
            }
        } else if (agent.status === 'completed') {
            // Completed — gold coin flash
            if (this.textures.exists('fx_success')) {
                const fx = this.add.image(container.x, container.y - 10, 'fx_success')
                fx.setScale(0.4)
                this.tweens.add({
                    targets: fx,
                    alpha: 0,
                    y: fx.y - 20,
                    scaleX: 0.8,
                    scaleY: 0.8,
                    duration: 1500,
                    onComplete: () => fx.destroy(),
                })
            } else {
                const flash = this.add.graphics()
                flash.fillStyle(0x22c55e, 0.3)
                flash.fillCircle(container.x, container.y, 20)
                this.tweens.add({
                    targets: flash,
                    alpha: 0,
                    duration: 1500,
                    onComplete: () => flash.destroy(),
                })
            }
        } else if (agent.status === 'failed') {
            // Failed — red flash + shake
            if (this.textures.exists('fx_fail')) {
                const fx = this.add.image(container.x, container.y - 10, 'fx_fail')
                fx.setScale(0.4)
                this.tweens.add({
                    targets: fx,
                    alpha: 0,
                    y: fx.y - 20,
                    duration: 2000,
                    onComplete: () => fx.destroy(),
                })
            } else {
                const flash = this.add.graphics()
                flash.fillStyle(0xef4444, 0.3)
                flash.fillCircle(container.x, container.y, 20)
                this.tweens.add({
                    targets: flash,
                    alpha: 0,
                    duration: 2000,
                    onComplete: () => flash.destroy(),
                })
            }
            this.tweens.add({
                targets: container,
                x: container.x + 3,
                duration: 60,
                yoyo: true,
                repeat: 5,
            })
        }
    }

    private drawStatusDot(g: Phaser.GameObjects.Graphics, status: AgentWorkStatus) {
        const visual = STATUS_VISUALS[status]
        g.fillStyle(visual.color)
        g.fillCircle(14, -10, 4)
        g.lineStyle(1, 0x000000, 0.5)
        g.strokeCircle(14, -10, 4)
    }

    // ─── Cleanup ─────────────────────────────────────────────

    shutdown() {
        window.removeEventListener('workspace:agents:update', this.onAgentsUpdate as EventListener)
        window.removeEventListener('workspace:drag:enable', this.onDragEnable as EventListener)
        for (const timer of this.pulseTimers.values()) timer.destroy()
        for (const tween of this.idleTweens.values()) tween.destroy()
        this.pulseTimers.clear()
        this.idleTweens.clear()
        this.agentSprites.clear()
        this.agentBubbles.clear()
        this.agentIcons.clear()
        this.agentStates.clear()
    }
}
