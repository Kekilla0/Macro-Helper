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
export function gridSteps(gx, gy){
  return (isCircular() ? Math.hypot(gx, gy) : Math.max(gx, gy)) + 1;
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
  return actor?.token?.object ?? actor?.getActiveTokens()[0] ?? null;
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
  const ca = cells(tokenOf(a) ?? a), cb = cells(tokenOf(b) ?? b);
  const gapX = Math.max(0, cb.left - ca.right, ca.left - cb.right);
  const gapY = Math.max(0, cb.top - ca.bottom, ca.top - cb.bottom);
  return gridSteps(gapX, gapY) * canvas.scene.grid.distance;
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
  normal : 0x33BBFF,     // blue   : normal range
  long : 0xFF4444,       // red    : long range (disadvantage)
  candidate : 0xFFAA00,  // orange : can be picked
  picked : 0x33DD66,     // green  : picked
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
export function highlightRange(origin, feet, { normal, tokens = [], selected = [], name = "macro-helper-range" } = {}){
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
        if(n) rect(n[0] * grid, y0, n[1] * grid, y1, HIGHLIGHT.normal, 0.15);
        if(!long) continue;
        if(!n) rect(long[0] * grid, y0, long[1] * grid, y1, HIGHLIGHT.long, 0.12);
        else {
          rect(long[0] * grid, y0, n[0] * grid, y1, HIGHLIGHT.long, 0.12);
          rect(n[1] * grid, y0, long[1] * grid, y1, HIGHLIGHT.long, 0.12);
        }
      }
    }
    for(const t of tokens) fill(tokenOf(t), HIGHLIGHT.candidate, 0.3);
    for(const t of picked) fill(tokenOf(t), HIGHLIGHT.picked, 0.5, HIGHLIGHT.picked);
  };

  draw(selected);
  return {
    select : picked => draw(picked ?? []),
    clear : ()=> layer.destroyHighlightLayer(name),
  };
}

/**
 * Where a push would leave a token : straight away from `from`, up to `feet`, square by square, stopping at walls.
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
    if(blocked) break;
    best = { x, y, feet : k * canvas.scene.grid.distance };
  }
  return (best && ((best.x !== x0) || (best.y !== y0))) ? best : null;
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

/**
 * Tokens within a distance of an origin token, nearest first.
 * @param {Token|TokenDocument|Actor|Item} origin
 * @param {number} feet
 * @param {object} [options]
 * @param {"any"|"enemy"|"ally"} [options.disposition="any"]  relative to the origin
 * @param {boolean} [options.includeDead=false]
 * @param {boolean} [options.includeHidden=false]
 * @param {Function} [options.filter]                         extra (token) => boolean
 * @returns {Token[]}
 */
export function getTokensWithin(origin, feet, { disposition = "any", includeDead = false, includeHidden = false, filter } = {}){
  const from = tokenOf(origin);
  if(!from) return [];
  const sign = from.document.disposition;
  return canvas.tokens.placeables
    .filter(t => (t !== from) && t.actor)
    .filter(t => includeHidden || !t.document.hidden)
    .filter(t => includeDead || ((t.actor.system.attributes?.hp?.value ?? 1) > 0))
    .filter(t => (disposition === "any")
      || ((disposition === "enemy") && ((t.document.disposition * sign) < 0))
      || ((disposition === "ally") && ((t.document.disposition * sign) > 0)))
    .filter(t => !filter || filter(t))
    .filter(t => distanceBetween(from, t) <= feet)
    .sort((a, b) => distanceBetween(from, a) - distanceBetween(from, b));
}
