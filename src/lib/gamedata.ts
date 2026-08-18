// Weapon, item and character names. These are not in the Alpine repo - the game
// loads them from its own table files at runtime - so they are extracted once
// from tables.vpp by tools/extract-tables.mjs and checked in.
//
// A total conversion mod can rename all of these. That is accepted: running a TC
// is already an advanced case, and the name field stays free text.

import weaponsJson from '../../gamedata/weapons.json'
import itemsJson from '../../gamedata/items.json'
import charactersJson from '../../gamedata/characters.json'

export interface GameDataEntry {
  name: string
  display: string
  displayFromName?: boolean
  index: number
  [key: string]: unknown
}

export const weapons = weaponsJson as unknown as GameDataEntry[]
export const items = itemsJson as unknown as GameDataEntry[]
export const characters = charactersJson as unknown as GameDataEntry[]

export function tableFor(lookup: 'weapon' | 'item' | 'character'): GameDataEntry[] {
  if (lookup === 'weapon') return weapons
  if (lookup === 'item') return items
  return characters
}

/**
 * The weapons the One Weapon mutator offers. Alpine builds that list from the
 * weapons that have a pickup item in the level, so a weapon with no pickup can
 * never be the featured one.
 */
export const weaponsWithPickup = weapons.filter(w => w.pickupItem != null)

/**
 * The rail driver. The game keeps a dedicated global for it that mutator
 * defaults are read from, and that global is filled in from the weapon table
 * rather than from anything the Alpine repo states - so the name lives here,
 * beside the table it came from.
 */
export const railGunName = weapons.find(w => w.name === 'rail_gun')?.name ?? ''
