#!/usr/bin/env node
// One-shot extractor: unpacks tables.vpp and writes gamedata/{weapons,items,characters}.json.
//
// Usage:  node tools/extract-tables.mjs <path-to-tables.vpp>
//
// The unpacker is Alpine Faction's prebuilt `vpp` tool. It is located via the
// VPP_TOOL env var, then vendor/AlpineFaction/tools/vpp, then PATH.
//
// Identifier fields are the strings the dedicated server matches against, taken
// from the Alpine source:
//   weapons.tbl  $Name       -> rf::weapon_lookup_type (dedi_cfg.cpp:698 comment)
//   items.tbl    $Class Name -> rf::item_lookup_type   (object/item.cpp:21, matches cls_name)
//   pc_multi.tbl $Name       -> rf::multi_find_character (server_internal.h ForceCharacterConfig)
// All three lookups are case insensitive, but we emit the table spelling verbatim.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO_ROOT, 'gamedata');

// Alpine treats these four pickups as "super" items (bots/bot_main.cpp is_super_pickup_name).
const SUPER_ITEMS = new Set([
    'Multi Damage Amplifier',
    'Multi Invulnerability',
    'Multi Super Armor',
    'Multi Super Health',
]);

// Weapons Alpine's bots class as super pickups (bots/bot_main.cpp item_matches_super_item_hoarder_target).
const SUPER_WEAPONS = new Set(['rail_gun', 'shoulder_cannon']);

// ---------------------------------------------------------------------------
// tbl parsing
// ---------------------------------------------------------------------------

// strip // comments without eating a // that sits inside a quoted value
function stripComment(line) {
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            quoted = !quoted;
        }
        else if (!quoted && c === '/' && line[i + 1] === '/') {
            return line.slice(0, i);
        }
    }
    return line;
}

// Splits a .tbl into records. A line matching startKey opens a new record.
// Returns [{ section, fields: Map<key, string[]>, order: [{key, value}] }]
function parseTable(text, startKey) {
    const records = [];
    let section = null;
    let current = null;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = stripComment(rawLine).trim();
        if (!line) {
            continue;
        }

        if (line.startsWith('#')) {
            const name = line.slice(1).trim();
            section = name.toLowerCase() === 'end' ? null : name;
            current = null;
            continue;
        }

        const m = /^([$+])([^:]*):(.*)$/.exec(line);
        if (!m) {
            // continuation line of a multi-line value, e.g. pc_multi $ScreenName
            if (current && current.order.length > 0) {
                current.order[current.order.length - 1].extra.push(line);
            }
            continue;
        }

        const key = m[1] + m[2].trim();
        const value = m[3].trim();

        if (key === startKey) {
            current = { section, fields: new Map(), order: [] };
            records.push(current);
        }
        if (!current) {
            continue;
        }

        const entry = { key, value, extra: [] };
        current.order.push(entry);
        if (!current.fields.has(key)) {
            current.fields.set(key, []);
        }
        current.fields.get(key).push(entry);
    }

    return records;
}

const field = (rec, key) => rec.fields.get(key)?.[0];
const rawValue = (rec, key) => field(rec, key)?.value ?? null;

function quoted(value) {
    if (value == null) {
        return null;
    }
    const m = /"([^"]*)"/.exec(value);
    return m ? m[1] : null;
}

// $Display Name / $HUD Msg Name are wrapped in XSTR(id, "text")
function localized(value) {
    if (value == null) {
        return null;
    }
    const m = /XSTR\s*\(\s*\d+\s*,\s*"([^"]*)"\s*\)/i.exec(value);
    return m ? m[1] : quoted(value);
}

// $Flags: ("a" "b" "c")
function flagList(value) {
    if (value == null) {
        return [];
    }
    return [...value.matchAll(/"([^"]*)"/g)].map(m => m[1]);
}

function intOrNull(token) {
    if (token == null) {
        return null;
    }
    const n = Number.parseInt(token, 10);
    return Number.isNaN(n) ? null : n;
}

// Several numeric fields carry a single-player value then a multiplayer value.
function numberPair(value) {
    if (value == null) {
        return [null, null];
    }
    const tokens = value.split(/\s+/).filter(Boolean);
    return [intOrNull(tokens[0]), intOrNull(tokens[1] ?? tokens[0])];
}

