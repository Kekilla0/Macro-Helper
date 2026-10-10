import { module } from '../module.js';

/**
 * Token / distance helpers. Distances are measured between token footprints on the grid :
 * adjacent squares (sides or diagonals) are 5 ft (one grid unit), whatever the token art looks like.
 * Further out, the Helpers "Range Shape" setting decides :
 *   circle (default) : true distance, so a range reaches its full length north / east / south / west and less on the diagonals
 *   square (5e rules) : every diagonal step counts as 5 ft, so a range is a square
 */

/* Round ranges (true distance) unless the Helpers setting asks for 5e's square ones */
export function isCircular(){
  try { return game.settings.get(module.id, "rangeShape") !== "square"; }
  catch { return true; }
}

/**
 * Distance in grid steps for a gap of gx columns and gy rows between two footprints (0, 0 = adjacent) : 1 = adjacent.
 * @param {number} gx
 * @param {number} gy
 * @returns {number}
 */
export function gridSteps(gx, gy, gz = 0){
  return (isCircular() ? Math.hypot(gx, gy, gz) : Math.max(gx, gy, gz)) + 1;
}

/**
 * The Token on the canvas for a token, token document, actor or item. Falls back to the first controlled token.
 * @param {Token|TokenDocument|Actor|Item} [thing]
 * @returns {Token|null}
 */
export function tokenOf(thing){
  if(!thing) return canvas.tokens?.controlled[0] ?? null;
  if(thing.document?.documentName === "Token") return thing;                // Token (placeable)
  if(thing.documentName === "Token") return thing.object ?? null;           // TokenDocument
  const actor = thing.documentName === "Actor" ? thing : thing.actor;       // Actor, or Item / Activity
  return actor?.token?.object ?? actor?.getActiveTokens?.()[0] ?? null;
}

/**
 * The Actor for a token, token document, actor or item (an unlinked token's own actor).
 * @param {Token|TokenDocument|Actor|Item} thing
 * @returns {Actor|null}
 */
export function actorOf(thing){
  if(!thing) return null;
  if(thing.documentName === "Actor") return thing;
  return thing.actor ?? null;
}

/* A token's footprint in grid squares, from its position and size (not its drawn bounds) */
export function cells(token){
  const grid = canvas.grid.size;
  const { x, y, width, height } = token.document ?? token;
  const left = Math.round(x / grid), top = Math.round(y / grid);
  return { left, top, right : left + Math.max(1, Math.round(width)), bottom : top + Math.max(1, Math.round(height)) };
}

/**
 * Distance between two tokens' footprints, in scene units (feet). Adjacent (sides or diagonals) = one grid unit (5 ft).
 * Beyond that it follows the Range Shape setting (see the top of this file). Not rounded : 2 squares diagonally is ~12.07 ft.
 * @param {Token|TokenDocument} a
 * @param {Token|TokenDocument} b
 * @returns {number}
 */
export function distanceBetween(a, b){
  const ta = tokenOf(a) ?? a, tb = tokenOf(b) ?? b;
  const ca = cells(ta), cb = cells(tb);
  const gapX = Math.max(0, cb.left - ca.right, ca.left - cb.right);
  const gapY = Math.max(0, cb.top - ca.bottom, ca.top - cb.bottom);
  return gridSteps(gapX, gapY, heightGap(ta, tb)) * canvas.scene.grid.distance;
}

/**
 * The height gap between two tokens in grid squares, from their elevation (set by hand : flying, climbing). Each is as
 * tall as it is wide (a Medium creature 5 ft), so one standing on the ground and one flying 5 ft up are adjacent.
 * @param {Token|TokenDocument} a
 * @param {Token|TokenDocument} b
 * @returns {number}
 */
export function heightGap(a, b){
  const unit = canvas.scene?.grid.distance || 5;
  const span = t => {
    const doc = t?.document ?? t ?? {};
    const bottom = Number(doc.elevation) || 0;
    return { bottom, top : bottom + (Math.max(1, Math.min(Number(doc.width) || 1, Number(doc.height) || 1)) * unit) };
  };
  const sa = span(a), sb = span(b);
  return Math.max(0, sb.bottom - sa.top, sa.bottom - sb.top) / unit;
}

