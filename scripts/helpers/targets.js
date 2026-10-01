import { module } from '../module.js';
import { tokenOf, distanceBetween, getRange, getTokensWithin, highlightRange } from './tokens.js';

/* Opposite dispositions (hostile vs friendly) */
export function isEnemy(a, b){
  return (tokenOf(a)?.document.disposition * tokenOf(b)?.document.disposition) < 0;
}

/* Same non-neutral disposition */
export function isAlly(a, b){
  return (tokenOf(a)?.document.disposition * tokenOf(b)?.document.disposition) > 0;
}

/* dnd5e conditions that stop a creature threatening anyone (all of them include Incapacitated) */
const INCAPACITATED = ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned", "dead"];

/**
 * Enemies (opposite disposition) within `range` feet of a token, nearest first : who is threatening it.
 * By default incapacitated (unconscious, paralyzed...), dead / 0 HP and GM-hidden enemies don't count.
 * @param {Token|TokenDocument|Actor} thing
 * @param {object} [options]
 * @param {number} [options.range=5]                   feet
 * @param {boolean} [options.includeIncapacitated=false]
 * @param {boolean} [options.includeHidden=false]      GM-hidden tokens (counting them would give them away to players)
 * @returns {Token[]}
 */
export function getThreats(thing, { range = 5, includeIncapacitated = false, includeHidden = false } = {}){
  const token = tokenOf(thing);
  if(!token) return [];
  return getTokensWithin(token, range, {
    disposition : "enemy",
    includeHidden,
    filter : t => includeIncapacitated || !INCAPACITATED.some(status => t.actor.statuses?.has(status)),
  });
}

/**
 * Is a token threatened : an enemy (opposite disposition) within 5 feet that isn't incapacitated ?
 * 5e : ranged attacks made while threatened have disadvantage.
 * @param {Token|TokenDocument|Actor} thing
 * @param {object} [options]  see getThreats
 * @returns {boolean}
 */
export function isThreatened(thing, options = {}){
  return getThreats(thing, options).length > 0;
}

/**
 * Enemies within an item's range of its owner's token (a melee weapon's reach, a bow's range...) : your current
 * targets in range first (in the order you targeted them), then every other enemy in range, nearest first.
 * @param {Item|Activity} item
 * @param {object} [options]
 * @param {Token} [options.token]            the attacker, defaults to the item owner's token
 * @param {number} [options.numberOfEnemies]  keep at most this many
 * @param {number} [options.range]            override the item's range (feet)
 * @param {boolean} [options.long=false]      ranged : use long range (see getRange)
 * @param {boolean} [options.thrown=false]    thrown melee weapons : use the thrown range (see getRange)
 * @param {boolean} [options.targetedFirst=true]
 * @returns {Token[]}
 */
export function getEnemiesWithinRange(item, { token, numberOfEnemies = Infinity, range, long = false, thrown = false, targetedFirst = true } = {}){
  const attacker = tokenOf(token ?? item);
  if(!attacker) return [];
  const feet = range ?? getRange(item, { long, thrown });

  const inReach = t => (t !== attacker) && t.actor && distanceBetween(attacker, t) <= feet;
  const targeted = targetedFirst ? [...game.user.targets].filter(inReach) : [];
  const enemies = getTokensWithin(attacker, feet, { disposition : "enemy" }).filter(t => !targeted.includes(t));

  return [...targeted, ...enemies].slice(0, numberOfEnemies);
}

/**
 * Does a group follow the rules : no more than numberAllowed, and everyone within `within` feet of someone else in it.
 * @param {Token[]} tokens
 * @param {object} [options]
 * @param {number|Function} [options.numberAllowed=Infinity]  a number, or (group) => number
 * @param {number} [options.within=5]
 * @returns {{ valid : boolean, reason : string }}
 */
