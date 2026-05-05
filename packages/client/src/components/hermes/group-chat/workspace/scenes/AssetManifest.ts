// ─── Asset Manifest ─────────────────────────────────────────
// Maps logical asset keys to file paths in group_assets/.
// Uses Vite's import.meta.url for correct asset resolution.

const ASSET_BASE = new URL('../../../../../group_assets', import.meta.url).href

/** Office tilemap for floor/walls */
export const OFFICE_TILEMAP = `${ASSET_BASE}/office/office-tilemap.png`

/** Character sprites (1-25) — each is a standalone pixel character */
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

/** Items used as status/role icons */
export const ITEMS = {
    scroll: `${ASSET_BASE}/ninja-adventure/items/scroll-empty.png`,
    goldCoin: `${ASSET_BASE}/ninja-adventure/items/gold-coin.png`,
    silverCoin: `${ASSET_BASE}/ninja-adventure/items/silver-coin.png`,
    heart: `${ASSET_BASE}/ninja-adventure/items/heart.png`,
    goldKey: `${ASSET_BASE}/ninja-adventure/items/gold-key.png`,
    silverKey: `${ASSET_BASE}/ninja-adventure/items/silver-key.png`,
    lifePot: `${ASSET_BASE}/ninja-adventure/items/life-pot.png`,
    fireball: `${ASSET_BASE}/ninja-adventure/items/fireball.png`,
}

/** Weapons used as tool/action icons */
export const WEAPONS = {
    hammer: `${ASSET_BASE}/ninja-adventure/weapons/hammer.png`,
    sword: `${ASSET_BASE}/ninja-adventure/weapons/sword.png`,
    axe: `${ASSET_BASE}/ninja-adventure/weapons/axe.png`,
    katana: `${ASSET_BASE}/ninja-adventure/weapons/katana.png`,
}

/** FX for status effects */
export const FX = {
    success: `${ASSET_BASE}/ninja-adventure/fx/3.png`,
    fail: `${ASSET_BASE}/ninja-adventure/fx/6.png`,
    sparkle: `${ASSET_BASE}/ninja-adventure/fx/2.png`,
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

    // Character sprites
    for (const char of CHARACTERS) {
        scene.load.image(char.key, char.url)
    }

    // HUD
    scene.load.image('hud_bubble', HUD.bubble)
    scene.load.image('hud_heart', HUD.heart)

    // Items
    scene.load.image('item_scroll', ITEMS.scroll)
    scene.load.image('item_gold_coin', ITEMS.goldCoin)
    scene.load.image('item_silver_coin', ITEMS.silverCoin)
    scene.load.image('item_heart', ITEMS.heart)
    scene.load.image('item_gold_key', ITEMS.goldKey)
    scene.load.image('item_life_pot', ITEMS.lifePot)
    scene.load.image('item_fireball', ITEMS.fireball)

    // Weapons
    scene.load.image('weapon_hammer', WEAPONS.hammer)
    scene.load.image('weapon_sword', WEAPONS.sword)
    scene.load.image('weapon_katana', WEAPONS.katana)

    // FX
    scene.load.image('fx_success', FX.success)
    scene.load.image('fx_fail', FX.fail)
    scene.load.image('fx_sparkle', FX.sparkle)
}
