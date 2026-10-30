import { module } from '../module.js';
import { warned } from './utils.js';
import { tokenOf, distanceBetween, getRange, getTokensWithin, highlightRange, isOutOfAction, isIncapacitated, canSee, isSpaceFree, HIGHLIGHT, actingNowFrom } from './tokens.js';

/* Opposite dispositions (hostile vs friendly) */
export function isEnemy(a, b){
  return (tokenOf(a)?.document.disposition * tokenOf(b)?.document.disposition) < 0;
}

/* Same non-neutral disposition */
export function isAlly(a, b){
  return (tokenOf(a)?.document.disposition * tokenOf(b)?.document.disposition) > 0;
}

/* dnd5e conditions that stop a creature threatening anyone (all of them include Incapacitated) */

/**
 * The allies of a creature within `feet` of a target, nearest first (Sneak Attack's "an ally within 5 ft of it", Pack
 * Tactics). Neither the creature nor the target counts, nor an ally that's Incapacitated, dead or at 0 HP.
 * @param {Token|TokenDocument|Actor} target
 * @param {Token|TokenDocument|Actor} of       whose allies
 * @param {object} [options]
 * @param {number} [options.feet=5]
 * @param {boolean} [options.includeIncapacitated=false]
 * @param {Function} [options.filter]          extra (token) => boolean
 * @returns {Token[]}
 */
export function alliesNear(target, of, { feet = 5, includeIncapacitated = false, filter } = {}){
  const t = tokenOf(target), a = tokenOf(of);
  if(!t || !a) return [];
  return getTokensWithin(t, feet, { filter : ally => (ally !== a) && isAlly(ally, a)
    && (includeIncapacitated || !isIncapacitated(ally))
    && (!filter || filter(ally)) });
}

/* ---------- Targets an item can't have ---------- */

const exclusions = [];
let exclusionsHooked = false;

/**
 * Creatures an item can't be used on, dropped from its targets as they're picked or found in an area, with a notice
 * saying why (Bardic Inspiration : "another creature", not one already Inspired; a monster's "each creature other than
 * itself", "Undead only").
 *
 *   MacroHelper.excludeTargets("bardic", { applies : activity => idOf(activity.item) === "bardic-inspiration", self : true,
 *     exclude : (token, activity) => hasInspiration(token.actor) ? `${token.name} is already Inspired.` : false });
 *
 * @param {string} id   the same id again replaces the rule (a macro)
 * @param {object} rule
 * @param {(activity : Activity) => boolean} rule.applies   the uses it's for
 * @param {boolean} [rule.self=false]                       the user's own token is dropped (no notice)
 * @param {(token : Token, activity : Activity) => string|boolean} [rule.exclude]   true or a notice : dropped
 */
export function excludeTargets(id, rule){
  const old = exclusions.findIndex(r => r.id === id);
  if(old >= 0) exclusions[old] = { id, ...rule };
  else exclusions.push({ id, ...rule });
  if(exclusionsHooked) return;
  exclusionsHooked = true;
  Hooks.on(`${module.id}.targets`, (activity, tokens) => {
    for(const rule of exclusions){
      try {
        if((rule.enabled && !rule.enabled()) || !rule.applies(activity)) continue;
        const me = tokenOf(activity.getUsageToken?.() ?? activity.actor);
        for(let i = tokens.length - 1; i >= 0; i--){
          const t = tokens[i];
          if(rule.self && (t === me)){ tokens.splice(i, 1); continue; }
          const why = rule.exclude?.(t, activity);
          if(!why) continue;
          if(typeof why === "string") ui.notifications.info(why);
          tokens.splice(i, 1);
        }
      } catch(error){ console.error("Macro Helper | excludeTargets", rule.id, error); }
    }
  });
}

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
    disposition : "nonAlly",
    includeHidden,
    /* 2024 : an enemy who can see you and isn't Incapacitated */
    filter : t => (includeIncapacitated || !isIncapacitated(t)) && canSee(t, token),
  });
}