export function isValidGroup(tokens, { numberAllowed = Infinity, within = 5 } = {}){
  const group = (tokens ?? []).map(t => tokenOf(t)).filter(Boolean);
  if(!group.length) return { valid : false, reason : module.i18n("helpers.targets.none") };

  const allowed = typeof numberAllowed === "function" ? numberAllowed(group) : numberAllowed;
  if(group.length > allowed) return { valid : false, reason : module.format("helpers.targets.tooMany", { allowed }) };

  /* Everyone reachable from the first through a chain of neighbours within range */
  const seen = new Set([group[0]]);
  const queue = [group[0]];
  while(queue.length){
    const a = queue.shift();
    for(const b of group) if(!seen.has(b) && distanceBetween(a, b) <= within){ seen.add(b); queue.push(b); }
  }
  if(seen.size !== group.length) return { valid : false, reason : module.format("helpers.targets.apart", { within }) };

  return { valid : true, reason : "" };
}

/**
 * Pick a group of targets that stand close together, starting from the first token and adding anyone
 * within `within` feet of someone already in the group (so A-B-C in a row all count).
 * With `prompt`, and no targets of your own, you choose them instead, with the range and the choices shown on the map.
 * @param {Token[]} tokens                        candidates, in priority order
 * @param {object} [options]
 * @param {number|Function} [options.numberAllowed=Infinity]  a number, or (group) => number, rechecked as the group grows
 * @param {number} [options.within=5]            feet between group members
 * @param {boolean} [options.setTargets=false]   also make the group your targets
 * @param {boolean} [options.prompt=false]       let the user choose when they have no targets and there is a choice
 * @param {Item|Token} [options.origin]          prompt : whose range to show on the map (item = its owner + its range)
 * @param {number} [options.range]               prompt : range to show, defaults to the origin item's range
 * @returns {Promise<Token[]>}  the group, empty if the prompt was closed
 */
export async function selectTargets(tokens, { numberAllowed = Infinity, within = 5, setTargets : target = false, prompt = false, origin, range } = {}){
  const candidates = (tokens ?? []).map(t => tokenOf(t)).filter(Boolean);
  if(!candidates.length) return [];

  let group = null;
  if(prompt && !game.user.targets.size && (candidates.length > 1)){
    const picked = await promptTargets(candidates, { numberAllowed, within, origin, range });
    if(picked === null) return [];
    if(picked !== "auto") group = picked;
  }
  group ??= autoGroup(candidates, { numberAllowed, within });

  if(target) setTargets(group);
  return group;
}

/* The automatic pick : grow from the first candidate while the rules allow */
function autoGroup(candidates, { numberAllowed, within }){
  const allowed = group => typeof numberAllowed === "function" ? numberAllowed(group) : numberAllowed;
  const group = [candidates[0]];
  let added = true;
  while(added){
    added = false;
    for(const t of candidates){
      if(group.includes(t)) continue;
      const next = [...group, t];
      if(next.length > allowed(next)) continue;
      if(group.some(g => distanceBetween(g, t) <= within)){ group.push(t); added = true; }
    }
  }
  return group;
}

/**
 * Dialog listing the candidates, with the origin's range, the candidates and your picks highlighted on the map.
 * @returns {Promise<Token[]|"auto"|null>}  picks, "auto" for the automatic pick, null if closed
 */
