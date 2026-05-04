// ─── Group Office Scene ──────────────────────────────────────
// Phaser scene that renders a pixel-art office with agent workstations.
// Pure code rendering — no external assets needed for MVP.

import Phaser from 'phaser'
import type { AgentWorkspaceState, AgentWorkStatus } from '../runtime/types'
import { DEFAULT_SEATS, ZONE_COLORS, STATUS_VISUALS } from '../runtime/types'
import { agentColor } from '../runtime/agent-state'

const SCENE_W = 720
const SCENE_H = 560
const TILE = 16
const GRID_COLS = SCENE_W / TILE
const GRID_ROWS = SCENE_H / TILE

// ─── Color constants ────────────────────────────────────────
const C = {
    floor:       0x0f1729,
    floorGrid:   0x1a2744,
    wall:        0x1e293b,
    wallTop:     0x334155,
    desk:        0x374151,
    deskTop:     0x4b5563,
    chair:       0x6b7280,
    monitor:     0x111827,
    monitorGlow: 0x3b82f6,
    labelBg:     0x000000,
    labelText:   0xe2e8f0,
    bubbleBg:    0x1e293b,
    bubbleBorder:0x475569,
}

export class GroupOfficeScene extends Phaser.Scene {
    private agentSprites: Map<string, Phaser.GameObjects.Container> = new Map()
    private agentBubbles: Map<string, Phaser.GameObjects.Container> = new Map()
    private agentStates: Map<string, AgentWorkspaceState> = new Map()
    private selectedAgentId: string | null = null
    private pulseTimers: Map<string, Phaser.Time.TimerEvent> = new Map()
    private dragEnabled = false

    constructor() {
        super({ key: 'GroupOfficeScene' })
    }

    create() {
        this.drawFloor()
        this.drawWalls()
        this.drawZones()
        this.drawFurniture()

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
            // Move bubble with agent
            const agentId = this.findAgentIdBySprite(gameObject)
            if (agentId) {
                const bubble = this.agentBubbles.get(agentId)
                if (bubble) {
                    bubble.x = dragX
                    bubble.y = dragY - 24
                }
            }
        })

        this.input.on('dragend', (_pointer: Phaser.Input.Pointer, gameObject: Phaser.GameObjects.Container) => {
            const agentId = this.findAgentIdBySprite(gameObject)
            if (agentId) {
                // Determine zone based on position
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
        const g = this.add.graphics()
        // Base floor
        g.fillStyle(C.floor)
        g.fillRect(0, 0, SCENE_W, SCENE_H)
        // Grid lines
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
        const g = this.add.graphics()

        for (const seat of DEFAULT_SEATS) {
            const x = seat.x
            const y = seat.y

            // Desk (pixel rectangle)
            g.fillStyle(C.desk)
            g.fillRect(x - 24, y - 8, 48, 16)
            g.fillStyle(C.deskTop)
            g.fillRect(x - 24, y - 8, 48, 3)

            // Monitor
            g.fillStyle(C.monitor)
            g.fillRect(x - 8, y - 20, 16, 12)
            g.fillStyle(C.monitorGlow, 0.3)
            g.fillRect(x - 6, y - 18, 12, 8)
            // Monitor stand
            g.fillStyle(C.monitor)
            g.fillRect(x - 2, y - 8, 4, 4)

            // Chair
            g.fillStyle(C.chair, 0.5)
            g.fillRect(x - 6, y + 12, 12, 8)
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
            
            // Float animation
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
                    // Fade out after 500ms
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
                this.pulseTimers.get(id)?.destroy()
                this.pulseTimers.delete(id)
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
        // Update all existing sprites
        for (const [, container] of this.agentSprites) {
            if (enabled) {
                container.setInteractive({ draggable: true })
            } else {
                container.setInteractive({ draggable: false })
            }
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
        const color = agentColor(agent.agentName)
        const container = this.add.container(seat.x, seat.y - 32)

        // Body (pixel circle)
        const body = this.add.graphics()
        body.fillStyle(color)
        body.fillCircle(0, 0, 12)
        // Body highlight
        body.fillStyle(0xffffff, 0.2)
        body.fillCircle(-3, -3, 4)

        // Name label
        const nameText = this.add.text(0, 18, agent.agentName, {
            fontSize: '10px',
            fontFamily: 'monospace',
            color: '#e2e8f0',
            align: 'center',
        }).setOrigin(0.5)

        // Status indicator dot
        const statusDot = this.add.graphics()
        this.drawStatusDot(statusDot, agent.status)

        container.add([body, nameText, statusDot])
        container.setSize(32, 40)
        container.setInteractive({ draggable: this.dragEnabled })

        container.on('pointerdown', () => {
            this.selectedAgentId = agent.agentId
            window.dispatchEvent(new CustomEvent('workspace:agent:selected', {
                detail: { agentId: agent.agentId, agentName: agent.agentName },
            }))
        })

        this.agentSprites.set(agent.agentId, container)

        // Create bubble container
        const bubble = this.add.container(seat.x, seat.y - 56)
        bubble.setVisible(false)
        this.agentBubbles.set(agent.agentId, bubble)

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
        this.tweens.add({
            targets: container,
            y: container.y - 2,
            duration: 1500 + Math.random() * 500,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
        })
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

        // Update bubble
        const bubble = this.agentBubbles.get(agent.agentId)
        if (bubble) {
            bubble.removeAll(true)
            if (agent.status !== 'idle') {
                const visual = STATUS_VISUALS[agent.status]
                const bg = this.add.graphics()
                bg.fillStyle(C.bubbleBg, 0.9)
                bg.fillRoundedRect(-30, -12, 60, 20, 4)
                bg.lineStyle(1, C.bubbleBorder, 0.8)
                bg.strokeRoundedRect(-30, -12, 60, 20, 4)

                const text = this.add.text(0, -2, `${visual.emoji} ${visual.label}`, {
                    fontSize: '10px',
                    fontFamily: 'monospace',
                    color: '#e2e8f0',
                    align: 'center',
                }).setOrigin(0.5)

                bubble.add([bg, text])
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

        // Working animation — slight bounce
        if (agent.status === 'replying') {
            this.tweens.add({
                targets: container,
                y: container.y - 2,
                duration: 200,
                yoyo: true,
                repeat: 2,
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
        this.pulseTimers.clear()
        this.agentSprites.clear()
        this.agentBubbles.clear()
        this.agentStates.clear()
    }
}