/**
 * How far an item / activity reaches, in scene units (feet), from dnd5e's own range data :
 *  melee weapon  -> its reach (dnd5e sets 5 ft, or 10 ft with the Reach property); { thrown : true } for its thrown range
 *  ranged weapon -> its normal range; { long : true } for long range
 *  spells / features -> the activity's range if it overrides the item's, else the item's (Touch = 5 ft, Self = 0, Any = unlimited)
 * @param {Item|Activity} thing
 * @param {object} [options]
 * @param {boolean} [options.long=false]    use long range
 * @param {boolean} [options.thrown=false]  thrown melee weapons : use the thrown range instead of reach
 * @returns {number}
 */
export function getRange(thing, { long = false, thrown = false } = {}){
  const isItem = thing?.documentName === "Item";
  const item = isItem ? thing : thing?.item;
  const activity = isItem ? (item.system.activities?.getByType("attack")[0] ?? item.system.activities?.contents[0]) : thing;
  if(!item) return 0;

  /* Activities that set their own range override the item's */
  const range = activity?.range?.override ? activity.range : (item.system.range ?? {});
  const units = range.units || "ft";
  const toScene = value => {
    const sceneUnits = canvas.scene?.grid.units || "ft";
    return (units === sceneUnits) ? value : (dnd5e.utils.convertLength?.(value, units, sceneUnits, { strict : false }) ?? value);
  };

  /* Weapons : reach for melee, range for ranged (and thrown on request) */
  if(item.type === "weapon"){
    const melee = item.system.attackType !== "ranged";
    if(melee && !(thrown && range.value)) return toScene(item.system.range.reach ?? 5);
    return toScene(long ? (range.long || range.value || 0) : (range.value || 0));
  }

  switch(units){
    case "self" : return 0;
    case "touch" : return canvas.scene?.grid.distance ?? 5;
    case "any" :
    case "spec" : return Infinity;
  }
  if(range.reach && !range.value) return toScene(range.reach);
  return toScene(long ? (range.long || range.value || 0) : (range.value || 0));
}

/* Colours of the map highlights */
export const HIGHLIGHT = {
  normal : 0x33BBFF,        // blue   : normal range
  long : 0xFF4444,          // red    : long range (disadvantage)
  candidate : 0xFFAA00,     // orange : can be picked
  picked : 0x33DD66,        // green  : picked
  pickedBorder : 0xFFFFFF,  // white  : the border round a pick
  advantage : 0x33CC33,     // attacks : green, would roll with advantage
  normal5e : 0xE6C229,      //           yellow, a normal roll
  disadvantage : 0xD93636,  //           red, with disadvantage
};

/**
 * Show an area on the map (only on this client) : the squares within range of an origin, candidate tokens,
 * and selected tokens, each in its own colour. Call the returned function to update the selection or clear it.
 *   blue  = within `normal` range (or all of `feet` when there is no separate normal range)
 *   red   = beyond `normal` but within `feet` : long range, where 5e attacks have disadvantage
 * @param {Token|TokenDocument|Actor|Item} origin
 * @param {number} feet                     furthest range from the origin's footprint (Infinity / 0 = no range area)
 * @param {object} [options]
 * @param {number} [options.normal]          normal range : squares beyond it (up to `feet`) are shown as long range
 * @param {Token[]} [options.tokens=[]]      candidates, highlighted orange
 * @param {Token[]} [options.selected=[]]    selected, highlighted green with a border
 * @param {string} [options.name]            highlight layer name
 * @returns {{ select : (selected : Token[]) => void, clear : () => void }}
 */
