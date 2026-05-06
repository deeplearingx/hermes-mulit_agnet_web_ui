// ─── Agent Room Office Scene ──────────────────────────────────
// Full pixel office scene for Agent Room workspace.
// Pure display — no drag, no click, no layout persistence.
// Independent from group-chat/workspace/scenes/.
// Uses office_tilemap + char spritesheets when available,
// falls back to code-drawn graphics otherwise.

import Phaser from 'phaser'

// ─── Scene dimensions (match group-chat for consistency) ─────
const SCENE_W = 960
const SCENE_H = 540
const TILE = 16

// ─── Color constants ─────────────────────────────────────────
const C = {
    floor:       0x0f1729,
    floorGrid:   0x1a2744,
    wall:        0x1e293b,
    wallTop:     0x334155,
    zoneBg:      0x1e3a5f,
    zoneBorder:  0x3b82f6,
    labelBg:     0x000000,
    labelText:   0xe2e8f0,
    taskBg:      0x1e293b,
    taskBorder:  0x475569,
    desk:        0x2d3748,
    deskLeg:     0x1a202c,
    monitor:     0x0f1729,
    monitorFrame:0x475569,
    chair:       0x374151,
}

// ─── Agent role → color ──────────────────────────────────────
const AGENT_COLORS: Record<string, number> = {
    conversation: 0x3b82f6,
    planner:      0xa855f7,
    developer:    0x22c55e,
    reviewer:     0xf59e0b,
    delivery:     0x06b6d4,
}

// ─── Agent role → Chinese label ──────────────────────────────
const AGENT_LABELS: Record<string, string> = {
    conversation: '会话区',
    planner:      '规划区',
    developer:    '开发区',
    reviewer:     '审核区',
    delivery:     '交付区',
}

// ─── Task status → display color ─────────────────────────────
const STATUS_COLORS: Record<string, number> = {
    created:              0x6b7280,
    planned:              0x8b5cf6,
    assigned:             0x3b82f6,
    in_progress:          0x22c55e,
    submitted_for_review: 0xf59e0b,
    review_passed:        0x10b981,
    review_rejected:      0xef4444,
    revision_required:    0xf97316,
    delivering:           0x06b6d4,
    completed:            0x22c55e,
    failed:               0xef4444,
    need_user_decision:   0xeab308,
}

// ─── Zone definitions ────────────────────────────────────────
interface ZoneDef {
    id: string
    x: number
    y: number
    w: number
    h: number
    agentX: number
    agentY: number
    deskX: number
    deskY: number
}

const ZONES: ZoneDef[] = [
    { id: 'conversation', x: 30,  y: 60,  w: 260, h: 200, agentX: 160, agentY: 170, deskX: 120, deskY: 200 },
    { id: 'planner',      x: 670, y: 60,  w: 260, h: 200, agentX: 800, agentY: 170, deskX: 760, deskY: 200 },
    { id: 'developer',    x: 350, y: 180, w: 260, h: 200, agentX: 480, agentY: 290, deskX: 440, deskY: 320 },
    { id: 'reviewer',     x: 30,  y: 320, w: 260, h: 180, agentX: 160, agentY: 420, deskX: 120, deskY: 450 },
    { id: 'delivery',     x: 670, y: 320, w: 260, h: 180, agentX: 800, agentY: 420, deskX: 760, deskY: 450 },
]

// ─── State interface ─────────────────────────────────────────
interface AgentDisplayState {
    id: string
    name: string
    role: string
    status: 'idle' | 'active' | 'completed' | 'failed'
}

interface TaskDisplayState {
    title: string
    status: string
    assignedAgentRole: string | null
}

// ─── Scene ───────────────────────────────────────────────────
export class AgentRoomOfficeScene extends Phaser.Scene {
    private agentSprites: Map<string, Phaser.GameObjects.Container> = new Map()
    private agentGlows: Map<string, Phaser.GameObjects.Graphics> = new Map()
    private agentLabels: Map<string, Phaser.GameObjects.Text> = new Map()
    private agentStates: Map<string, AgentDisplayState> = new Map()
    private pulseTimers: Map<string, Phaser.Time.TimerEvent> = new Map()

