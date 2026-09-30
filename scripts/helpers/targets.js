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
        <span class="distance">${from ? `${distanceBetween(from, t)} ${esc(canvas.scene.grid.units)}` : ""}</span>
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
