// Shapes of the files under schema/generated, produced by tools/gen-schema.mjs
// from the pinned Alpine source, and of the hand-authored layer beside them.

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
  /** the config file and the struct disagree on type - an upstream bug, surfaced not hidden */
  typeMismatch?: { readAs: ScalarType; storedAs: ScalarType }
  /** written by the tool rather than chosen by the user, e.g. ads_version */
  global?: boolean
}

export interface TableKey {
  key: string
  kind: 'table'
  keys?: SchemaKey[]
  /** true when the parser does something we could not follow */
  complex?: boolean
  requires?: Guard[]
}

export interface ArrayKey {
  key: string
  kind: 'array'
  item?: ArrayItemField[]
  keys?: SchemaKey[]
  /** the type of a plain list of values, as opposed to a list of tables */
  itemType?: ScalarType
  /** each entry is itself a list of itemType values, as the Gun Game ladder is */
  itemsAreLists?: boolean
  /** the table a plain list of names is resolved against */
  lookup?: LookupTable
  /** the values the server accepts, where it checks them against a list */
  choices?: string[]
  complex?: boolean
  /** the parser hands the whole array to this function, so we cannot read it */
  via?: string
  /**
   * The field entries are keyed by, where the parser folds each entry into what
   * an earlier layer left rather than replacing the list. Naming that key again
   * changes the fields the entry carries and leaves the rest alone.
   */
  mergeKey?: string
  /**
   * Rows the parser puts in before it reads the file, and puts in again for
   * every scope it parses. Alpine keeps a stock behavior this way after
   * patching it out of the game, which is why a scope that says nothing still
   * gets the row - and why a scope underneath that turned it off does not.
   */
  seed?: Record<string, unknown>[]
  requires?: Guard[]
}

/** one column of a list of tables */
export interface ArrayItemField {
  key: string
  type: ScalarType | null
  cppType: string
  lookup?: LookupTable
  /** an entry may leave it out, which restates the entry rather than zeroing it */
  optional?: boolean
  /** what the parser reads in place of a field the entry does not carry */
  default?: unknown
}

export type SchemaKey = ScalarKey | TableKey | ArrayKey

export interface RulesSchema {
  keys: SchemaKey[]
  /**
   * What a scope that names a different game type does with the rules it was
   * handed. Alpine rebuilds from the built-in defaults plus the keys [base] set
   * by hand, so no part of the old mode survives the change.
   */
  gameTypeRebase: { on: string; source: string }
  /** every dotted path, groups included */
  flat: string[]
}

export interface GameType {
  name: string
  aliases: string[]
  /** the game's own name for the mode, e.g. "Capture the Flag" */
  title: string
  /** the game's own one-line description of the mode */
  blurb: string
  id: number
  isTeam: boolean
  botsSupported: boolean
  /** plays several short rounds on one map rather than one continuous match */
  usesRounds: boolean
  /** the rules key this mode is scored by, or null when it has no numeric limit */
  scoreLimitKey: string | null
}

/**
 * Reserve ammo the source states as a column of the weapon table rather than as
 * a number. The table only exists at runtime, so the generator passes on which
 * column to read instead of a value.
 */
export interface StockReserve {
  /** the weapon it is read from, where the source names one rather than using the spawn weapon */
  weapon?: string
  field: string
  /** it is multiplied by the number of spare clips the spawn weapon comes with */
  perClip?: boolean
}

/** one assignment made by the game type defaults layer */
export type DefaultOp =
  | { op: 'set'; target: string; key: string | null; value: unknown; expr?: string }
  | { op: 'loadoutAdd'; weapon: string | null; ammo: number | null; ammoFrom?: StockReserve; blueTeam: boolean; enabled: boolean }
  | { op: 'loadoutClear'; blueTeam: boolean }
  /** completes the kit with the weapon the mode spawns players holding */
  | { op: 'loadoutSpawnWeapon'; ammoFrom: StockReserve }

export interface GameTypesSchema {
  gametypes: GameType[]
  defaults: {
    /** applied to every mode before its own case */
    common: DefaultOp[]
    perType: Record<string, DefaultOp[]>
    /** for a mode with no case of its own, which is most of the ordinary ones */
    fallback: DefaultOp[]
    /** applied after the mode's own case */
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
  /** keys a [[levels]] entry still parses but Alpine no longer acts on */
  removedLevelKeys: string[]
  botKeys: SchemaKey[]
  /** what the old-style single rcon password is allowed to run */
  legacyRconCommands: string[]
  flat: string[]
}

export interface SchemaMeta {
  adsVersion: number
  alpineVersion: string
  alpineCommit: string | null
}

/** label and unit lifted from the server's own console output */
export interface ConsoleLabel {
  label: string
  unit?: string
}

/** the hand-authored layer: what the user actually reads */
export interface AuthoredEntry {
  page: string
  label: string
  help: string
  unit?: string
  display?: string
  uncertain?: boolean
  choiceLabels?: Record<string, string>
  /** what each column of a list setting is called */
  fields?: Record<string, AuthoredField>
  /** the modes this setting has any effect in; absent means every mode */
  modes?: string[]
  /** the modes it has no effect in - safer than a long `modes` list, since a
   *  mode added upstream stays included rather than silently dropping out */
  notModes?: string[]
  /** it only does anything in modes that have teams, whichever those are */
  teamOnly?: boolean
}

/** the hand-authored half of one column of a list setting */
export interface AuthoredField {
  label: string
  help?: string
  unit?: string
  display?: string
  /** names to offer where the parser does not check the field itself */
  lookup?: LookupTable
  /** what leaving it empty means, where empty is a real answer */
  emptyLabel?: string
}

export interface Page {
  id: string
  title: string
  scope: 'server' | 'rules' | 'other'
  order: number
  blurb: string
}

export interface MutatorEffect {
  summary: string
  help?: string
  sets?: {
    key: string
    /** a literal the mutator writes, or prose when the effect is not a value */
    value?: unknown
    /** the mutator option this setting takes its value from */
    fromOption?: string
    note?: string
  }[]
  notes?: string[]
}