export function highlightRange(origin, feet, { normal, tokens = [], selected = [], name = "macro-helper-range", showSelf = true, tokenColor } = {}){
  const layer = canvas.interface.grid;
  const graphics = layer.addHighlightLayer(name);
  const grid = canvas.grid.size;
  const unit = canvas.scene.grid.distance;
  const from = tokenOf(origin);

  const fill = (token, color, alpha, border = null) => {
    const c = cells(token);
    for(let i = c.left; i < c.right; i++) for(let j = c.top; j < c.bottom; j++)
      layer.highlightPosition(name, { x : i * grid, y : j * grid, color, alpha, border });
  };

  const rect = (x0, y0, x1, y1, color, alpha) => {
    if((x1 <= x0) || (y1 <= y0)) return;
    graphics.beginFill(color, alpha).drawRect(x0, y0, x1 - x0, y1 - y0).endFill();
  };

  /**
   * The squares of a row within `steps` grid steps of the footprint, as [first, last + 1) columns, or null.
   * Same measure as distanceBetween, so every square shown in range is one a token could be picked in.
   */
  const span = (c, gy, steps) => {
    const k = steps - 1;                                            // largest gap allowed (0 = adjacent only)
    if((k < 0) || (gy > k)) return null;
    const gx = isCircular() ? Math.floor(Math.sqrt((k * k) - (gy * gy)) + 1e-9) : k;
    return [c.left - 1 - gx, c.right + gx + 1];
  };

  const draw = picked => {
    layer.clearHighlightLayer(name);

    /* Range areas, one strip per row (a longbow's long range is thousands of squares) : normal in blue, long range in red */
    if(from && Number.isFinite(feet) && (feet > 0)){
      const c = cells(from);
      const outer = Math.floor(feet / unit);
      const inner = Number.isFinite(normal) ? Math.min(outer, Math.max(0, Math.floor(normal / unit))) : outer;
      for(let j = c.top - outer; j < c.bottom + outer; j++){
        const gy = (j < c.top) ? (c.top - 1 - j) : (j >= c.bottom) ? (j - c.bottom) : 0;
        const inRow = (j >= c.top) && (j < c.bottom);
        const long = span(c, gy, outer), near = span(c, gy, inner);
        const y0 = j * grid, y1 = y0 + grid;
        /* The footprint's own rows always count as normal range for the footprint itself */
        const n = near ?? (inRow ? [c.left, c.right] : null);
        /* The origin's own squares are left plain when it can't pick itself */
        if(n && inRow && !showSelf){
          rect(n[0] * grid, y0, c.left * grid, y1, HIGHLIGHT.normal, 0.15);
          rect(c.right * grid, y0, n[1] * grid, y1, HIGHLIGHT.normal, 0.15);
        }
        else if(n) rect(n[0] * grid, y0, n[1] * grid, y1, HIGHLIGHT.normal, 0.15);
        if(!long) continue;
        if(!n) rect(long[0] * grid, y0, long[1] * grid, y1, HIGHLIGHT.long, 0.12);
        else {
          rect(long[0] * grid, y0, n[0] * grid, y1, HIGHLIGHT.long, 0.12);
          rect(n[1] * grid, y0, long[1] * grid, y1, HIGHLIGHT.long, 0.12);
        }
      }
    }
    /* Candidates : orange, or their own colour (attacks : green advantage, yellow normal, red disadvantage) */
    const colorOf = t => (tokenColor && HIGHLIGHT[tokenColor(t)]) || HIGHLIGHT.candidate;
    for(const t of tokens) fill(tokenOf(t), colorOf(t), 0.35);
    for(const t of picked) fill(tokenOf(t), tokenColor ? colorOf(t) : HIGHLIGHT.picked, 0.6, HIGHLIGHT.pickedBorder);
  };

  draw(selected);
  return {
    select : picked => draw(picked ?? []),
    clear : ()=> layer.destroyHighlightLayer(name),
  };
}

/**
 * Where a push would leave a token : straight away from `from`, up to `feet`, square by square, stopping at walls
 * and at other creatures (a square another token stands in blocks it, like a wall).
 * Measured like everything else here (Range Shape) : with Square, a diagonal square is 5 ft, so 10 ft is 2 diagonal squares.
 * @param {Token|TokenDocument|Actor} thing   who is pushed
 * @param {Token|TokenDocument|Actor} from    who pushes
 * @param {number} [feet=10]
 * @returns {{ x : number, y : number, feet : number }|null}  the token's new top-left position and how far that is,
 *          null if it can't move at all
 */
