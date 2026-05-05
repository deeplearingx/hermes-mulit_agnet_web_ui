// ─── Asset Manifest ─────────────────────────────────────────
// Maps logical asset keys to file paths in group_assets/.
// Uses Vite's import.meta.url for correct asset resolution.
// Phase 6: spritesheet loading for characters, removed RPG items/weapons.

const ASSET_BASE = new URL('../../../../../group_assets', import.meta.url).href

/** Office tilemap for floor/walls */
export const OFFICE_TILEMAP = `${ASSET_BASE}/office/office-tilemap.png`

/** Character sprites (1-25) — each is a 64×112 spritesheet (4×7 frames of 16×16) */
export const CHARACTERS = Array.from({ length: 25 }, (_, i) => ({
    key: `char_${i + 1}`,
    url: `${ASSET_BASE}/ninja-adventure/characters/${i + 1}.png`,
}))

/** HUD elements */
export const HUD = {
    bubble: `${ASSET_BASE}/ninja-adventure/hud/dialogue-bubble.png`,
    heart: `${ASSET_BASE}/ninja-adventure/hud/heart.png`,
    arrow: `${ASSET_BASE}/ninja-adventure/hud/arrow.png`,
}

// TODO: desk/monitor/chair assets not available in group_assets/office/.
// Currently using code-drawn fallback in GroupOfficeScene.drawFurniture().
// When pixel art assets are provided, add:
//   export const OFFICE_PROPS = { desk: '...', monitor: '...', chair: '...' }
// and load them in loadWorkspaceAssets().

/**
 * Load all workspace assets into a Phaser scene.
 * Call this in a BootScene's preload() method.
 */
export function loadWorkspaceAssets(scene: Phaser.Scene): void {
    // Office tilemap
    scene.load.image('office_tilemap', OFFICE_TILEMAP)

    // V1: Character sprites — load as spritesheet (16×16 frames)
    for (const char of CHARACTERS) {
        scene.load.spritesheet(char.key, char.url, {
            frameWidth: 16,
            frameHeight: 16,
        })
    }

    // HUD
    scene.load.image('hud_bubble', HUD.bubble)
    scene.load.image('hud_heart', HUD.heart)

    // V5: Removed RPG items/weapons — using code-generated PixelIcons instead.
    // Status icons (terminal, file, code, check, error, tool, gear, think, memory)
    // are drawn programmatically via PixelIcons.ts, no asset loading needed.
}