/**
 * Is a token threatened : a creature not on its side (Hostile or Neutral) within 5 feet that isn't incapacitated ?
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
 * @param {boolean} [options.includeSelf=false]      the origin's own token can be picked too (Healing Hands, Mage Armor)
 * @param {boolean} [options.sight=true]             only tokens the origin's token can see (Vision Rules setting); false : any
 * @param {Function} [options.tokenColor]          (token) => "advantage" | "normal5e" | "disadvantage" : a colour per candidate (attacks)
 * @param {Function} [options.tokenWhy]            (token) => { mode, advantage : [], disadvantage : [] } : shown hovering it
 * @param {boolean} [options.long] [options.thrown]  passed to getRange
 * @param {Token|TokenDocument} [options.from]     range measured from this token's space instead (actFrom : Invoke
 *                                                   Duplicity's illusion); sight stays the origin's own, and `from` itself
 *                                                   is never a candidate
 * @param {Token[]} [options.picked]                candidates picked already as it opens (click one to unpick it)
 * @param {*} [options.cancelled=[]]                what Esc gives back (null : tell a cancel from no picks)
 * @returns {Promise<Token[]>}  the picks, empty if cancelled or nothing in range
 */
export async function pickTargets(origin, { count = 1, range, disposition = "enemy", numberAllowed = Infinity, within = Infinity,
  confirm = "auto", setTargets : target = true, useTargets = true, repeat = false, long = false, thrown = false, normalRange, notice = "", filter : only, includeSelf = false,
  sight = true, tokenColor, tokenWhy, from : place = null, picked = [], cancelled = [] } = {}){
  const from = tokenOf(origin);
  if(!from) return warned(module.i18n("helpers.pick.noToken"));
  /* Where it's measured from : the origin's token, or the space it acts from (given, or its use's : actFrom) */
  const at = (place && tokenOf(place)) || actingNowFrom(from) || from;
  if(!useTargets) canvas.tokens.setTargets([]);
  /* Only what the picker can see (Vision Rules) */
  const filter = sight ? (t => canSee(from, t) && (!only || only(t))) : only;

  const isItem = (origin?.documentName === "Item") || !!origin?.item;
  const feet = range ?? (isItem ? getRange(origin, { long, thrown }) : Infinity);
  /* Sides are the origin's; distance from where it acts */
  const candidates = (at === from) ? getTokensWithin(from, feet, { disposition, filter, includeSelf })
    : getTokensWithin(from, Infinity, { disposition, filter, includeSelf }).filter(t => (t !== at) && (distanceBetween(at, t) <= feet))
      .sort((a, b) => distanceBetween(at, a) - distanceBetween(at, b));
  if(!candidates.length) return warned(module.i18n("helpers.pick.none"));

  /* Your own targets in range win, nothing to ask */
  const targeted = useTargets
    ? [...game.user.targets].filter(t => ((t !== from) || includeSelf) && ((t !== at) || (at === from)) && (distanceBetween(at, t) <= feet) && (!filter || filter(t)))
    : [];
  if(targeted.length){
    /* Your own targets follow the same group rules as a pick (how many, within how far of each other) : else you pick */
    const rules = (typeof numberAllowed === "function") || Number.isFinite(numberAllowed) || Number.isFinite(within);
    const allowed = Math.min(count, typeof numberAllowed === "function" ? numberAllowed(targeted) : numberAllowed);
    const fits = !rules || ((targeted.length <= allowed) && (!Number.isFinite(within) || isValidGroup(targeted, { within }).valid));
    if(fits && (!repeat || (targeted.length >= count))) return targeted.slice(0, count);
    if(!fits) ui.notifications.info(module.i18n("helpers.pick.targetsDontFit"));
    else return Array.from({ length : count }, (_, i) => targeted[Math.floor(i * targeted.length / count)]);
  }

  const picks = await pickOnMap(at, feet, candidates, { count, numberAllowed, within, confirm, repeat, normalRange, notice, includeSelf, tokenColor, tokenWhy,
    picked : picked.filter(t => candidates.includes(t)) });
  if(picks === null) return cancelled;
  if(target && picks.length) setTargets(picks);
  return picks;
}