export function pushDestination(thing, from, feet = 10){
  const token = tokenOf(thing), source = tokenOf(from);
  if(!token || !source || (token === source)) return null;

  const start = token.center;
  let dx = start.x - source.center.x, dy = start.y - source.center.y;
  const norm = isCircular() ? Math.hypot(dx, dy) : Math.max(Math.abs(dx), Math.abs(dy));
  if(!norm) return null;
  dx /= norm; dy /= norm;

  const grid = canvas.grid.size;
  const steps = Math.floor(feet / canvas.scene.grid.distance);
  const { x : x0, y : y0 } = token.document;
  let best = null;
  for(let k = 1; k <= steps; k++){
    let x = x0 + (dx * k * grid), y = y0 + (dy * k * grid);
    if(!canvas.grid.isGridless){ x = Math.round(x / grid) * grid; y = Math.round(y / grid) * grid; }
    const center = { x : x + (token.w / 2), y : y + (token.h / 2) };
    let blocked = false;
    try { blocked = !!CONFIG.Canvas.polygonBackends.move.testCollision(start, center, { type : "move", mode : "any" }); }
    catch { blocked = false; }
    if(blocked || occupied(token, x, y)) break;
    best = { x, y, feet : k * canvas.scene.grid.distance };
  }
  return (best && ((best.x !== x0) || (best.y !== y0))) ? best : null;
}

/**
 * Is a space free of creatures ? A block of squares with its top-left corner at x / y (canvas pixels).
 * @param {number} x
 * @param {number} y
 * @param {number} [size=1]  its width in squares
 * @param {object} [options]
 * @param {number} [options.height]   its height in squares (default : the width)
 * @param {Token} [options.ignore]    a token that doesn't count (the one growing into the space)
 * @returns {boolean}
 */
export function isSpaceFree(x, y, size = 1, { height, ignore } = {}){
  const grid = canvas.grid.size;
  const left = Math.round(x / grid), top = Math.round(y / grid);
  const right = left + Math.max(1, Math.round(size)), bottom = top + Math.max(1, Math.round(height ?? size));
  const skip = ignore?.document?.id ?? ignore?.id;
  return !canvas.tokens.placeables.some(other => {
    if(!other.actor || (skip && (other.document.id === skip))) return false;
    const c = cells(other);
    return (c.left < right) && (c.right > left) && (c.top < bottom) && (c.bottom > top);
  });
}

/**
 * Where a token can take a bigger size (Wild Shape into a Large beast) : a block of width × height squares that still
 * covers its space, in whichever direction there's room (centred first), free of other creatures, inside the scene,
 * with no wall cutting through it. A size no bigger than now keeps its corner.
 * @param {Token|TokenDocument|Actor} thing
 * @param {number} width   in squares
 * @param {number} height  in squares
 * @returns {{ x : number, y : number }|null}  the new top-left corner, null if it can't fit here
 */
export function fitSpace(thing, width, height = width){
  const token = tokenOf(thing);
  if(!token) return null;
  const grid = canvas.grid.size;
  const { x, y } = token.document;
  const w0 = Math.max(1, Math.round(token.document.width)), h0 = Math.max(1, Math.round(token.document.height));
  const W = Math.max(1, Math.round(width)), H = Math.max(1, Math.round(height));
  if((W <= w0) && (H <= h0)) return { x, y };
  const offsets = [];
  for(let dx = 0; dx <= Math.max(0, W - w0); dx++) for(let dy = 0; dy <= Math.max(0, H - h0); dy++) offsets.push([dx, dy]);
  const cx = Math.max(0, W - w0) / 2, cy = Math.max(0, H - h0) / 2;
  offsets.sort((a, b) => (Math.abs(a[0] - cx) + Math.abs(a[1] - cy)) - (Math.abs(b[0] - cx) + Math.abs(b[1] - cy)));
  const rect = canvas.dimensions?.sceneRect;
  for(const [dx, dy] of offsets){
    const nx = x - (dx * grid), ny = y - (dy * grid);
    if(rect && ((nx < rect.x) || (ny < rect.y) || (nx + (W * grid) > rect.x + rect.width) || (ny + (H * grid) > rect.y + rect.height))) continue;
    if(!isSpaceFree(nx, ny, W, { height : H, ignore : token })) continue;
    if(wallInside(token, nx, ny, W, H)) continue;
    return { x : nx, y : ny };
  }
  return null;
}