function titleCase(name) {
    return name
        .replace(/_/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map(word => (/[A-Z]/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
        .join(' ');
}

// display falls back to a title-cased name, flagged so the UI knows it is derived
function identity(name, display, index) {
    return display
        ? { name, display, index }
        : { name, display: titleCase(name), displayFromName: true, index };
}

// ---------------------------------------------------------------------------
// table -> json
// ---------------------------------------------------------------------------

function extractWeapons(text) {
    return parseTable(text, '$Name').map((rec, index) => {
        const name = quoted(rawValue(rec, '$Name'));
        const flags = flagList(rawValue(rec, '$Flags'));
        const has = flag => flags.includes(flag);
        const [maxAmmo, maxAmmoMulti] = numberPair(rawValue(rec, '$Max Ammo'));
        const [clipSize, clipSizeMulti] = numberPair(rawValue(rec, '$Clip Size'));

        const entry = identity(name, localized(rawValue(rec, '$Display Name')), index);

        Object.assign(entry, {
            // #Primary Weapons / #Secondary Weapons -> rf::WeaponInfoType
            category: (rec.section ?? '').toLowerCase().startsWith('secondary') ? 'secondary' : 'primary',
            playerWeapon: has('player_wep'),
            melee: has('melee'),
            // Alpine's thrown explosives are exactly the remote charge and the grenade
            // (mutators.cpp is_thrown_explosive_weapon); in the table those are the only
            // player weapons that are both thrown under gravity and silent.
            thrown: has('gravity') && has('silent') && has('player_wep'),
            remoteCharge: has('remote_charge'),
            detonator: has('detonator'),
            superWeapon: SUPER_WEAPONS.has(name),
            underwater: has('underwater'),
            altFire: has('alt_fire'),
            weaponClass: quoted(rawValue(rec, '$Weapon Type')),
            damageType: quoted(rawValue(rec, '$Damage Type')),
            ammoType: quoted(rawValue(rec, '$Ammo Type')),
            maxAmmo,
            maxAmmoMulti,
            clipSize,
            clipSizeMulti,
            cyclePosition: intOrNull(rawValue(rec, '$Cycle Position')),
            prefPosition: intOrNull(rawValue(rec, '$Pref Position')),
            // filled in from items.tbl
            pickupItem: null,
            ammoItems: [],
        });
        return entry;
    });
}

function extractItems(text) {
    return parseTable(text, '$Class Name').map((rec, index) => {
        const name = quoted(rawValue(rec, '$Class Name'));
        const flags = flagList(rawValue(rec, '$Flags'));
        const [count, countFallback] = numberPair(rawValue(rec, '$Count'));
        const countMulti = intOrNull(rawValue(rec, '$Count Multi')) ?? countFallback;

        const entry = identity(name, localized(rawValue(rec, '$HUD Msg Name')), index);

        Object.assign(entry, {
            respawnTime: intOrNull(rawValue(rec, '$Respawn Time')),
            count,
            countMulti,
            givesWeapon: quoted(rawValue(rec, '$Gives Weapon')),
            ammoFor: quoted(rawValue(rec, '$Ammo For')),
            noPickup: flags.includes('no_pickup'),
            superPickup: SUPER_ITEMS.has(name),
        });
        return entry;
    });
}

function extractCharacters(text) {
    return parseTable(text, '$Name').map((rec, index) => {
        const name = quoted(rawValue(rec, '$Name'));
        // $ScreenName: has its localizations on the following lines, English first
        const screenName = field(rec, '$ScreenName');
        const english = screenName?.extra.map(quoted).find(Boolean) ?? quoted(screenName?.value);

        const entry = identity(name, english, index);

        Object.assign(entry, {
            entityType: quoted(rawValue(rec, '$EntityType')),
            animType: quoted(rawValue(rec, '$EntityAnimType')),
        });
        return entry;
    });
}

// weapons.tbl and items.tbl disagree on capitalization, and both lookups are
// case insensitive, so cross references resolve to the weapons.tbl spelling
function linkWeaponsAndItems(weapons, items) {
    const byLowerName = new Map(weapons.map(w => [w.name.toLowerCase(), w]));

    for (const item of items) {
        for (const key of ['givesWeapon', 'ammoFor']) {
            const value = item[key];
            if (!value) {
                continue;
            }
            const weapon = byLowerName.get(value.toLowerCase());
            if (!weapon) {
                console.warn(`warning: item '${item.name}' ${key} '${value}' matches no weapon`);
                continue;
            }
            item[key] = weapon.name;
            if (key === 'givesWeapon' && weapon.pickupItem === null) {
                weapon.pickupItem = item.name;
            }
            if (key === 'ammoFor') {
                weapon.ammoItems.push(item.name);
            }
        }
    }

    for (const weapon of weapons) {
        weapon.ammoItems.sort();
    }
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

function findVppTool() {
    const candidates = [
        process.env.VPP_TOOL,
        path.join(REPO_ROOT, 'vendor', 'AlpineFaction', 'tools', 'vpp'),
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return 'vpp'; // fall back to PATH
}

function writeJson(fileName, data) {
    const target = path.join(OUT_DIR, fileName);
    writeFileSync(target, JSON.stringify(data, null, 2) + '\n');
    console.log(`wrote ${target} (${data.length} entries)`);
}

function main() {
    const archive = process.argv[2];
    if (!archive) {
        console.error('usage: node tools/extract-tables.mjs <path-to-tables.vpp>');
        process.exit(1);
    }
    if (!existsSync(archive)) {
        console.error(`archive not found: ${archive}`);
        process.exit(1);
    }

    const workDir = mkdtempSync(path.join(tmpdir(), 'ads-tables-'));
    try {
        execFileSync(findVppTool(), ['-x', path.resolve(archive)], { cwd: workDir, stdio: 'pipe' });

        const read = fileName => {
            const target = path.join(workDir, fileName);
            if (!existsSync(target)) {
                throw new Error(`${fileName} is missing from the archive`);
            }
            return readFileSync(target, 'latin1');
        };

        const weapons = extractWeapons(read('weapons.tbl'));
        const items = extractItems(read('items.tbl'));
        const characters = extractCharacters(read('pc_multi.tbl'));
        linkWeaponsAndItems(weapons, items);

        for (const [label, list] of [['weapons', weapons], ['items', items], ['characters', characters]]) {
            if (list.length === 0) {
                throw new Error(`no ${label} parsed`);
            }
            if (list.some(e => !e.name)) {
                throw new Error(`a ${label} entry has no name`);
            }
        }

        mkdirSync(OUT_DIR, { recursive: true });
        writeJson('weapons.json', weapons);
        writeJson('items.json', items);
        writeJson('characters.json', characters);
    }
    finally {
        rmSync(workDir, { recursive: true, force: true });
    }
}

main();
