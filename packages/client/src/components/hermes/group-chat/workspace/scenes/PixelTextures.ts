// ─── Pixel Textures ─────────────────────────────────────────
// Programmatically generates pixel-art textures for the workspace.
// No external PNG files needed — all textures are created via CanvasTexture.

import Phaser from 'phaser'

const PX = 2 // pixel scale for textures

/**
 * Generate all workspace textures. Call once in scene.create() or preload().
 */
export function generateTextures(scene: Phaser.Scene): void {
    generateAgentTextures(scene)
    generateFurnitureTextures(scene)
    generateIconTextures(scene)
    generateStatusTextures(scene)
}

// ─── Agent Textures ─────────────────────────────────────────

function generateAgentTextures(scene: Phaser.Scene): void {
    // Agent body — 16x16 pixel art character (scaled 2x = 32x32)
    const size = 16 * PX
    const colors = [
        0x3b82f6, 0x22c55e, 0xf59e0b, 0xa855f7,
        0xef4444, 0x06b6d4, 0xec4899, 0x84cc16,
    ]

    for (let i = 0; i < colors.length; i++) {
        const key = `agent_${i}`
        const tex = scene.textures.createCanvas(key, size, size)
        if (!tex) continue
        const ctx = tex.getContext()
        const c = colors[i]

        drawPixelAgent(ctx, 0, 0, PX, c)
        tex.refresh()
    }

    // Agent shadow
    const shadowTex = scene.textures.createCanvas('agent_shadow', size, size)
    if (shadowTex) {
        const ctx = shadowTex.getContext()
        ctx.fillStyle = 'rgba(0,0,0,0.3)'
        ctx.beginPath()
        ctx.ellipse(size / 2, size - 2 * PX, 6 * PX, 2 * PX, 0, 0, Math.PI * 2)
        ctx.fill()
        shadowTex.refresh()
    }
}

function drawPixelAgent(ctx: CanvasRenderingContext2D, ox: number, oy: number, px: number, color: number): void {
    const r = (color >> 16) & 0xff
    const g = (color >> 8) & 0xff
    const b = color & 0xff
    const base = `rgb(${r},${g},${b})`
    const dark = `rgb(${Math.max(0, r - 40)},${Math.max(0, g - 40)},${Math.max(0, b - 40)})`
    const light = `rgb(${Math.min(255, r + 60)},${Math.min(255, g + 60)},${Math.min(255, b + 60)})`

    // Hair (top)
    ctx.fillStyle = dark
    fillPixels(ctx, ox, oy, px, [
        [3, 0, 4, 1],
        [2, 1, 6, 1],
    ])

    // Head
    ctx.fillStyle = '#f0d0a0'
    fillPixels(ctx, ox, oy, px, [
        [3, 2, 4, 1],
        [2, 3, 6, 1],
        [2, 4, 6, 1],
        [3, 5, 4, 1],
    ])

    // Eyes
    ctx.fillStyle = '#1a1a2e'
    fillPixels(ctx, ox, oy, px, [
        [3, 3, 1, 1],
        [6, 3, 1, 1],
    ])

    // Body
    ctx.fillStyle = base
    fillPixels(ctx, ox, oy, px, [
        [3, 6, 4, 1],
        [2, 7, 6, 1],
        [2, 8, 6, 1],
        [2, 9, 6, 1],
        [2, 10, 6, 1],
    ])

    // Body highlight
    ctx.fillStyle = light
    fillPixels(ctx, ox, oy, px, [
        [3, 7, 1, 3],
    ])

    // Arms
    ctx.fillStyle = base
    fillPixels(ctx, ox, oy, px, [
        [1, 7, 1, 3],
        [8, 7, 1, 3],
    ])

    // Legs
    ctx.fillStyle = '#2d3748'
    fillPixels(ctx, ox, oy, px, [
        [3, 11, 2, 2],
        [5, 11, 2, 2],
    ])

    // Shoes
    ctx.fillStyle = '#1a1a2e'
    fillPixels(ctx, ox, oy, px, [
        [3, 13, 2, 1],
        [5, 13, 2, 1],
    ])
}

// ─── Furniture Textures ─────────────────────────────────────

