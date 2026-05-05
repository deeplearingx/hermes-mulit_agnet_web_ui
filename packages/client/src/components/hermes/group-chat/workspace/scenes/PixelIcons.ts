// ─── Pixel Icons ─────────────────────────────────────────────
// Code-generated 16×16 pixel art icons for programming semantics.
// Replaces RPG items/weapons with AI-IDE-appropriate icons.

import Phaser from 'phaser'

/** Draw a terminal/console icon (>_ cursor) */
export function drawTerminalIcon(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number): void {
    // Screen frame
    g.fillStyle(0x1e293b)
    g.fillRect(x, y, 16, 12)
    g.lineStyle(1, color, 0.8)
    g.strokeRect(x, y, 16, 12)
    // > prompt
    g.fillStyle(color)
    g.fillRect(x + 2, y + 3, 3, 1)
    g.fillRect(x + 3, y + 4, 2, 1)
    g.fillRect(x + 2, y + 5, 3, 1)
    // Cursor line
    g.fillRect(x + 6, y + 3, 5, 1)
    // Blinking cursor
    g.fillRect(x + 6, y + 5, 2, 1)
    // Stand
    g.fillStyle(0x475569)
    g.fillRect(x + 5, y + 12, 6, 2)
    g.fillRect(x + 3, y + 14, 10, 1)
}

/** Draw a file/document icon */
export function drawFileIcon(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number): void {
    // File body
    g.fillStyle(0x1e293b)
    g.fillRect(x + 2, y, 12, 16)
    // Folded corner
    g.fillStyle(color, 0.3)
    g.fillRect(x + 2, y, 8, 1)
    g.fillRect(x + 9, y, 1, 4)
    g.fillRect(x + 2, y + 4, 8, 1)
    // Content lines
    g.fillStyle(color, 0.6)
    g.fillRect(x + 4, y + 6, 8, 1)
    g.fillRect(x + 4, y + 8, 6, 1)
    g.fillRect(x + 4, y + 10, 8, 1)
    g.fillRect(x + 4, y + 12, 5, 1)
    // Border
    g.lineStyle(1, color, 0.5)
    g.strokeRect(x + 2, y, 12, 16)
}

/** Draw a code/brackets icon </> */
export function drawCodeIcon(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number): void {
    g.fillStyle(color)
    // <
    g.fillRect(x + 3, y + 7, 1, 2)
    g.fillRect(x + 2, y + 6, 1, 4)
    g.fillRect(x + 1, y + 7, 1, 2)
    // /
    g.fillRect(x + 6, y + 4, 1, 2)
    g.fillRect(x + 7, y + 6, 1, 2)
    g.fillRect(x + 8, y + 8, 1, 2)
    g.fillRect(x + 9, y + 10, 1, 2)
    // >
    g.fillRect(x + 12, y + 7, 1, 2)
    g.fillRect(x + 13, y + 6, 1, 4)
    g.fillRect(x + 14, y + 7, 1, 2)
}

/** Draw a checkmark icon (success) */
export function drawCheckIcon(g: Phaser.GameObjects.Graphics, x: number, y: number): void {
    g.fillStyle(0x22c55e)
    // Checkmark path
    g.fillRect(x + 2, y + 8, 2, 2)
    g.fillRect(x + 4, y + 10, 2, 2)
    g.fillRect(x + 6, y + 10, 2, 2)
    g.fillRect(x + 8, y + 8, 2, 2)
    g.fillRect(x + 10, y + 6, 2, 2)
    g.fillRect(x + 12, y + 4, 2, 2)
    // Circle outline
    g.lineStyle(1, 0x22c55e, 0.4)
    g.strokeCircle(x + 8, y + 8, 7)
}

/** Draw an X/error icon */
export function drawErrorIcon(g: Phaser.GameObjects.Graphics, x: number, y: number): void {
    g.fillStyle(0xef4444)
    // X shape
    g.fillRect(x + 3, y + 3, 2, 2)
    g.fillRect(x + 11, y + 3, 2, 2)
    g.fillRect(x + 5, y + 5, 2, 2)
    g.fillRect(x + 9, y + 5, 2, 2)
    g.fillRect(x + 7, y + 7, 2, 2)
    g.fillRect(x + 5, y + 9, 2, 2)
    g.fillRect(x + 9, y + 9, 2, 2)
    g.fillRect(x + 3, y + 11, 2, 2)
    g.fillRect(x + 11, y + 11, 2, 2)
    // Circle outline
    g.lineStyle(1, 0xef4444, 0.4)
    g.strokeCircle(x + 8, y + 8, 7)
}

/** Draw a wrench/tool icon */
export function drawToolIcon(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number): void {
    g.fillStyle(color)
    // Wrench head
    g.fillRect(x + 2, y + 1, 4, 3)
    g.fillRect(x + 1, y + 2, 1, 1)
    g.fillRect(x + 6, y + 2, 1, 1)
    // Wrench shaft
    g.fillRect(x + 3, y + 4, 2, 8)
    // Handle
    g.fillRect(x + 2, y + 12, 4, 2)
    g.fillRect(x + 1, y + 13, 6, 1)
}

/** Draw a gear/settings icon */
export function drawGearIcon(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number): void {
    g.fillStyle(color)
    // Center
    g.fillRect(x + 6, y + 6, 4, 4)
    // Teeth
    g.fillRect(x + 7, y + 2, 2, 3)
    g.fillRect(x + 7, y + 11, 2, 3)
    g.fillRect(x + 2, y + 7, 3, 2)
    g.fillRect(x + 11, y + 7, 3, 2)
    // Diagonal teeth
    g.fillRect(x + 3, y + 3, 2, 2)
    g.fillRect(x + 11, y + 3, 2, 2)
    g.fillRect(x + 3, y + 11, 2, 2)
    g.fillRect(x + 11, y + 11, 2, 2)
    // Center hole
    g.fillStyle(0x0f1729)
    g.fillRect(x + 7, y + 7, 2, 2)
}

/** Draw a thinking/brain icon */
export function drawThinkIcon(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number): void {
    g.fillStyle(color, 0.8)
    // Thought bubble
    g.fillCircle(x + 8, y + 6, 5)
    // Dots
    g.fillCircle(x + 5, y + 13, 1)
    g.fillCircle(x + 3, y + 15, 1)
    // Inner detail
    g.fillStyle(0x0f1729, 0.5)
    g.fillRect(x + 6, y + 4, 4, 1)
    g.fillRect(x + 5, y + 6, 6, 1)
    g.fillRect(x + 6, y + 8, 4, 1)
}

/** Draw a memory/database icon */
export function drawMemoryIcon(g: Phaser.GameObjects.Graphics, x: number, y: number, color: number): void {
    g.fillStyle(color, 0.6)
    // Stack of layers
    g.fillRect(x + 2, y + 2, 12, 3)
    g.fillRect(x + 2, y + 6, 12, 3)
    g.fillRect(x + 2, y + 10, 12, 3)
    // Lines on layers
    g.fillStyle(color, 0.9)
    g.fillRect(x + 4, y + 3, 4, 1)
    g.fillRect(x + 4, y + 7, 6, 1)
    g.fillRect(x + 4, y + 11, 3, 1)
}
