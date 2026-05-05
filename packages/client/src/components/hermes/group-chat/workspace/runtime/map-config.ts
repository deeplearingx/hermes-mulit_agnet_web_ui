// ─── Map Configuration ─────────────────────────────────────
// Centralized zone/seat/status configuration for the workspace.
// P8-7: Extracted from types.ts to unify zone rects, seats, and status mappings.

/** Zone rectangle definition */
export interface ZoneRect {
    key: string
    x: number
    y: number
    w: number
    h: number
}

/** Zone rectangles — used by drawZones() and detectZone() */
export const ZONE_RECTS: ZoneRect[] = [
    { key: 'requirement', x: 32,  y: 48,  w: 288, h: 240 },
    { key: 'planning',    x: 336, y: 48,  w: 256, h: 240 },
    { key: 'coding',      x: 608, y: 48,  w: 288, h: 240 },
    { key: 'review',      x: 32,  y: 320, w: 432, h: 208 },
    { key: 'delivery',    x: 496, y: 320, w: 400, h: 208 },
]

/** Per-zone seat positions — 4 seats per zone, 20 total */
export const ZONE_SEATS: Record<string, Array<{ x: number; y: number }>> = {
    requirement: [
        { x: 100, y: 120 }, { x: 200, y: 120 },
        { x: 100, y: 220 }, { x: 200, y: 220 },
    ],
    planning: [
        { x: 380, y: 120 }, { x: 460, y: 120 },
        { x: 380, y: 220 }, { x: 460, y: 220 },
    ],
    coding: [
        { x: 660, y: 120 }, { x: 760, y: 120 },
        { x: 660, y: 220 }, { x: 760, y: 220 },
    ],
    review: [
        { x: 120, y: 370 }, { x: 240, y: 370 },
        { x: 120, y: 450 }, { x: 240, y: 450 },
    ],
    delivery: [
        { x: 560, y: 370 }, { x: 680, y: 370 },
        { x: 560, y: 450 }, { x: 680, y: 450 },
    ],
}

/** Task status → workspace phase mapping (P8-6) */
export const STATUS_TO_PHASE: Record<string, string> = {
    draft: 'requirement',
    planning: 'planning',
    running: 'coding',
    reviewing: 'review',
    done: 'delivery',
}