/* The clicking itself : overlay, banner, click + key listeners, all removed at the end */
function pickOnMap(from, feet, candidates, { count, numberAllowed, within, confirm, repeat = false, normalRange, notice = "", includeSelf = false, tokenColor, tokenWhy, picked = [] }){
  const allowed = picks => Math.min(count, typeof numberAllowed === "function" ? numberAllowed(picks) : numberAllowed);
  const highlight = highlightRange(from, feet, { tokens : candidates, normal : normalRange, showSelf : includeSelf, tokenColor });
  const hasLong = Number.isFinite(normalRange) && (normalRange < feet);
  const view = canvas.app.view;
  const picks = [...picked];
  if(picks.length){
    highlight.select(picks);
    canvas.tokens.setTargets(picks.map(t => t.id));
  }

  const banner = document.createElement("div");
  banner.className = `${module.id}-pick-banner`;
  document.body.append(banner);

  return new Promise(resolve => {
    const status = message => {
      const limit = allowed(picks.length ? picks : candidates.slice(0, 1));
      banner.innerHTML = `<strong>${module.format("helpers.pick.banner", { picked : picks.length, limit })}</strong>`
        + (picks.length ? `<span class="picks">${Handlebars.escapeExpression(listPicks(picks))}</span>` : "")
        + `<span>${module.i18n(repeat ? "helpers.pick.keysRepeat" : "helpers.pick.keys")}</span>`
        + `<span class="legend">${module.i18n(tokenColor ? "helpers.pick.legendModes" : hasLong ? "helpers.pick.legendLong" : "helpers.pick.legend")}</span>`
        + (notice ? `<span class="notice">${Handlebars.escapeExpression(notice)}</span>` : "")
        + (message ? `<span class="warning">${message}</span>` : "");
    };

    /* Hovering a candidate : why it's green or red (advantage, disadvantage and their reasons) */
    const tip = document.createElement("div");
    tip.className = `${module.id}-pick-tip`;
    tip.hidden = true;
    if(tokenWhy) document.body.append(tip);
    const onHover = event => {
      if(!tokenWhy) return;
      const point = onMap(event.target) ? canvas.canvasCoordinatesFromClient({ x : event.clientX, y : event.clientY }) : null;
      const token = point ? candidates.find(t => t.bounds.contains(point.x, point.y)) : null;
      const why = token ? tokenWhy(token) : null;
      const lines = why ? [
        ...(why.advantage?.length ? [`<div class="adv">${Handlebars.escapeExpression(module.i18n("helpers.pick.advantage"))} : ${why.advantage.map(r => Handlebars.escapeExpression(r)).join(" · ")}</div>`] : []),
        ...(why.disadvantage?.length ? [`<div class="dis">${Handlebars.escapeExpression(module.i18n("helpers.pick.disadvantage"))} : ${why.disadvantage.map(r => Handlebars.escapeExpression(r)).join(" · ")}</div>`] : []),
      ] : [];
      if(!lines.length){ tip.hidden = true; return; }
      if((why.mode === "normal5e") && why.advantage?.length && why.disadvantage?.length) lines.push(`<div>${Handlebars.escapeExpression(module.i18n("helpers.pick.cancel"))}</div>`);
      tip.innerHTML = `<strong>${Handlebars.escapeExpression(token.name)}</strong>${lines.join("")}`;
      tip.style.left = `${event.clientX + 16}px`;
      tip.style.top = `${event.clientY + 16}px`;
      tip.hidden = false;
    };

    const finish = result => {
      window.removeEventListener("pointermove", onHover, true);
      tip.remove();
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

    /* On the map : the canvas, or a layer drawn over it (Dice So Nice's dice), not a window or the sidebar */
    const onMap = target => (target === view) || ((target?.tagName === "CANVAS") && !target.closest?.(".application, #sidebar, #ui-left, #ui-right, #hotbar"));
    const onPointer = event => {
      const remove = repeat && (event.button === 2);
      if(!onMap(event.target) || ((event.button !== 0) && !remove)) return;
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
        finish(null);
      }
    };

    /* Repeating : right click takes a pick away, so no token HUD / context menu meanwhile */
    const onMenu = event => {
      if(repeat && (event.target === view)){ event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); }
    };

    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("pointermove", onHover, true);
    window.addEventListener("contextmenu", onMenu, true);
    window.addEventListener("keydown", onKey, true);
    status();
  });
}

/**
 * Click an empty space on the map within range of a creature (where a summon appears). The range is shown like
 * pickTargets'; the space must be free of creatures, within range, and reachable without crossing a wall that blocks
 * movement. Esc cancels.
 * @param {Token|TokenDocument|Actor|Item} origin
 * @param {object} [options]
 * @param {number} [options.range=5]  in feet
 * @param {number} [options.size=1]   the space's width in squares (a Large creature : 2)
 * @param {string} [options.notice]   a line for the banner ("Owl")
 * @param {boolean} [options.occupied=false]  a creature's space will do too (a light hovering over it)
 * @param {(space : {x : number, y : number}) => string} [options.check]  why else a space won't do ("" : it will)
 * @param {string} [options.banner]  the banner's title, keys (another wording : "Click where the light goes")
 * @param {string} [options.keys]
 * @param {boolean} [options.seen=false]  a space it can see (a teleport) : its sight (walls that block sight, light, its senses,
 *   Blinded) instead of walls that block movement
 * @returns {Promise<{x : number, y : number}|null>}  the space's top-left corner (canvas pixels), null if cancelled
 */