/* A wall between the token and any square of the block (it couldn't spread through it) */
function wallInside(token, x, y, width, height){
  const grid = canvas.grid.size;
  for(let i = 0; i < width; i++) for(let j = 0; j < height; j++){
    const center = { x : x + ((i + 0.5) * grid), y : y + ((j + 0.5) * grid) };
    try { if(CONFIG.Canvas.polygonBackends.move.testCollision(token.center, center, { type : "move", mode : "any" })) return true; }
    catch { /* no walls to test against */ }
  }
  return false;
}

/* Would the token, moved to x / y, share a square with another creature's token ? */
function occupied(token, x, y){
  const grid = canvas.grid.size;
  const left = Math.round(x / grid), top = Math.round(y / grid);
  const right = left + Math.max(1, Math.round(token.document.width ?? 1)), bottom = top + Math.max(1, Math.round(token.document.height ?? 1));
  return canvas.tokens.placeables.some(other => {
    if((other === token) || !other.actor) return false;
    const c = cells(other);
    return (c.left < right) && (c.right > left) && (c.top < bottom) && (c.bottom > top);
  });
}

/**
 * Push a token straight away from another (Shove, the Push mastery, Thunderwave...), see pushDestination.
 * Needs permission to move the token (its owner or the GM).
 * @param {Token|TokenDocument|Actor} thing
 * @param {Token|TokenDocument|Actor} from
 * @param {number} [feet=10]
 * @returns {Promise<number>}  how far it moved, in feet : 0 if it couldn't move at all (a wall right behind it)
 */
export async function pushAway(thing, from, feet = 10){
  const token = tokenOf(thing);
  const destination = pushDestination(token, from, feet);
  if(!destination || !token.document.canUserModify(game.user, "update")) return 0;
  await token.document.update({ x : destination.x, y : destination.y });
  return destination.feet;
}

/* ---------- Areas (templates) ---------- */

/**
 * Tokens inside an area : a dnd5e template (a Region in v14) or any Region. A token counts when any square of its
 * space is inside (the middle of the square), at its elevation. Everyone counts, the caster too, like the rules.
 * @param {RegionDocument|Region} area
 * @param {object} [options]
 * @param {boolean} [options.includeHidden=false]  GM-hidden tokens
 * @param {Function} [options.filter]              extra (token) => boolean
 * @returns {Token[]}
 */
export function getTokensInArea(area, { includeHidden = false, filter } = {}){
  const region = area?.document ?? area;
  if(typeof region?.testPoint !== "function") return [];
  const grid = canvas.grid.size;
  return canvas.tokens.placeables.filter(token => {
    if(!token.actor || (!includeHidden && token.document.hidden) || (filter && !filter(token))) return false;
    const c = cells(token);
    const elevation = token.document.elevation ?? 0;
    for(let i = c.left; i < c.right; i++) for(let j = c.top; j < c.bottom; j++){
      if(region.testPoint({ x : (i + 0.5) * grid, y : (j + 0.5) * grid, elevation })) return true;
    }
    return false;
  });
}

/* ---------- Lights on tokens (Light, torches, glowing weapons) ---------- */

/**
 * Make a token give off light, remembering the light it had so removeLight can put it back.
 * Several sources can light the same token, each under its own key; the first one's "before" is what comes back.
 * Needs permission to change the token.
 * @param {Token|TokenDocument|Actor} thing
 * @param {object} light            token light data : { bright, dim, color, alpha, animation : { type, speed, intensity } }
 * @param {object} [options]
 * @param {string} [options.key="light"]  which source this is ("light", "torch"...)
 * @returns {Promise<boolean>}
 */
