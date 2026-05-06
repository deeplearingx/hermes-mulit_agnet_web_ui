// ─── Agent Room Asset Manifest ────────────────────────────────
// Maps logical asset keys to file paths in group_assets/.
// Pure resource paths — no group-chat store, Socket, or runtime data.
// Uses Vite's import.meta.url for correct asset resolution.

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

/**
 * Load all Agent Room workspace assets into a Phaser scene.
 * Call this in AgentRoomBootScene's preload() method.
 * Individual load failures are handled by the BootScene's loaderror listener.
 */
export function loadAgentRoomAssets(scene: Phaser.Scene): void {
    // Office tilemap
    scene.load.image('office_tilemap', OFFICE_TILEMAP)

    // Character sprites — load as spritesheet (16×16 frames)
    for (const char of CHARACTERS) {
        scene.load.spritesheet(char.key, char.url, {
            frameWidth: 16,
            frameHeight: 16,
        })
    }

    // HUD
    scene.load.image('hud_bubble', HUD.bubble)
    scene.load.image('hud_heart', HUD.heart)
}
