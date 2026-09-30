/**
 * Token / distance helpers. Distances are measured between token footprints on the grid :
 * adjacent squares (sides or diagonals) are 5 ft (one grid unit), whatever the token art looks like.
 */

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
 * Distance between two tokens' footprints, in scene units (feet). Adjacent = one grid unit (5 ft).
 * @param {Token|TokenDocument} a
 * @param {Token|TokenDocument} b
 * @returns {number}
 */
export function distanceBetween(a, b){
  const ca = cells(tokenOf(a) ?? a), cb = cells(tokenOf(b) ?? b);
  const gapX = Math.max(0, cb.left - ca.right, ca.left - cb.right);
  const gapY = Math.max(0, cb.top - ca.bottom, ca.top - cb.bottom);
  return (Math.max(gapX, gapY) + 1) * canvas.scene.grid.distance;
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

/**
 * Show an area on the map (only on this client) : the squares within range of an origin, candidate tokens,
 * and selected tokens, each in its own colour. Call the returned function to update the selection or clear it.
 * @param {Token|TokenDocument|Actor|Item} origin
 * @param {number} feet                     range from the origin's footprint (Infinity / 0 = no range area)
 * @param {object} [options]
 * @param {Token[]} [options.tokens=[]]      candidates, highlighted orange
 * @param {Token[]} [options.selected=[]]    selected, highlighted red with a border
 * @param {string} [options.name]            highlight layer name
 * @returns {{ select : (selected : Token[]) => void, clear : () => void }}
 */
export function highlightRange(origin, feet, { tokens = [], selected = [], name = "macro-helper-range" } = {}){
  const layer = canvas.interface.grid;
  layer.addHighlightLayer(name);
  const grid = canvas.grid.size;
  const from = tokenOf(origin);

  const fill = (token, color, alpha, border = null) => {
    const c = cells(token);
    for(let i = c.left; i < c.right; i++) for(let j = c.top; j < c.bottom; j++)
      layer.highlightPosition(name, { x : i * grid, y : j * grid, color, alpha, border });
  };

  const draw = picked => {
    layer.clearHighlightLayer(name);
    /* Range area : every square whose distance to the origin's footprint is within range */
    if(from && Number.isFinite(feet) && (feet > 0)){
      const c = cells(from);
      const r = Math.floor(feet / canvas.scene.grid.distance) - 1;
      for(let i = c.left - r - 1; i < c.right + r + 1; i++) for(let j = c.top - r - 1; j < c.bottom + r + 1; j++){
        if(i >= c.left && i < c.right && j >= c.top && j < c.bottom) continue;
        layer.highlightPosition(name, { x : i * grid, y : j * grid, color : 0x33BBFF, alpha : 0.15 });
      }
    }
    for(const t of tokens) fill(tokenOf(t), 0xFFAA00, 0.3);
    for(const t of picked) fill(tokenOf(t), 0xFF3333, 0.45, 0xFF3333);
  };

  draw(selected);
  return {
    select : picked => draw(picked ?? []),
    clear : ()=> layer.destroyHighlightLayer(name),
  };
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