export async function addLight(thing, light = {}, { key = "light" } = {}){
  const doc = tokenDocOf(thing);
  if(!doc?.canUserModify(game.user, "update")) return false;
  const lights = doc.getFlag(module.id, "lights") ?? {};
  const before = lights.before ?? doc.light.toObject();
  await doc.update({
    light : foundry.utils.mergeObject(doc.light.toObject(), light, { inplace : false }),
    [`flags.${module.id}.lights`] : { ...lights, before, [key] : true },
  });
  return true;
}

/**
 * Take a light source off a token (see addLight). When it was the last one, the token's original light comes back.
 * @param {Token|TokenDocument|Actor} thing
 * @param {object} [options]
 * @param {string} [options.key="light"]
 * @returns {Promise<boolean>}  false if that source wasn't lighting it
 */
export async function removeLight(thing, { key = "light" } = {}){
  const doc = tokenDocOf(thing);
  const lights = doc?.getFlag(module.id, "lights");
  if(!lights?.[key] || !doc.canUserModify(game.user, "update")) return false;
  const { before, [key] : _, ...rest } = lights;
  const others = Object.keys(rest).length > 0;
  if(others) await doc.update({ [`flags.${module.id}.lights`] : { before, ...rest } });
  else {
    await doc.update({ light : before ?? {} });
    await doc.unsetFlag(module.id, "lights");
  }
  return true;
}

/**
 * Is this light source on the token (see addLight) ?
 * @param {Token|TokenDocument|Actor} thing
 * @param {string} [key="light"]
 * @returns {boolean}
 */
export function hasLight(thing, key = "light"){
  return !!tokenDocOf(thing)?.getFlag(module.id, `lights.${key}`);
}

/* A token's document : a TokenDocument as it is (on any scene), else the token on the canvas (tokenOf) */
function tokenDocOf(thing){
  return (thing?.documentName === "Token") ? thing : (tokenOf(thing)?.document ?? null);
}

/**
 * Out of the fight : Dead, or an NPC at 0 HP (with a max HP set). A character at 0 HP is dying, not dead : still a
 * target (attacks on it within 5 ft are crits). A creature with no max HP set (a blank test character) counts as up.
 * @param {Token} token
 * @returns {boolean}
 */
export function isDown(token){
  const actor = token?.actor;
  if(!actor) return false;
  if(actor.statuses?.has("dead")) return true;
  const hp = actor.system?.attributes?.hp;
  return (actor.type !== "character") && (Number(hp?.max) > 0) && ((Number(hp?.value) || 0) <= 0);
}

/**
 * Can't act : down (isDown), or a character at 0 HP (dying) with a max HP set.
 * @param {Token} token
 * @returns {boolean}
 */
export function isOutOfAction(token){
  if(isDown(token)) return true;
  const actor = token?.actor, hp = actor?.system?.attributes?.hp;
  return (actor?.type === "character") && (Number(hp?.max) > 0) && ((Number(hp?.value) || 0) <= 0);
}

/**
 * Tokens within a distance of an origin token, nearest first.
 * @param {Token|TokenDocument|Actor|Item} origin
 * @param {number} feet
 * @param {object} [options]
 * @param {"any"|"enemy"|"ally"|"nonAlly"} [options.disposition="any"]  relative to the origin; nonAlly = anyone not on its side (Neutral too)
 * @param {boolean} [options.includeDead=false]   also Dead creatures and NPCs at 0 HP (see isDown); characters at 0 HP always count
 * @param {boolean} [options.includeHidden=false]
 * @param {Function} [options.filter]                         extra (token) => boolean
 * @param {boolean} [options.includeSelf=false]               the origin token itself counts (it is "within" any range)
 * @returns {Token[]}
 */
