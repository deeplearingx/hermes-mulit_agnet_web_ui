// ─── Group Office Scene ──────────────────────────────────────
// Phaser scene that renders a pixel-art office with agent workstations.
// Uses real pixel assets from group_assets/ loaded via BootScene.
// Phase 6: Visual layer refactoring — spritesheet chars, clean floor,
//          subtle zones, 960×540 canvas, programming-semantic icons.

import Phaser from 'phaser'
import type { AgentWorkspaceState, AgentWorkStatus } from '../runtime/types'
import { DEFAULT_SEATS, ZONE_COLORS, STATUS_VISUALS } from '../runtime/types'
import { ZONE_RECTS } from '../runtime/map-config'
import { agentColor } from '../runtime/agent-state'
import {
    drawTerminalIcon, drawFileIcon, drawCodeIcon,
    drawCheckIcon, drawErrorIcon, drawToolIcon,
    drawGearIcon, drawThinkIcon, drawMemoryIcon,
} from './PixelIcons'

// V4: 16:9 widescreen canvas
const SCENE_W = 960
const SCENE_H = 540
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

/** Status → tint color for the character sprite */
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
    private agentIcons: Map<string, Phaser.GameObjects.Graphics> = new Map()
    private agentStates: Map<string, AgentWorkspaceState> = new Map()
    private selectedAgentId: string | null = null
    private pulseTimers: Map<string, Phaser.Time.TimerEvent> = new Map()
    private idleTweens: Map<string, Phaser.Tweens.Tween> = new Map()
    private dragEnabled = false
    private activePhase: string | null = null
    private zoneGraphics: Map<string, Phaser.GameObjects.Graphics> = new Map()
    private lastClickAt = new Map<string, number>()  // P9-3: for double-click detection

    constructor() {
        super({ key: 'GroupOfficeScene' })
    }

    create() {
        const hasTilemap = this.textures.exists('office_tilemap')

        this.drawFloor()
        this.drawWalls()
        this.drawZones()
        this.drawFurniture()

        // P8-8: Only draw zone decorations when no tilemap (reduces visual noise)
        if (!hasTilemap) {
            this.drawZoneDecorations()
        }

        // Environment animations
        this.addMonitorAnimations()
        this.addClock()

        // Listen for Vue → Phaser state updates
        window.addEventListener('workspace:agents:update', this.onAgentsUpdate as EventListener)
        window.addEventListener('workspace:drag:enable', this.onDragEnable as EventListener)
        window.addEventListener('workspace:phase:update', this.onPhaseUpdate as EventListener)

        // P8-2: Use Phaser shutdown event for cleanup (prevents leak on room switch)
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            window.removeEventListener('workspace:agents:update', this.onAgentsUpdate as EventListener)
            window.removeEventListener('workspace:drag:enable', this.onDragEnable as EventListener)
            window.removeEventListener('workspace:phase:update', this.onPhaseUpdate as EventListener)
            this.zoneGraphics.clear()
            for (const timer of this.pulseTimers.values()) timer.destroy()
            for (const tween of this.idleTweens.values()) tween.destroy()
            this.pulseTimers.clear()
            this.idleTweens.clear()
            this.agentSprites.clear()
            this.agentBubbles.clear()
            this.agentIcons.clear()
            this.agentStates.clear()
            this.lastClickAt.clear()  // P9-3
        })

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

        // P8-2: Signal that scene is ready to receive state
        window.dispatchEvent(new CustomEvent('workspace:scene:ready'))
    }

    // ─── Drawing ─────────────────────────────────────────────

    private drawFloor() {
        // V2: If tilemap loaded, show it fully — no dark overlay
        if (this.textures.exists('office_tilemap')) {
            const tilemap = this.add.image(SCENE_W / 2, SCENE_H / 2, 'office_tilemap')
            tilemap.setDisplaySize(SCENE_W, SCENE_H)
            tilemap.setAlpha(1)
            return
        }

        // Fallback: dark floor with grid (only when no tilemap)
        const g = this.add.graphics()
        g.fillStyle(C.floor, 1)
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
        // P8-10: Use ZONE_RECTS from map-config for unified coordinates
        const hasTilemap = this.textures.exists('office_tilemap')

        for (const z of ZONE_RECTS) {
            const colors = ZONE_COLORS[z.key]
            const g = this.add.graphics()

            if (!hasTilemap) {
                // 无 tilemap：画完整区域背景 + 边框
                g.fillStyle(colors.bg, 0.12)
                g.fillRect(z.x, z.y, z.w, z.h)
                g.lineStyle(1, colors.border, 0.15)
                g.strokeRect(z.x, z.y, z.w, z.h)
            }
            // P9-2: 有 tilemap 时不画大面积区域，只保留引用用于高亮

            // Save reference for dynamic highlighting
            this.zoneGraphics.set(z.key, g)

            // 标签始终显示
            const labelBg = this.add.graphics()
            labelBg.fillStyle(0x000000, 0.6)
            labelBg.fillRoundedRect(z.x + 4, z.y + 4, 80, 18, 3)
            this.add.text(z.x + 8, z.y + 6, colors.label, {
                fontSize: '10px',
                fontFamily: 'monospace',
                color: '#94a3b8',
            })
        }
    }

    private drawFurniture() {
        // If tilemap already contains furniture, only draw minimal seat indicators
        if (this.textures.exists('office_tilemap')) {
            for (const seat of DEFAULT_SEATS) {
                const g = this.add.graphics()
                g.fillStyle(0x1e293b, 0.3)
                g.fillCircle(seat.x, seat.y, 3)
            }
            return
        }

        for (const seat of DEFAULT_SEATS) {
            const x = seat.x
            const y = seat.y

            // Desk — pixel art style
            if (this.textures.exists('desk')) {
                const desk = this.add.image(x, y, 'desk')
                desk.setScale(0.8)
            } else {
                const g = this.add.graphics()
                // Desk surface
                g.fillStyle(0x4a3728)
                g.fillRect(x - 28, y - 10, 56, 20)
                // Desk top highlight
                g.fillStyle(0x5c4a3a)
                g.fillRect(x - 28, y - 10, 56, 3)
                // Desk legs
                g.fillStyle(0x3a2a1a)
                g.fillRect(x - 26, y + 10, 4, 6)
                g.fillRect(x + 22, y + 10, 4, 6)
            }

            // Monitor
            if (this.textures.exists('monitor')) {
                const monitor = this.add.image(x, y - 14, 'monitor')
                monitor.setScale(0.7)
            } else {
                const g = this.add.graphics()
                // Monitor frame
                g.fillStyle(0x111827)
                g.fillRect(x - 10, y - 24, 20, 14)
                // Screen
                g.fillStyle(0x1a2744)
                g.fillRect(x - 8, y - 22, 16, 10)
                // Screen glow
                g.fillStyle(0x3b82f6, 0.2)
                g.fillRect(x - 6, y - 20, 12, 6)
                // Stand
                g.fillStyle(0x111827)
                g.fillRect(x - 2, y - 10, 4, 4)
                g.fillRect(x - 4, y - 6, 8, 2)
            }

            // Chair
            if (this.textures.exists('chair')) {
                const chair = this.add.image(x, y + 16, 'chair')
                chair.setScale(0.6)
                chair.setAlpha(0.7)
            } else {
                const g = this.add.graphics()
                // Seat
                g.fillStyle(0x374151)
                g.fillRect(x - 8, y + 12, 16, 6)
                // Back
                g.fillStyle(0x475569)
                g.fillRect(x - 6, y + 6, 12, 6)
                // Legs
                g.fillStyle(0x1e293b)
                g.fillRect(x - 6, y + 18, 3, 4)
                g.fillRect(x + 3, y + 18, 3, 4)
            }
        }
    }

    private drawZoneDecorations() {
        // V5: Use code-generated pixel icons instead of RPG items
        const decorations: Array<{ draw: (g: Phaser.GameObjects.Graphics, x: number, y: number) => void; x: number; y: number }> = [
            // Requirement zone — files and docs
            { draw: (g, x, y) => drawFileIcon(g, x, y, 0x3b82f6), x: TILE * 6, y: TILE * 6 },
            { draw: (g, x, y) => drawCodeIcon(g, x, y, 0x60a5fa), x: TILE * 12, y: TILE * 9 },
            // Planning zone — terminal and gear
            { draw: (g, x, y) => drawTerminalIcon(g, x, y, 0x06b6d4), x: TILE * 24, y: TILE * 6 },
            { draw: (g, x, y) => drawGearIcon(g, x, y, 0x22d3ee), x: TILE * 30, y: TILE * 9 },
            // Coding zone — code and tools
            { draw: (g, x, y) => drawCodeIcon(g, x, y, 0x22c55e), x: TILE * 42, y: TILE * 6 },
            { draw: (g, x, y) => drawToolIcon(g, x, y, 0x4ade80), x: TILE * 48, y: TILE * 9 },
            // Review zone — check and memory
            { draw: (g, x, y) => drawCheckIcon(g, x, y), x: TILE * 8, y: TILE * 22 },
            { draw: (g, x, y) => drawMemoryIcon(g, x, y, 0xf59e0b), x: TILE * 18, y: TILE * 25 },
            // Delivery zone — file and terminal
            { draw: (g, x, y) => drawFileIcon(g, x, y, 0xa855f7), x: TILE * 36, y: TILE * 22 },
            { draw: (g, x, y) => drawTerminalIcon(g, x, y, 0xc084fc), x: TILE * 46, y: TILE * 25 },
        ]

        for (const d of decorations) {
            const g = this.add.graphics()
            d.draw(g, d.x, d.y)
            g.setAlpha(0.08)
            // Gentle float animation (±4px from origin)
            this.tweens.add({
                targets: g,
                y: -4,
                duration: 2000 + Math.random() * 1000,
                yoyo: true,
                repeat: -1,
                ease: 'Sine.easeInOut',
                delay: Math.random() * 2000,
            })
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
                    glow.fillRect(seat.x - 6, seat.y - 22, 12, 8)
                    colorIdx++
                    this.time.delayedCall(500, () => {
                        glow.clear()
                    })
                }
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
                this.lastClickAt.delete(id)  // P9-3: cleanup click tracking
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
        // P8-10: Use ZONE_RECTS from map-config for unified coordinates
        for (const z of ZONE_RECTS) {
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

        // V1: Character sprite — use spritesheet with single frame, or fallback to pixel art
        const charIndex = (agent.seatIndex % 25) + 1
        const charKey = `char_${charIndex}`
        let bodyDisplay: Phaser.GameObjects.Sprite | Phaser.GameObjects.Graphics

        if (this.textures.exists(charKey)) {
            // V1: Use spritesheet — take frame 0 only (16×16 pixel character)
            const charSprite = this.add.sprite(0, 0, charKey, 0)
            charSprite.setScale(2)
            charSprite.setTint(agentColor(agent.agentName))
            bodyDisplay = charSprite
        } else {
            // Fallback: code-generated pixel character
            const color = agentColor(agent.agentName)
            const body = this.add.graphics()
            // Head
            body.fillStyle(0xffcc99)
            body.fillRect(-4, -14, 8, 8)
            // Hair
            body.fillStyle(color, 0.8)
            body.fillRect(-5, -14, 10, 3)
            // Body
            body.fillStyle(color)
            body.fillRect(-5, -6, 10, 10)
            // Arms
            body.fillRect(-8, -5, 3, 8)
            body.fillRect(5, -5, 3, 8)
            // Legs
            body.fillStyle(0x374151)
            body.fillRect(-4, 4, 3, 6)
            body.fillRect(1, 4, 3, 6)
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

        // P9-3: 合并单击/双击 — 单击选中，双击切换 pinned
        container.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
            const now = pointer.downTime
            const last = this.lastClickAt.get(agent.agentId) ?? 0
            const isDoubleClick = now - last < 350

            this.lastClickAt.set(agent.agentId, now)

            if (isDoubleClick) {
                window.dispatchEvent(new CustomEvent('workspace:layout:pin-toggle', {
                    detail: { agentId: agent.agentId },
                }))
                return
            }

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

        // V5: Status icon — code-generated pixel icon (not RPG item)
        const iconG = this.add.graphics()
        iconG.setPosition(x + 16, y - 40)
        iconG.setVisible(false)
        this.drawStatusIcon(iconG, agent.status)
        this.agentIcons.set(agent.agentId, iconG)

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

        // V1: Update character tint — handle both Sprite and Graphics
        const charDisplay = container.getAt(0)
        if (charDisplay instanceof Phaser.GameObjects.Sprite) {
            const tint = STATUS_TINT_MAP[agent.status]
            if (agent.status !== 'idle') {
                charDisplay.setTint(tint)
            } else {
                charDisplay.setTint(agentColor(agent.agentName))
            }
        }

        // V5: Update status icon — code-generated pixel icon
        let icon = this.agentIcons.get(agent.agentId)
        if (agent.status !== 'idle') {
            if (!icon) {
                icon = this.add.graphics()
                icon.setPosition(container.x + 16, container.y - 8)
                this.agentIcons.set(agent.agentId, icon)
            }
            icon.clear()
            this.drawStatusIcon(icon, agent.status)
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

        // P9-3: pinned indicator — small pin icon
        const pinKey = `pin-${agent.agentId}`
        let pinIcon = this.agentIcons.get(pinKey)
        if (agent.pinned) {
            if (!pinIcon) {
                pinIcon = this.add.graphics()
                this.agentIcons.set(pinKey, pinIcon)
            }
            pinIcon.clear()
            pinIcon.setPosition(container.x + 20, container.y - 16)
            // 画一个小图钉
            pinIcon.fillStyle(0xf59e0b, 0.8)
            pinIcon.fillCircle(0, 0, 3)
            pinIcon.fillStyle(0xf59e0b, 0.6)
            pinIcon.fillRect(-1, 3, 2, 5)
            pinIcon.setVisible(true)
        } else if (pinIcon) {
            pinIcon.setVisible(false)
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
            // Code-generated sparkle effect
            const sparkle = this.add.graphics()
            sparkle.fillStyle(0x8b5cf6, 0.6)
            sparkle.fillCircle(container.x, container.y - 10, 3)
            sparkle.fillStyle(0xa78bfa, 0.4)
            sparkle.fillCircle(container.x - 6, container.y - 14, 2)
            sparkle.fillCircle(container.x + 6, container.y - 14, 2)
            this.tweens.add({
                targets: sparkle,
                alpha: 0,
                scaleX: 2,
                scaleY: 2,
                duration: 800,
                onComplete: () => sparkle.destroy(),
            })
        } else if (agent.status === 'completed') {
            // Completed — green flash
            const flash = this.add.graphics()
            flash.fillStyle(0x22c55e, 0.3)
            flash.fillCircle(container.x, container.y, 20)
            this.tweens.add({
                targets: flash,
                alpha: 0,
                duration: 1500,
                onComplete: () => flash.destroy(),
            })
        } else if (agent.status === 'failed') {
            // Failed — red flash + shake
            const flash = this.add.graphics()
            flash.fillStyle(0xef4444, 0.3)
            flash.fillCircle(container.x, container.y, 20)
            this.tweens.add({
                targets: flash,
                alpha: 0,
                duration: 2000,
                onComplete: () => flash.destroy(),
            })
            this.tweens.add({
                targets: container,
                x: container.x + 3,
                duration: 60,
                yoyo: true,
                repeat: 5,
            })
        }
    }

    // V5: Draw status icon using PixelIcons (programming semantics)
    private drawStatusIcon(g: Phaser.GameObjects.Graphics, status: AgentWorkStatus): void {
        g.clear()
        switch (status) {
            case 'compressing':
                drawMemoryIcon(g, 0, 0, 0xf59e0b)
                break
            case 'replying':
                drawFileIcon(g, 0, 0, 0x3b82f6)
                break
            case 'thinking':
                drawThinkIcon(g, 0, 0, 0xa855f7)
                break
            case 'calling_tool':
                drawToolIcon(g, 0, 0, 0x8b5cf6)
                break
            case 'completed':
                drawCheckIcon(g, 0, 0)
                break
            case 'failed':
                drawErrorIcon(g, 0, 0)
                break
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

    // ─── Phase Highlighting ──────────────────────────────────

    private onPhaseUpdate = (e: Event) => {
        const { activePhase } = (e as CustomEvent).detail
        if (this.activePhase !== activePhase) {
            this.activePhase = activePhase
            this.updateZoneHighlights()
        }
    }

    // P9-2: 统一重绘，不能 clear 后只 setAlpha
    private updateZoneHighlights() {
        const hasTilemap = this.textures.exists('office_tilemap')

        for (const [key, g] of this.zoneGraphics) {
            const z = ZONE_RECTS.find(r => r.key === key)
            if (!z) continue

            const colors = ZONE_COLORS[key]
            const active = this.activePhase === key

            g.clear()

            if (hasTilemap) {
                // tilemap 模式：只画当前活跃 zone 的高亮边框
                if (active) {
                    g.lineStyle(2, colors.border, 0.65)
                    g.strokeRect(z.x, z.y, z.w, z.h)
                }
                continue
            }

            // 非 tilemap 模式：重绘区域背景 + 边框
            g.fillStyle(colors.bg, active ? 0.18 : 0.06)
            g.fillRect(z.x, z.y, z.w, z.h)
            g.lineStyle(1, colors.border, active ? 0.45 : 0.15)
            g.strokeRect(z.x, z.y, z.w, z.h)
        }
    }

    // Cleanup is handled by Phaser.Scenes.Events.SHUTDOWN listener in create()
}