function generateFurnitureTextures(scene: Phaser.Scene): void {
    // Desk — 32x16
    const deskTex = scene.textures.createCanvas('desk', 32 * PX, 16 * PX)
    if (deskTex) {
        const ctx = deskTex.getContext()
        // Desk top
        ctx.fillStyle = '#4b5563'
        ctx.fillRect(0, 0, 32 * PX, 3 * PX)
        // Desk body
        ctx.fillStyle = '#374151'
        ctx.fillRect(0, 3 * PX, 32 * PX, 13 * PX)
        // Desk highlight
        ctx.fillStyle = '#6b7280'
        ctx.fillRect(0, 0, 32 * PX, PX)
        // Legs
        ctx.fillStyle = '#1f2937'
        ctx.fillRect(PX, 3 * PX, 2 * PX, 13 * PX)
        ctx.fillRect(29 * PX, 3 * PX, 2 * PX, 13 * PX)
        deskTex.refresh()
    }

    // Monitor — 16x16
    const monitorTex = scene.textures.createCanvas('monitor', 16 * PX, 16 * PX)
    if (monitorTex) {
        const ctx = monitorTex.getContext()
        // Monitor frame
        ctx.fillStyle = '#111827'
        ctx.fillRect(2 * PX, 0, 12 * PX, 10 * PX)
        // Screen
        ctx.fillStyle = '#1e3a5f'
        ctx.fillRect(3 * PX, PX, 10 * PX, 8 * PX)
        // Screen glow
        ctx.fillStyle = '#2563eb'
        ctx.fillRect(4 * PX, 2 * PX, 8 * PX, 6 * PX)
        // Stand
        ctx.fillStyle = '#111827'
        ctx.fillRect(6 * PX, 10 * PX, 4 * PX, 3 * PX)
        // Base
        ctx.fillRect(4 * PX, 13 * PX, 8 * PX, PX)
        monitorTex.refresh()
    }

    // Chair — 12x12
    const chairTex = scene.textures.createCanvas('chair', 12 * PX, 12 * PX)
    if (chairTex) {
        const ctx = chairTex.getContext()
        // Back
        ctx.fillStyle = '#4b5563'
        ctx.fillRect(PX, 0, 10 * PX, 4 * PX)
        // Seat
        ctx.fillStyle = '#6b7280'
        ctx.fillRect(0, 4 * PX, 12 * PX, 3 * PX)
        // Legs
        ctx.fillStyle = '#374151'
        ctx.fillRect(PX, 7 * PX, 2 * PX, 5 * PX)
        ctx.fillRect(9 * PX, 7 * PX, 2 * PX, 5 * PX)
        chairTex.refresh()
    }

    // Plant — 8x16
    const plantTex = scene.textures.createCanvas('plant', 8 * PX, 16 * PX)
    if (plantTex) {
        const ctx = plantTex.getContext()
        // Pot
        ctx.fillStyle = '#92400e'
        ctx.fillRect(PX, 10 * PX, 6 * PX, 6 * PX)
        ctx.fillStyle = '#b45309'
        ctx.fillRect(0, 9 * PX, 8 * PX, 2 * PX)
        // Leaves
        ctx.fillStyle = '#22c55e'
        ctx.fillRect(2 * PX, 2 * PX, 4 * PX, 8 * PX)
        ctx.fillStyle = '#16a34a'
        ctx.fillRect(0, 4 * PX, 2 * PX, 4 * PX)
        ctx.fillRect(6 * PX, 3 * PX, 2 * PX, 5 * PX)
        ctx.fillStyle = '#15803d'
        ctx.fillRect(3 * PX, 0, 2 * PX, 3 * PX)
        plantTex.refresh()
    }

    // Whiteboard — 32x24
    const wbTex = scene.textures.createCanvas('whiteboard', 32 * PX, 24 * PX)
    if (wbTex) {
        const ctx = wbTex.getContext()
        // Frame
        ctx.fillStyle = '#6b7280'
        ctx.fillRect(0, 0, 32 * PX, 24 * PX)
        // Board
        ctx.fillStyle = '#f1f5f9'
        ctx.fillRect(PX, PX, 30 * PX, 22 * PX)
        // Scribbles
        ctx.strokeStyle = '#3b82f6'
        ctx.lineWidth = PX
        ctx.beginPath()
        ctx.moveTo(4 * PX, 6 * PX)
        ctx.lineTo(12 * PX, 6 * PX)
        ctx.stroke()
        ctx.strokeStyle = '#ef4444'
        ctx.beginPath()
        ctx.moveTo(4 * PX, 10 * PX)
        ctx.lineTo(20 * PX, 10 * PX)
        ctx.stroke()
        ctx.strokeStyle = '#22c55e'
        ctx.beginPath()
        ctx.moveTo(4 * PX, 14 * PX)
        ctx.lineTo(16 * PX, 14 * PX)
        ctx.stroke()
        wbTex.refresh()
    }
}

// ─── Icon Textures ──────────────────────────────────────────