    private taskTitleText: Phaser.GameObjects.Text | null = null
    private taskStatusText: Phaser.GameObjects.Text | null = null
    private taskStatusDot: Phaser.GameObjects.Graphics | null = null

    private instanceId: string
    private tilemapLoaded = false
    private spritesheetKeys: Set<string> = new Set()

    constructor(instanceId: string) {
        super({ key: 'AgentRoomOfficeScene' })
        this.instanceId = instanceId
    }

    /** Legacy compatibility — no longer required when using constructor injection */
    setInstanceId(id: string) {
        this.instanceId = id
    }

    create() {
        // Check which assets loaded successfully
        this.tilemapLoaded = this.textures.exists('office_tilemap')
        for (let i = 1; i <= 25; i++) {
            if (this.textures.exists(`char_${i}`)) {
                this.spritesheetKeys.add(`char_${i}`)
            }
        }

        this.drawFloor()
        this.drawWalls()
        this.drawZones()
        this.drawFurniture()
        this.createAgentSprites()
        this.createTaskOverlay()

        // Listen for Vue → Phaser state updates
        window.addEventListener('agent-room:state:update', this.onStateUpdate as EventListener)

        // Cleanup on scene shutdown
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            window.removeEventListener('agent-room:state:update', this.onStateUpdate as EventListener)
            for (const timer of this.pulseTimers.values()) timer.destroy()
            this.pulseTimers.clear()
            this.agentSprites.clear()
            this.agentGlows.clear()
            this.agentLabels.clear()
            this.agentStates.clear()
        })

        // Signal ready — include instanceId so Vue can scope the event
        window.dispatchEvent(new CustomEvent('agent-room:scene:ready', {
            detail: { instanceId: this.instanceId },
        }))
    }

    // ─── Drawing ─────────────────────────────────────────────

    private drawFloor() {
        const g = this.add.graphics()

        if (this.tilemapLoaded) {
            // Use office tilemap as background
            const tilemap = this.add.image(SCENE_W / 2, SCENE_H / 2, 'office_tilemap')
            tilemap.setDisplaySize(SCENE_W, SCENE_H)
        } else {
            // Fallback: dark floor with grid
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
    }

    private drawWalls() {
        const g = this.add.graphics()
        // Top wall
        g.fillStyle(C.wall)
        g.fillRect(0, 0, SCENE_W, TILE * 2)
        g.fillStyle(C.wallTop)
        g.fillRect(0, TILE * 2 - 2, SCENE_W, 2)
        // Side walls
        g.fillStyle(C.wall)
        g.fillRect(0, 0, TILE, SCENE_H)
        g.fillRect(SCENE_W - TILE, 0, TILE, SCENE_H)
        // Bottom wall
        g.fillStyle(C.wall)
        g.fillRect(0, SCENE_H - TILE, SCENE_W, TILE)
    }

    private drawZones() {
        for (const zone of ZONES) {
            const g = this.add.graphics()
            // Zone background
            g.fillStyle(C.zoneBg, 0.12)
            g.fillRoundedRect(zone.x, zone.y, zone.w, zone.h, 6)
            g.lineStyle(1, C.zoneBorder, 0.2)
            g.strokeRoundedRect(zone.x, zone.y, zone.w, zone.h, 6)

            // Zone label background
            const labelBg = this.add.graphics()
            labelBg.fillStyle(C.labelBg, 0.6)
            labelBg.fillRoundedRect(zone.x + 4, zone.y + 4, 80, 18, 3)

            // Zone label text
            const label = AGENT_LABELS[zone.id] ?? zone.id
            const color = AGENT_COLORS[zone.id] ?? 0x94a3b8
            this.add.text(zone.x + 8, zone.y + 6, label, {
                fontSize: '10px',
                fontFamily: 'monospace',
                color: `#${color.toString(16).padStart(6, '0')}`,
            })
        }
    }

    private drawFurniture() {
        for (const zone of ZONES) {
            const g = this.add.graphics()

            // Desk surface
            g.fillStyle(C.desk, 0.7)
            g.fillRoundedRect(zone.deskX - 28, zone.deskY, 56, 10, 2)
            // Desk legs
            g.fillStyle(C.deskLeg, 0.8)
            g.fillRect(zone.deskX - 26, zone.deskY + 10, 3, 8)
            g.fillRect(zone.deskX + 23, zone.deskY + 10, 3, 8)

            // Monitor on desk
            g.fillStyle(C.monitorFrame, 0.6)
            g.fillRoundedRect(zone.deskX - 12, zone.deskY - 18, 24, 16, 2)
            g.fillStyle(C.monitor, 0.9)
            g.fillRect(zone.deskX - 10, zone.deskY - 16, 20, 12)
            // Monitor stand
            g.fillStyle(C.monitorFrame, 0.5)
            g.fillRect(zone.deskX - 2, zone.deskY - 2, 4, 4)

            // Chair (below desk)
            g.fillStyle(C.chair, 0.5)
            g.fillRoundedRect(zone.deskX - 10, zone.deskY + 22, 20, 8, 3)
            // Chair back
            g.fillStyle(C.chair, 0.4)
            g.fillRoundedRect(zone.deskX - 8, zone.deskY + 18, 16, 6, 2)
        }
    }

    // ─── Agent Sprites ───────────────────────────────────────

    private createAgentSprites() {
        const charKeys = Array.from(this.spritesheetKeys)

        for (const zone of ZONES) {
            const agentId = zone.id
            const color = AGENT_COLORS[agentId] ?? 0x6b7280

            // Glow (hidden by default)
            const glow = this.add.graphics()
            glow.setAlpha(0)
            this.agentGlows.set(agentId, glow)

            // Container: shadow + body
            const container = this.add.container(zone.agentX, zone.agentY)

            // Shadow
            const shadow = this.add.graphics()
            shadow.fillStyle(0x000000, 0.3)
            shadow.fillEllipse(0, 10, 20, 6)
            container.add(shadow)

            // Body — use spritesheet if available, otherwise graphics fallback
            if (charKeys.length > 0) {
                // Pick a character sprite based on zone index
                const zoneIdx = ZONES.indexOf(zone)
                const spriteKey = charKeys[zoneIdx % charKeys.length]
                const sprite = this.add.sprite(0, -8, spriteKey, 0)
                sprite.setScale(2)
                sprite.setTint(color)
                container.add(sprite)
            } else {
                // Graphics fallback: pixel character
                const body = this.add.graphics()
                // Head
                body.fillStyle(0xf0d0a0, 1)
                body.fillRect(-4, -16, 8, 8)
                // Hair
                body.fillStyle(color, 1)
                body.fillRect(-5, -18, 10, 4)
                // Body
                body.fillStyle(color, 1)
                body.fillRect(-5, -8, 10, 12)
                // Eyes
                body.fillStyle(0x1a1a2e, 1)
                body.fillRect(-3, -13, 2, 2)
                body.fillRect(1, -13, 2, 2)
                container.add(body)
            }

            this.agentSprites.set(agentId, container)

            // Name label below
            const label = this.add.text(zone.agentX, zone.agentY + 24, '', {
                fontSize: '10px',
                fontFamily: 'monospace',
                color: '#94a3b8',
                align: 'center',
            }).setOrigin(0.5, 0)
            this.agentLabels.set(agentId, label)

            // Initialize state
            this.agentStates.set(agentId, {
                id: agentId,
                name: agentId,
                role: agentId,
                status: 'idle',
            })
        }
    }

    // ─── Task Overlay ────────────────────────────────────────

    private createTaskOverlay() {
        // Background panel at top-center
        const bg = this.add.graphics()
        bg.fillStyle(C.taskBg, 0.85)
        bg.fillRoundedRect(SCENE_W / 2 - 200, 40, 400, 44, 6)
        bg.lineStyle(1, C.taskBorder, 0.4)
        bg.strokeRoundedRect(SCENE_W / 2 - 200, 40, 400, 44, 6)

        // Status dot
        this.taskStatusDot = this.add.graphics()
        this.drawStatusDot(0x6b7280)

        // Task title
        this.taskTitleText = this.add.text(SCENE_W / 2 - 180, 48, '等待任务...', {
            fontSize: '12px',
            fontFamily: 'monospace',
            color: '#e2e8f0',
        })

        // Task status
        this.taskStatusText = this.add.text(SCENE_W / 2 - 180, 64, 'idle', {
            fontSize: '10px',
            fontFamily: 'monospace',
            color: '#94a3b8',
        })
    }

    private drawStatusDot(color: number) {
        if (!this.taskStatusDot) return
        this.taskStatusDot.clear()
        this.taskStatusDot.fillStyle(color, 1)
        this.taskStatusDot.fillCircle(SCENE_W / 2 - 192, 62, 4)
    }

    // ─── State Update Handler ────────────────────────────────

    private onStateUpdate = (e: Event) => {
        const detail = (e as CustomEvent).detail as {
            instanceId?: string
            agents: AgentDisplayState[]
            task: TaskDisplayState | null
        }

        // Guard: ignore events if this scene has no instanceId yet (not initialized)
        if (!this.instanceId) return
        // Only process events from our own instance
        if (!detail.instanceId || detail.instanceId !== this.instanceId) return

        // Update agents
        for (const agent of detail.agents) {
            this.updateAgentVisual(agent)
        }

        // Update task overlay
        if (detail.task) {
            this.updateTaskOverlay(detail.task)
        } else {
            this.taskTitleText?.setText('等待任务...')
            this.taskStatusText?.setText('idle')
            this.drawStatusDot(0x6b7280)
        }
    }

    private updateAgentVisual(agent: AgentDisplayState) {
        this.agentStates.set(agent.id, agent)

        const sprite = this.agentSprites.get(agent.id)
        const glow = this.agentGlows.get(agent.id)
        const label = this.agentLabels.get(agent.id)
        if (!sprite || !glow || !label) return

        // Update label
        label.setText(agent.name)

        // Clear existing pulse
        const existingTimer = this.pulseTimers.get(agent.id)
        if (existingTimer) {
            existingTimer.destroy()
            this.pulseTimers.delete(agent.id)
        }

        const zone = ZONES.find(z => z.id === agent.id)
        const baseY = zone?.agentY ?? sprite.y

        switch (agent.status) {
            case 'active': {
                // Show glow + pulse
                if (zone) {
                    const color = AGENT_COLORS[agent.id] ?? 0x3b82f6
                    glow.clear()
                    glow.fillStyle(color, 0.3)
                    glow.fillCircle(zone.agentX, zone.agentY, 28)
                    glow.setAlpha(1)
                }

                // Pulse tween
                this.tweens.add({
                    targets: glow,
                    alpha: { from: 0.8, to: 0.2 },
                    duration: 800,
                    yoyo: true,
                    repeat: -1,
                })

                // Idle bounce
                this.tweens.add({
                    targets: sprite,
                    y: baseY - 3,
                    duration: 600,
                    yoyo: true,
                    repeat: -1,
                    ease: 'Sine.easeInOut',
                })

                label.setColor('#e2e8f0')
                break
            }
            case 'completed': {
                glow.setAlpha(0)
                this.tweens.killTweensOf(sprite)
                this.tweens.killTweensOf(glow)
                sprite.y = baseY
                label.setColor('#22c55e')
                break
            }
            case 'failed': {
                glow.setAlpha(0)
                this.tweens.killTweensOf(sprite)
                this.tweens.killTweensOf(glow)
                sprite.y = baseY
                label.setColor('#ef4444')
                break
            }
            default: {
                // Idle
                glow.setAlpha(0)
                this.tweens.killTweensOf(sprite)
                this.tweens.killTweensOf(glow)
                sprite.y = baseY
                label.setColor('#94a3b8')
                break
            }
        }
    }

    private updateTaskOverlay(task: TaskDisplayState) {
        this.taskTitleText?.setText(task.title || '无任务')
        this.taskStatusText?.setText(task.status)
        const color = STATUS_COLORS[task.status] ?? 0x6b7280
        this.drawStatusDot(color)
    }
}
