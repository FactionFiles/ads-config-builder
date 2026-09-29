// shapes of the generated schema files and the authored layer

export type ScalarType = 'bool' | 'int' | 'float' | 'string'

/** which game data table a name field is resolved against at runtime */
export type LookupTable = 'weapon' | 'item' | 'character'

/** a condition that must hold before a setting is read at all */
export interface Guard {
  /** sibling key that gates this one */
  key?: string
  equals?: boolean
  /** kept verbatim when the guard is not a simple sibling test */
  expr?: string
}

export interface ScalarKey {
  key: string
  kind: 'scalar'
  type: ScalarType
  /** the C++ type the value is read as */
  cppType: string
  default?: unknown
  min?: number
  max?: number
  maxLength?: number
  /** file value times scale is the stored value, so 1000 means the file is in seconds */
  scale?: number
  lookup?: LookupTable
  choices?: string[]
  requires?: Guard[]
  /** file and struct types disagree, an upstream bug */
  typeMismatch?: { readAs: ScalarType; storedAs: ScalarType }
  /** written by the tool, not the user, e.g. ads_version */
  global?: boolean
}

export interface TableKey {
  key: string
  kind: 'table'
  keys?: SchemaKey[]
  /** the parser does something the generator cannot follow */
  complex?: boolean
  requires?: Guard[]
}

export interface ArrayKey {
  key: string
  kind: 'array'
  item?: ArrayItemField[]
  keys?: SchemaKey[]
  /** element type of a plain list, as opposed to a list of tables */
  itemType?: ScalarType
  /** each entry is a list of itemType values, e.g. the gun game ladder */
  itemsAreLists?: boolean
  /** the table a plain list of names is resolved against */
  lookup?: LookupTable
  /** allowed values, where the server checks against a list */
  choices?: string[]
  complex?: boolean
  /** the parser hands the array to this function, which the generator cannot read */
  via?: string
  /** key field for lists the parser merges into earlier layers rather than replacing */
  mergeKey?: string
  /** rows the parser re-adds before every scope, preserving a stock behavior alpine patched out */
  seed?: Record<string, unknown>[]
  requires?: Guard[]
}

/** one column of a list of tables */
export interface ArrayItemField {
  key: string
  type: ScalarType | null
  cppType: string
  lookup?: LookupTable
  /** omitting it keeps the previous value rather than zeroing it */
  optional?: boolean
  /** parser value when the field is omitted */
  default?: unknown
}

export type SchemaKey = ScalarKey | TableKey | ArrayKey

export interface RulesSchema {
  keys: SchemaKey[]
  /** how a scope that changes game type rebuilds its rules */
  gameTypeRebase: { on: string; source: string }
  /** every dotted path, groups included */
  flat: string[]
}

export interface GameType {
  name: string
  aliases: string[]
  /** e.g. "Capture the Flag" */
  title: string
  blurb: string
  id: number
  isTeam: boolean
  botsSupported: boolean
  usesRounds: boolean
  /** null when the game type has no numeric score limit */
  scoreLimitKey: string | null
}

/** reserve ammo read from a weapon table column, since the table only exists at runtime */
export interface StockReserve {
  /** defaults to the spawn weapon */
  weapon?: string
  field: string
  /** multiplied by the spawn weapon's spare clips */
  perClip?: boolean
}

/** one assignment made by the game type defaults layer */
export type DefaultOp =
  | { op: 'set'; target: string; key: string | null; value: unknown; expr?: string }
  | { op: 'loadoutAdd'; weapon: string | null; ammo: number | null; ammoFrom?: StockReserve; blueTeam: boolean; enabled: boolean }
  | { op: 'loadoutClear'; blueTeam: boolean }
  /** adds the spawn weapon to the loadout */
  | { op: 'loadoutSpawnWeapon'; ammoFrom: StockReserve }

export interface GameTypesSchema {
  gametypes: GameType[]
  defaults: {
    /** applied before the per-type case */
    common: DefaultOp[]
    perType: Record<string, DefaultOp[]>
    /** for game types with no case of their own */
    fallback: DefaultOp[]
    /** applied after the per-type case */
    after: DefaultOp[]
  }
}

export type MutatorOptionType = 'bool' | 'choice' | 'int' | 'float' | 'string'

export interface MutatorOption {
  id: number
  name: string
  label: string
  type: MutatorOptionType
  default?: unknown
  /** the default is live server state, so the UI shows the current value */
  defaultFrom?: 'currentValue' | 'railGun'
  choicesFrom?: 'weaponsWithPickup'
}

export type MutatorGametypeReq =
  | 'Any' | 'TeamOnly' | 'GunGameOnly' | 'HasScoreLimit' | 'BotsSupported'

export interface Mutator {
  id: number
  name: string
  label: string
  /** minimum Alpine client minor version, 0 for no requirement */
  minClientMinorVersion: number
  gametypeReq: MutatorGametypeReq
  options: MutatorOption[]
  voteLabel: string | null
  voteDetailOption: string | null
}

export interface MutatorsSchema {
  mutators: Mutator[]
  /** mutator ids in the order the server applies them; later entries win */
  applyOrder: number[]
}

export interface ServerSchema {
  keys: ScalarKey[]
  tables: TableKey[]
  arrays: ArrayKey[]
  levelKeys: string[]
  /** keys still parsed in [[levels]] but ignored */
  removedLevelKeys: string[]
  botKeys: SchemaKey[]
  /** commands allowed by the legacy single rcon password */
  legacyRconCommands: string[]
  flat: string[]
}

export interface SchemaMeta {
  adsVersion: number
  alpineVersion: string
  alpineCommit: string | null
}

/** label and unit from the server's console output */
export interface ConsoleLabel {
  label: string
  unit?: string
}

export interface AuthoredEntry {
  page: string
  label: string
  help?: string
  /** shown under the help text */
  link?: string
  linkLabel?: string
  unit?: string
  display?: string
  uncertain?: boolean
  choiceLabels?: Record<string, string>
  /** alternate choice names kept in step with the choice they stand for */
  aliases?: Record<string, string>
  /** a number that is an identifier, typed as text rather than stepped */
  digits?: boolean
  /** shown in an empty control */
  emptyLabel?: string
  /** column headings for a list setting */
  fields?: Record<string, AuthoredField>
  /** game types this applies in; absent means all */
  modes?: string[]
  /** preferred over a long `modes` list, since new upstream game types stay included */
  notModes?: string[]
  teamOnly?: boolean
  /** shown while advanced settings are hidden */
  basic?: boolean
}

export interface AuthoredField {
  label: string
  help?: string
  unit?: string
  display?: string
  /** names to suggest where the parser does not validate the field */
  lookup?: LookupTable
  /** shown when empty is a meaningful value */
  emptyLabel?: string
}

export interface Page {
  id: string
  title: string
  scope: 'server' | 'rules' | 'other'
  order: number
  blurb: string
  /** hidden, settings and all, until advanced settings are shown */
  advanced?: boolean
}

export interface MutatorEffect {
  summary: string
  help?: string
  sets?: {
    key: string
    /** a literal the mutator writes, or prose when the effect is not a value */
    value?: unknown
    fromOption?: string
    note?: string
  }[]
  notes?: string[]
}
