// ─── Agent Room Office Scene ──────────────────────────────────
// Lightweight Phaser scene for Agent Room pixel workspace.
// Pure display — no drag, no click, no layout persistence.
// Independent from group-chat/workspace/scenes/.

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
}

// ─── Agent role → color ──────────────────────────────────────
const AGENT_COLORS: Record<string, number> = {
    conversation: 0x3b82f6,
    planner:      0xa855f7,
    developer:    0x22c55e,
    reviewer:     0xf59e0b,
    delivery:     0x06b6d4,
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

// ─── Fixed agent positions ───────────────────────────────────
const AGENT_POSITIONS: Record<string, { x: number; y: number }> = {
    conversation: { x: 160, y: 160 },
    planner:      { x: 800, y: 160 },
    developer:    { x: 480, y: 300 },
    reviewer:     { x: 160, y: 420 },
    delivery:     { x: 800, y: 420 },
}

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

    constructor(instanceId: string) {
        super({ key: 'AgentRoomOfficeScene' })
        this.instanceId = instanceId
    }

    /** Legacy compatibility — no longer required when using constructor injection */
    setInstanceId(id: string) {
        this.instanceId = id
    }

    create() {
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
        g.fillStyle(C.wall)
        g.fillRect(0, 0, SCENE_W, TILE * 2)
        g.fillStyle(C.wallTop)
        g.fillRect(0, TILE * 2 - 2, SCENE_W, 2)
        g.fillStyle(C.wall)
        g.fillRect(0, 0, TILE, SCENE_H)
        g.fillRect(SCENE_W - TILE, 0, TILE, SCENE_H)
    }

    private drawZones() {
        // Central work zone
        const g = this.add.graphics()
        g.fillStyle(C.zoneBg, 0.08)
        g.fillRoundedRect(80, 60, SCENE_W - 160, SCENE_H - 100, 8)
        g.lineStyle(1, C.zoneBorder, 0.15)
        g.strokeRoundedRect(80, 60, SCENE_W - 160, SCENE_H - 100, 8)

        // Zone label
        const labelBg = this.add.graphics()
        labelBg.fillStyle(C.labelBg, 0.6)
        labelBg.fillRoundedRect(84, 64, 120, 18, 3)
        this.add.text(88, 66, '🏢 Agent 工作室', {
            fontSize: '10px',
            fontFamily: 'monospace',
            color: '#94a3b8',
        })
    }

    private drawFurniture() {
        // Draw a desk-like rectangle under each agent position
        for (const [, pos] of Object.entries(AGENT_POSITIONS)) {
            const g = this.add.graphics()
            // Desk surface
            g.fillStyle(0x2d3748, 0.6)
            g.fillRoundedRect(pos.x - 24, pos.y + 12, 48, 8, 2)
            // Desk legs
            g.fillStyle(0x1a202c, 0.8)
            g.fillRect(pos.x - 22, pos.y + 20, 3, 6)
            g.fillRect(pos.x + 19, pos.y + 20, 3, 6)
        }
    }

    // ─── Agent Sprites ───────────────────────────────────────

    private createAgentSprites() {
        for (const agentId of Object.keys(AGENT_POSITIONS)) {
            const pos = AGENT_POSITIONS[agentId]
            const color = AGENT_COLORS[agentId] ?? 0x6b7280

            // Glow (hidden by default)
            const glow = this.add.graphics()
            glow.setAlpha(0)
            this.agentGlows.set(agentId, glow)

            // Container: shadow + body
            const container = this.add.container(pos.x, pos.y)

            // Shadow
            const shadow = this.add.graphics()
            shadow.fillStyle(0x000000, 0.3)
            shadow.fillEllipse(0, 10, 20, 6)
            container.add(shadow)

            // Body (simple pixel character)
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

            this.agentSprites.set(agentId, container)

            // Name label below
            const label = this.add.text(pos.x, pos.y + 24, '', {
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

        switch (agent.status) {
            case 'active': {
                // Show glow + pulse
                const pos = AGENT_POSITIONS[agent.id]
                if (pos) {
                    const color = AGENT_COLORS[agent.id] ?? 0x3b82f6
                    glow.clear()
                    glow.fillStyle(color, 0.3)
                    glow.fillCircle(pos.x, pos.y, 24)
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
                    y: sprite.y - 3,
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
                const pos = AGENT_POSITIONS[agent.id]
                if (pos) sprite.y = pos.y
                label.setColor('#22c55e')
                break
            }
            case 'failed': {
                glow.setAlpha(0)
                this.tweens.killTweensOf(sprite)
                this.tweens.killTweensOf(glow)
                const pos = AGENT_POSITIONS[agent.id]
                if (pos) sprite.y = pos.y
                label.setColor('#ef4444')
                break
            }
            default: {
                // Idle
                glow.setAlpha(0)
                this.tweens.killTweensOf(sprite)
                this.tweens.killTweensOf(glow)
                const pos = AGENT_POSITIONS[agent.id]
                if (pos) sprite.y = pos.y
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