async function promptTargets(candidates, { numberAllowed, within, origin, range }){
  const from = tokenOf(origin);
  const feet = range ?? ((origin?.documentName === "Item" || origin?.item) ? getRange(origin) : 0);
  const highlight = highlightRange(from, feet, { tokens : candidates });
  const esc = Handlebars.escapeExpression;

  const rows = candidates.map(t => `
    <li>
      <label class="checkbox">
        <input type="checkbox" name="target" value="${t.id}">
        <img src="${esc(t.document.texture.src)}" alt="" data-pan="${t.id}" data-tooltip="${esc(module.i18n("helpers.targets.pan"))}">
        <span class="name">${esc(t.name)}</span>
        <span class="distance">${from ? `${Math.round(distanceBetween(from, t))} ${esc(canvas.scene.grid.units)}` : ""}</span>
      </label>
    </li>`).join("");

  const picked = dialog => [...dialog.element.querySelectorAll("input[name=target]:checked")]
    .map(input => candidates.find(t => t.id === input.value)).filter(Boolean);

  try {
    return await foundry.applications.api.DialogV2.wait({
      window : { title : module.i18n("helpers.targets.title"), icon : "fa-solid fa-bullseye" },
      classes : [`${module.id}-target-prompt`],
      content : `
        <p class="hint">${esc(module.i18n("helpers.targets.hint"))}</p>
        <ul class="unlist ${module.id}-target-list">${rows}</ul>
        <p class="${module.id}-target-status"></p>`,
      buttons : [
        { action : "attack", label : "helpers.targets.confirm", icon : "fa-solid fa-check", default : true,
          callback : (_event, _button, dialog) => picked(dialog) },
        { action : "auto", label : "helpers.targets.auto", icon : "fa-solid fa-wand-magic-sparkles",
          callback : ()=> "auto" },
      ],
      render : (_event, dialog) => {
        const root = dialog.element;
        if(root.dataset.macroHelperReady) return;
        root.dataset.macroHelperReady = "true";

        const confirm = root.querySelector("button[data-action=attack]");
        const status = root.querySelector(`.${module.id}-target-status`);
        const refresh = () => {
          const group = picked(dialog);
          highlight.select(group);
          const { valid, reason } = isValidGroup(group, { numberAllowed, within });
          confirm.disabled = !valid;
          status.textContent = group.length ? reason : "";
        };
        root.addEventListener("change", event => { if(event.target.name === "target") refresh(); });
        root.addEventListener("click", event => {
          const id = event.target.dataset?.pan;
          const token = id && candidates.find(t => t.id === id);
          if(!token) return;
          event.preventDefault();
          canvas.animatePan({ x : token.center.x, y : token.center.y, duration : 250 });
        });
        refresh();
      },
    });
  } finally {
    highlight.clear();
  }
}

/**
 * Replace your targets with these tokens.
 * @param {Token[]} tokens
 */
export function setTargets(tokens){
  canvas.tokens.setTargets((tokens ?? []).map(t => tokenOf(t)?.id).filter(Boolean));
}

/**
 * Pick targets by clicking them on the map :
 *   the origin's range, the candidates and the picks are shown on the map (only on your screen),
 *   left click a candidate to pick / unpick it (clicks don't select tokens meanwhile),
 *   Enter to confirm, Esc to cancel. With confirm "auto" it finishes as soon as the most allowed are picked.
 *   With `repeat`, the same token can be picked more than once (Multiattack at one foe) : left click adds a pick,
 *   right click takes one away. The picks come back once per pick, in order ([A, A, B]).
 * If you already have targets in range, those are used and nothing is asked (with `repeat`, spread over `count` : A A B B).
 *
 * @param {Item|Token|TokenDocument|Actor} origin   an item (its owner + its range) or a token / actor (give a range)
 * @param {object} [options]
 * @param {number} [options.count=1]                 most targets
 * @param {number} [options.range]                   feet, defaults to the item's range (see getRange), else anywhere
 * @param {number} [options.normalRange]             feet : beyond it (up to range) is shown red, long range (disadvantage)
 * @param {string} [options.notice]                  an extra line in the banner (e.g. why attacks have disadvantage)
 * @param {"enemy"|"ally"|"any"} [options.disposition="enemy"]
 * @param {number|Function} [options.numberAllowed]  extra limit, a number or (picks) => number (size rules...)
 * @param {number} [options.within]                  picks must be within this many feet of each other
 * @param {"auto"|"enter"} [options.confirm="auto"]  finish at the limit, or always wait for Enter
 * @param {boolean} [options.setTargets=true]        make the picks your targets
 * @param {boolean} [options.useTargets=true]        use the targets you already have in range instead of asking;
 *                                                   false clears your targets first and always asks
 * @param {boolean} [options.repeat=false]          the same token can be picked more than once
 * @param {Function} [options.filter]              only tokens that pass (token) => boolean can be picked
 * @param {boolean} [options.long] [options.thrown]  passed to getRange
 * @returns {Promise<Token[]>}  the picks, empty if cancelled or nothing in range
 */