export async function pickSpace(origin, { range = 5, size = 1, notice = "", occupied = false, check = null, banner : title = null, keys = null, seen = false } = {}){
  const eyes = tokenOf(origin);
  if(!eyes) return warned(module.i18n("helpers.pick.noToken")) && null;
  /* Measured from the space its use acts from (actFrom), seen with its own eyes */
  const from = actingNowFrom(eyes) || eyes;
  const highlight = highlightRange(from, range, { showSelf : false });
  const view = canvas.app.view;
  const grid = canvas.grid.size;
  const banner = document.createElement("div");
  banner.className = `${module.id}-pick-banner`;
  document.body.append(banner);
  const status = message => {
    banner.innerHTML = `<strong>${Handlebars.escapeExpression(title ?? module.i18n("helpers.space.banner"))}</strong>`
      + (notice ? `<span class="picks">${Handlebars.escapeExpression(notice)}</span>` : "")
      + `<span>${Handlebars.escapeExpression(keys ?? module.i18n("helpers.space.keys"))}</span>`
      + (message ? `<span class="warning">${message}</span>` : "");
  };

  /* The space under the mouse : yellow where it can go, red where it can't */
  const layer = canvas.interface.grid;
  const hoverName = `${module.id}-space`;
  layer.addHighlightLayer(hoverName);
  const spaceAt = event => {
    const point = canvas.canvasCoordinatesFromClient({ x : event.clientX, y : event.clientY });
    return { x : Math.floor(point.x / grid) * grid, y : Math.floor(point.y / grid) * grid };
  };
  /* Why a space can't be used, or "" */
  const problem = ({ x, y }) => {
    const space = { document : { x, y, width : size, height : size, elevation : from.document.elevation ?? 0 } };
    if(distanceBetween(from, space) > range) return module.i18n("helpers.space.tooFar");
    if(!occupied && !isSpaceFree(x, y, size)) return module.i18n("helpers.space.occupied");
    const other = check?.({ x, y }) ?? "";
    if(other) return other;
    const center = { x : x + (size * grid / 2), y : y + (size * grid / 2) };
    let blocked = false;
    if(seen) return canSee(eyes, center) ? "" : module.i18n("helpers.space.unseen");
    try { blocked = !!CONFIG.Canvas.polygonBackends.move.testCollision(from.center, center, { type : "move", mode : "any" }); }
    catch { blocked = false; }
    return blocked ? module.i18n("helpers.space.wall") : "";
  };
  let hovered = null;

  return new Promise(resolve => {
    const finish = result => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("keydown", onKey, true);
      highlight.clear();
      layer.destroyHighlightLayer(hoverName);
      banner.remove();
      resolve(result);
    };
    const onMap = target => (target === view) || ((target?.tagName === "CANVAS") && !target.closest?.(".application, #sidebar, #ui-left, #ui-right, #hotbar"));
    const onMove = event => {
      if(!onMap(event.target)) return;
      const at = spaceAt(event);
      if(hovered && (hovered.x === at.x) && (hovered.y === at.y)) return;
      hovered = at;
      const color = problem(at) ? HIGHLIGHT.long : HIGHLIGHT.normal5e;
      layer.clearHighlightLayer(hoverName);
      for(let i = 0; i < size; i++) for(let j = 0; j < size; j++){
        layer.highlightPosition(hoverName, { x : at.x + (i * grid), y : at.y + (j * grid), color, alpha : 0.5, border : color });
      }
    };
    const onPointer = event => {
      if(!onMap(event.target) || (event.button !== 0)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const at = spaceAt(event);
      const why = problem(at);
      if(why) return status(why);
      finish(at);
    };
    const onKey = event => {
      if(event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      finish(null);
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("pointermove", onMove, true);
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

  /* Where the tokens are, not where their move animation has got to (an attack right after moving) */
  const size = canvas.grid.size;
  const centre = tok => { const d = tok.document; return { x : d.x + ((Number(d.width) || 1) * size / 2), y : d.y + ((Number(d.height) || 1) * size / 2) }; };
  return canvas.tokens.placeables.find(ally => (ally !== a) && (ally !== t) && ally.actor
    && isAlly(ally, a)
    && !isOutOfAction(ally)
    && !isIncapacitated(ally)
    && (distanceBetween(ally, t) <= reach)
    && opposite(centre(a), centre(ally))) ?? null;
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