export function getTokensWithin(origin, feet, { disposition = "any", includeDead = false, includeHidden = false, filter, includeSelf = false } = {}){
  const from = tokenOf(origin);
  if(!from) return [];
  const sign = from.document.disposition;
  const self = includeSelf && (!filter || filter(from)) ? [from] : [];
  return [...self, ...canvas.tokens.placeables
    .filter(t => (t !== from) && t.actor)
    .filter(t => includeHidden || !t.document.hidden)
    .filter(t => includeDead || !isDown(t))
    .filter(t => (disposition === "any")
      || ((disposition === "enemy") && ((t.document.disposition * sign) < 0))
      || ((disposition === "nonAlly") && ((t.document.disposition * sign) <= 0))
      || ((disposition === "ally") && ((t.document.disposition * sign) > 0)))
    .filter(t => !filter || filter(t))
    .filter(t => distanceBetween(from, t) <= feet)
    .sort((a, b) => distanceBetween(from, a) - distanceBetween(from, b))];
}

/* ---------- Sight ---------- */

const warnedSight = new Set();

/**
 * Can one token see another, by its own sight (Vision Rules setting) : walls, light and darkness, darkvision and its
 * other detection modes, Blinded / Invisible, as Foundry works them out. It's the viewer's sight, not yours : the GM
 * attacking with an NPC gets what the NPC sees. When the viewer has no live vision source (not selected, or another
 * player's), one is made from its token settings for the test and thrown away.
 * A token with sight turned off (with a console warning), or any token when the scene has no token vision, sees
 * everything except by the conditions : not while Blinded, and never an Invisible creature. The setting off : everything.
 * @param {Token|TokenDocument|Actor} viewer
 * @param {Token|TokenDocument|Actor} target
 * @returns {boolean}
 */
export function canSee(viewer, target){
  const v = tokenOf(viewer), t = tokenOf(target);
  if(!v || !t || (v === t)) return true;
  /* Vision setting : off, conditions only (Blinded / Invisible, no walls or light), full sight */
  let mode = "full";
  let enabled = true;
  /* A rule : System Automation's switch (not Roll Item's) turns it off */
  try { enabled = game.settings.get(module.id, "automationEnabled") !== false; } catch { enabled = true; }
  try { mode = enabled ? game.settings.get(module.id, "vision") : "off"; }
  catch { try { mode = game.settings.get(module.id, "visionRules") ? "full" : "off"; } catch { mode = "off"; } }
  if(mode === "off") return true;
  /* Blinded : only senses that aren't sight (blindsight, tremorsense...) can still find it */
  const blinded = !!v.actor?.statuses?.has("blinded");
  /* Without sight to work it out (vision off on the token or the scene), the conditions still count :
     a Blinded viewer sees nothing, an Invisible target can't be seen */
  const byConditions = !blinded && !t.actor?.statuses?.has("invisible");
  if((mode === "conditions") || !canvas.ready || !canvas.visibility?.tokenVision) return byConditions;
  if(!v.document.sight?.enabled){
    if(!byConditions) return false;
    if(!warnedSight.has(v.id)){ warnedSight.add(v.id); console.warn(`${module.title} | ${v.name} has no vision : it sees everything.`); }
    return true;
  }

  let source = v.vision?.active ? v.vision : null;
  const temporary = !source;
  if(temporary){
    source = new CONFIG.Canvas.visionSourceClass({ sourceId : `${v.sourceId}.${module.id}`, object : v });
    const blinded = v._getVisionBlindedStates?.() ?? {};
    for(const state in blinded) source.blinded[state] = blinded[state];
    source.initialize(v._getVisionSourceData());
  }
  try {
    const size = Math.min(t.w, t.h);
    const config = canvas.visibility._createVisibilityTestConfig([t.center], { tolerance : Math.max(2, Math.floor(size / 4)), object : t });
    const modes = CONFIG.Canvas.detectionModes;
    const SIGHT = foundry.canvas?.perception?.DetectionMode?.DETECTION_TYPES?.SIGHT ?? 0;
    for(const [id, mode] of Object.entries(v.document.detectionModes ?? {})){
      if(blinded && ((modes[id]?.type ?? SIGHT) === SIGHT)) continue;
      if(modes[id]?.testVisibility(source, mode, config)) return true;
    }
    return false;
  } finally {
    if(temporary) source.destroy();
  }
}