function generateIconTextures(scene: Phaser.Scene): void {
    // Tool icon (wrench) — 12x12
    const toolTex = scene.textures.createCanvas('icon_tool', 12 * PX, 12 * PX)
    if (toolTex) {
        const ctx = toolTex.getContext()
        ctx.fillStyle = '#a78bfa'
        // Handle
        ctx.fillRect(2 * PX, 8 * PX, 8 * PX, 2 * PX)
        // Head
        ctx.fillRect(4 * PX, 2 * PX, 4 * PX, 6 * PX)
        ctx.fillRect(2 * PX, 2 * PX, 2 * PX, 3 * PX)
        ctx.fillRect(8 * PX, 2 * PX, 2 * PX, 3 * PX)
        toolTex.refresh()
    }

    // File icon — 10x12
    const fileTex = scene.textures.createCanvas('icon_file', 10 * PX, 12 * PX)
    if (fileTex) {
        const ctx = fileTex.getContext()
        ctx.fillStyle = '#60a5fa'
        ctx.fillRect(PX, 0, 8 * PX, 12 * PX)
        ctx.fillStyle = '#93c5fd'
        ctx.fillRect(PX, 0, 8 * PX, PX)
        // Lines
        ctx.fillStyle = '#1e3a5f'
        ctx.fillRect(3 * PX, 3 * PX, 4 * PX, PX)
        ctx.fillRect(3 * PX, 5 * PX, 4 * PX, PX)
        ctx.fillRect(3 * PX, 7 * PX, 3 * PX, PX)
        fileTex.refresh()
    }

    // Error icon — 12x12
    const errorTex = scene.textures.createCanvas('icon_error', 12 * PX, 12 * PX)
    if (errorTex) {
        const ctx = errorTex.getContext()
        ctx.fillStyle = '#ef4444'
        ctx.beginPath()
        ctx.arc(6 * PX, 6 * PX, 5 * PX, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(5 * PX, 3 * PX, 2 * PX, 4 * PX)
        ctx.fillRect(5 * PX, 8 * PX, 2 * PX, 2 * PX)
        errorTex.refresh()
    }

    // Check icon — 12x12
    const checkTex = scene.textures.createCanvas('icon_check', 12 * PX, 12 * PX)
    if (checkTex) {
        const ctx = checkTex.getContext()
        ctx.fillStyle = '#22c55e'
        ctx.beginPath()
        ctx.arc(6 * PX, 6 * PX, 5 * PX, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(3 * PX, 5 * PX, 2 * PX, 2 * PX)
        ctx.fillRect(5 * PX, 7 * PX, 2 * PX, 2 * PX)
        ctx.fillRect(7 * PX, 4 * PX, 2 * PX, 3 * PX)
        checkTex.refresh()
    }

    // Clock icon — 12x12
    const clockTex = scene.textures.createCanvas('icon_clock', 12 * PX, 12 * PX)
    if (clockTex) {
        const ctx = clockTex.getContext()
        ctx.fillStyle = '#94a3b8'
        ctx.beginPath()
        ctx.arc(6 * PX, 6 * PX, 5 * PX, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#0f172a'
        ctx.beginPath()
        ctx.arc(6 * PX, 6 * PX, 4 * PX, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#e2e8f0'
        ctx.fillRect(5.5 * PX, 3 * PX, PX, 3 * PX)
        ctx.fillRect(6 * PX, 5.5 * PX, 3 * PX, PX)
        clockTex.refresh()
    }
}

// ─── Status Textures ────────────────────────────────────────

function generateStatusTextures(scene: Phaser.Scene): void {
    const statuses: Array<{ key: string; color: string }> = [
        { key: 'status_idle', color: '#6b7280' },
        { key: 'status_compressing', color: '#f59e0b' },
        { key: 'status_replying', color: '#3b82f6' },
        { key: 'status_thinking', color: '#a855f7' },
        { key: 'status_calling_tool', color: '#8b5cf6' },
        { key: 'status_completed', color: '#22c55e' },
        { key: 'status_failed', color: '#ef4444' },
    ]

    for (const s of statuses) {
        const tex = scene.textures.createCanvas(s.key, 8 * PX, 8 * PX)
        if (!tex) continue
        const ctx = tex.getContext()
        ctx.fillStyle = s.color
        ctx.beginPath()
        ctx.arc(4 * PX, 4 * PX, 3 * PX, 0, Math.PI * 2)
        ctx.fill()
        // Highlight
        ctx.fillStyle = 'rgba(255,255,255,0.3)'
        ctx.beginPath()
        ctx.arc(3 * PX, 3 * PX, PX, 0, Math.PI * 2)
        ctx.fill()
        tex.refresh()
    }

    // Speech bubble — 40x20
    const bubbleTex = scene.textures.createCanvas('bubble', 40 * PX, 20 * PX)
    if (bubbleTex) {
        const ctx = bubbleTex.getContext()
        ctx.fillStyle = '#1e293b'
        roundRect(ctx, 0, 0, 40 * PX, 16 * PX, 3 * PX)
        ctx.fill()
        ctx.strokeStyle = '#475569'
        ctx.lineWidth = PX
        roundRect(ctx, 0, 0, 40 * PX, 16 * PX, 3 * PX)
        ctx.stroke()
        // Tail
        ctx.fillStyle = '#1e293b'
        ctx.beginPath()
        ctx.moveTo(16 * PX, 16 * PX)
        ctx.lineTo(20 * PX, 20 * PX)
        ctx.lineTo(24 * PX, 16 * PX)
        ctx.fill()
        bubbleTex.refresh()
    }
}

// ─── Helpers ────────────────────────────────────────────────

function fillPixels(
    ctx: CanvasRenderingContext2D,
    ox: number, oy: number, px: number,
    rects: Array<[x: number, y: number, w: number, h: number]>,
): void {
    for (const [x, y, w, h] of rects) {
        ctx.fillRect(ox + x * px, oy + y * px, w * px, h * px)
    }
}

function roundRect(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, r: number,
): void {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r)
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x + r, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - r)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()
}