export async function pickTargets(origin, { count = 1, range, disposition = "enemy", numberAllowed = Infinity, within = Infinity,
  confirm = "auto", setTargets : target = true, useTargets = true, repeat = false, long = false, thrown = false, normalRange, notice = "", filter } = {}){
  const from = tokenOf(origin);
  if(!from) return warn(module.i18n("helpers.pick.noToken"));
  if(!useTargets) canvas.tokens.setTargets([]);

  const isItem = (origin?.documentName === "Item") || !!origin?.item;
  const feet = range ?? (isItem ? getRange(origin, { long, thrown }) : Infinity);
  const candidates = getTokensWithin(from, feet, { disposition, filter });
  if(!candidates.length) return warn(module.i18n("helpers.pick.none"));

  /* Your own targets in range win, nothing to ask */
  const targeted = useTargets
    ? [...game.user.targets].filter(t => (t !== from) && (distanceBetween(from, t) <= feet) && (!filter || filter(t)))
    : [];
  if(targeted.length){
    if(!repeat || (targeted.length >= count)) return targeted.slice(0, count);
    return Array.from({ length : count }, (_, i) => targeted[Math.floor(i * targeted.length / count)]);
  }

  const picks = await pickOnMap(from, feet, candidates, { count, numberAllowed, within, confirm, repeat, normalRange, notice });
  if(target && picks.length) setTargets(picks);
  return picks;
}

function warn(message){
  ui.notifications.warn(message);
  return [];
}

/* The clicking itself : overlay, banner, click + key listeners, all removed at the end */
function pickOnMap(from, feet, candidates, { count, numberAllowed, within, confirm, repeat = false, normalRange, notice = "" }){
  const allowed = picks => Math.min(count, typeof numberAllowed === "function" ? numberAllowed(picks) : numberAllowed);
  const highlight = highlightRange(from, feet, { tokens : candidates, normal : normalRange });
  const hasLong = Number.isFinite(normalRange) && (normalRange < feet);
  const view = canvas.app.view;
  const picks = [];

  const banner = document.createElement("div");
  banner.className = `${module.id}-pick-banner`;
  document.body.append(banner);

  return new Promise(resolve => {
    const status = message => {
      const limit = allowed(picks.length ? picks : candidates.slice(0, 1));
      banner.innerHTML = `<strong>${module.format("helpers.pick.banner", { picked : picks.length, limit })}</strong>`
        + (picks.length ? `<span class="picks">${Handlebars.escapeExpression(listPicks(picks))}</span>` : "")
        + `<span>${module.i18n(repeat ? "helpers.pick.keysRepeat" : "helpers.pick.keys")}</span>`
        + `<span class="legend">${module.i18n(hasLong ? "helpers.pick.legendLong" : "helpers.pick.legend")}</span>`
        + (notice ? `<span class="notice">${Handlebars.escapeExpression(notice)}</span>` : "")
        + (message ? `<span class="warning">${message}</span>` : "");
    };

    const finish = result => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("contextmenu", onMenu, true);
      window.removeEventListener("keydown", onKey, true);
      highlight.clear();
      banner.remove();
      resolve(result);
    };

    /* Enter / auto : only with a valid group (the rules count each token once, however many times it's picked) */
    const tryConfirm = () => {
      if(!picks.length) return status(module.i18n("helpers.targets.none"));
      const { valid, reason } = isValidGroup([...new Set(picks)], { numberAllowed : allowed(picks), within });
      if(!valid) return status(reason);
      finish([...picks]);
    };

    const onPointer = event => {
      const remove = repeat && (event.button === 2);
      if((event.target !== view) || ((event.button !== 0) && !remove)) return;
      const point = canvas.canvasCoordinatesFromClient({ x : event.clientX, y : event.clientY });
      const token = candidates.find(t => t.bounds.contains(point.x, point.y));
      /* Right clicks elsewhere still pan the map */
      if(remove && !token) return;

      /* Left clicks on the map (and right clicks on a candidate when repeating) are for picking : Foundry doesn't see them */
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if(!token) return;

      const index = picks.lastIndexOf(token);
      if(remove || (!repeat && (index >= 0))){
        if(index < 0) return;
        picks.splice(index, 1);
      }
      else {
        if(picks.length >= allowed([...picks, token])) return status(module.format("helpers.targets.tooMany", { allowed : allowed([...picks, token]) }));
        picks.push(token);
      }
      highlight.select(picks);
      canvas.tokens.setTargets(picks.map(t => t.id));
      status();

      if((confirm === "auto") && picks.length && (picks.length >= allowed(picks))) tryConfirm();
    };

    const onKey = event => {
      if(event.key === "Enter"){ event.preventDefault(); event.stopPropagation(); tryConfirm(); }
      else if(event.key === "Escape"){
        event.preventDefault(); event.stopPropagation();
        canvas.tokens.setTargets([]);
        finish([]);
      }
    };

    /* Repeating : right click takes a pick away, so no token HUD / context menu meanwhile */
    const onMenu = event => {
      if(repeat && (event.target === view)){ event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); }
    };

    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("contextmenu", onMenu, true);
    window.addEventListener("keydown", onKey, true);
    status();
  });
}

