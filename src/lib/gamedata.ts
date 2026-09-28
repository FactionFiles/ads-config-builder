// weapon, item and character names from the game's tables.vpp, since they are
// not in the alpine repo. a tc mod may rename them; name fields stay free text.

import type { StockReserve } from '../schema/types'
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

// one weapon only picks from weapons that have a pickup item
export const weaponsWithPickup = weapons.filter(w => w.pickupItem != null)

// mutator defaults read a game global filled from the weapon table, not the alpine repo
export const railGunName = weapons.find(w => w.name === 'rail_gun')?.name ?? ''

const plainName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

// case and punctuation insensitive, since alpine writes underscores where the table has spaces
export function weaponNamed(name: string): GameDataEntry | undefined {
  return weapons.find(w => plainName(w.name) === plainName(name))
}

// a per-clip reserve scales with the spawn weapon's spare clips
export function reserveAmmo(from: StockReserve, weaponName: string, clips: number): number {
  const weapon = weaponNamed(from.weapon ?? weaponName)
  const value = weapon ? Number(weapon[from.field] ?? 0) : 0
  return from.perClip ? value * clips : value
}