/* "Lucian ×2, Randal" */
function listPicks(picks){
  const counts = new Map();
  for(const t of picks) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([t, n]) => (n > 1) ? `${t.name} ×${n}` : t.name).join(", ");
}

/* ---------- Flanking (DMG optional rule) ---------- */

/* Does the segment p -> q cross a vertical (x = X, y0..y1) or horizontal (y = Y, x0..x1) edge ? Corners count. */
function crosses(p, q, { x, y0, y1 } = {}, { y, x0, x1 } = {}){
  const eps = 1e-6;
  if(x !== undefined){
    if(Math.abs(q.x - p.x) < eps) return false;
    const t = (x - p.x) / (q.x - p.x);
    if((t < -eps) || (t > 1 + eps)) return false;
    const at = p.y + (t * (q.y - p.y));
    return (at >= y0 - eps) && (at <= y1 + eps);
  }
  if(Math.abs(q.y - p.y) < eps) return false;
  const t = (y - p.y) / (q.y - p.y);
  if((t < -eps) || (t > 1 + eps)) return false;
  const at = p.x + (t * (q.x - p.x));
  return (at >= x0 - eps) && (at <= x1 + eps);
}

/**
 * Who flanks a target with the attacker (DMG optional rule) : an ally of the attacker, also next to the target,
 * on the opposite side. A line between the two flankers' centers must pass through opposite sides or opposite
 * corners of the target's space. Allies that are down or incapacitated don't count.
 * @param {Token|TokenDocument|Actor} attacker
 * @param {Token|TokenDocument|Actor} target
 * @returns {Token|null}  the ally flanking with the attacker, null if the target isn't flanked
 */
export function getFlanker(attacker, target){
  const a = tokenOf(attacker), t = tokenOf(target);
  if(!a || !t || (a === t)) return null;
  const reach = canvas.scene.grid.distance;
  if(distanceBetween(a, t) > reach) return null;

  const { x : x0, y : y0 } = t.document;
  const x1 = x0 + t.w, y1 = y0 + t.h;
  const opposite = (p, q) => (crosses(p, q, { x : x0, y0, y1 }) && crosses(p, q, { x : x1, y0, y1 }))
    || (crosses(p, q, {}, { y : y0, x0, x1 }) && crosses(p, q, {}, { y : y1, x0, x1 }));

  return canvas.tokens.placeables.find(ally => (ally !== a) && (ally !== t) && ally.actor
    && isAlly(ally, a)
    && ((ally.actor.system.attributes?.hp?.value ?? 1) > 0)
    && !INCAPACITATED.some(status => ally.actor.statuses?.has(status))
    && (distanceBetween(ally, t) <= reach)
    && opposite(a.center, ally.center)) ?? null;
}

/**
 * Is the attacker flanking the target with an ally (see getFlanker) ?
 * @param {Token|TokenDocument|Actor} attacker
 * @param {Token|TokenDocument|Actor} target
 * @returns {boolean}
 */
export function isFlanking(attacker, target){
  return !!getFlanker(attacker, target);
}
