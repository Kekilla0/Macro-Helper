import { module } from '../module.js';
import { rollItem } from '../roll-item/roll-item.js';
import { tokenOf, actorOf, distanceBetween, getRange } from './tokens.js';
import { pickTargets, getThreats } from './targets.js';
import { findItem } from './actors.js';

/**
 * Item helpers.
 * Updating an item on an unlinked token (a split copy, most monsters) rebuilds the token's items, so the Item you
 * held is stale afterwards : these helpers return the fresh one to keep using.
 */

/* ---------- Weapons : how an attack is made, and what it uses up ----------
 * dnd5e uses things up inside its own attack roll, given the right attack mode :
 *   thrown attack mode       -> the weapon's own quantity goes down by 1 (not with the Returning property)
 *   ammunition (Ammunition)  -> the chosen ammunition item goes down by 1
 *   anything else            -> nothing
 */

/**
 * The attack mode to use against a target, for weapons that can be thrown :
 *   within reach                     -> the weapon's melee mode ("oneHanded"...), always given explicitly :
 *                                       dnd5e otherwise reuses the last mode, so a stab after a throw would be a throw
 *   beyond reach, within thrown range -> "thrown" (uses one up, not with Returning)
 *   weapons that can only be thrown (Dart) -> "thrown"
 * Weapons that can't be thrown : null (dnd5e's usual mode).
 * @param {Item} item
 * @param {Token|TokenDocument} target
 * @param {object} [options]
 * @param {boolean} [options.long=true]  allow throws out to long range
 * @returns {string|null}
 */
export function attackModeFor(item, target, { long = true } = {}){
  const modes = (item?.system?.attackModes ?? []).map(m => m.value).filter(Boolean);
  if(!modes.includes("thrown")) return null;
  const melee = modes.find(m => !m.startsWith("thrown")) ?? null;

  const from = tokenOf(item), to = tokenOf(target);
  if(!from || !to) return melee ?? "thrown";

  const distance = distanceBetween(from, to);
  if(distance <= getRange(item)) return melee ?? "thrown";                                  // within reach : stab (or throw a Dart)
  return (distance <= getRange(item, { thrown : true, long })) ? "thrown" : (melee ?? "thrown"); // beyond reach : throw it
}

/**
 * Pick targets on the map, then attack each with this item : one Roll Item card, one attack roll per target.
 *   Your targets are cleared first, so every attack starts from a fresh pick (nothing left over gets hit by accident).
 *   Thrown weapons can pick out to their throwing range : targets beyond reach are thrown at (uses one up, not with Returning).
 *   Targets at long range (ranged or thrown) are attacked with disadvantage, target by target (advantage keys still combine).
 *   While threatened (an enemy within 5 ft), ranged and thrown attacks have disadvantage, melee attacks don't.
 *   Weapons with ammunition use one per attack, when the actor carries some for it (like dnd5e).
 *   Everyone must have enough to throw / shoot, or nothing is rolled : a weapon at quantity 0 can't attack at all.
 *   strict : false lets them keep attacking regardless (dnd5e itself only warns).
 *   repeat : true lets the same target be picked more than once (Multiattack : both axes at one orc, or one each).
 *   Fewer picks than `count` is fine : Enter confirms, one attack per pick.
 * Problems are shown as a notification (and the console for errors), nothing is thrown.
 * This rolls the attack directly, like item.rollItem() : no dnd5e use (no spell slot or uses spent).
 * Roll Item's "Pick Targets" setting does the same picking inside dnd5e's own use instead.
 *
 * @param {Item} item
 * @param {object} [options]       see pickAttack, plus :
 * @param {Event} [options.event]  for advantage / disadvantage keys
 * @returns {Promise<object|null>}  Roll Item's result, null if cancelled or refused
 */
export async function pickAndAttack(item, { event, ...options } = {}){
  const picked = await pickAttack(item, options);
  if(!picked) return null;

  try {
    /* Attack : each target gets thrown at or hit, with disadvantage at long range or for a ranged attack while threatened.
       dnd5e combines it with advantage (keys, effects) and uses up what that attack needs */
    const { attack, targets, attackMode, disadvantage } = picked;
    const result = await rollItem.roll(item, { activity : attack.id, count : targets.length, targets, attackMode, disadvantage, event });
    if(!result) return attackFailed(item, module.i18n("helpers.attack.noRoll"));
    return result;
  }
  catch(error){
    return attackFailed(item, module.i18n("helpers.attack.error"), error);
  }
}

/* A notification (and the console for errors), then null */
function attackFailed(item, message, error){
  const name = item?.name ?? "Attack";
  ui.notifications.warn(`${name}: ${message}`);
  if(error) console.error(`Macro Helper | ${name} |`, error);
  return null;
}

/**
 * The picking half of pickAndAttack : check the item and attacker, pick targets on the map (range, long range and
 * threats shown), check there's enough to throw / shoot, and work out each attack's mode and disadvantage.
 * Hand the result to rollItem.roll / rollItem.rollActivity (targets, attackMode, disadvantage) to make the attacks.
 *
 * @param {Item} item
 * @param {object} [options]
 * @param {number} [options.count=1]                 most targets
 * @param {"enemy"|"ally"|"any"} [options.disposition="enemy"]  who can be picked
 * @param {number} [options.within]                  feet the targets must be within of each other
 * @param {boolean} [options.long=true]              ranged / thrown : allow targets out to long range (with disadvantage)
 * @param {"auto"|"enter"} [options.confirm="auto"]  finish as soon as the most allowed are picked, or wait for Enter
 * @param {boolean} [options.clearTargets=true]      clear your targets and always pick; false uses targets in range as-is
 * @param {boolean} [options.strict=true]            hold the attacker to their inventory (quantity, throws, ammunition)
 * @param {boolean} [options.threatened=true]        apply the threatened rule (ranged attacks with an enemy within 5 ft)
 * @param {boolean} [options.repeat=false]           the same target can be picked more than once (one attack per pick)
 * @param {string|Activity} [options.activity]       attack activity, or its id / name, default the first
 * @param {boolean} [options.used=false]             dnd5e has already used the activity : don't refuse it for having no uses left
 * @param {Function} [options.filter]              only tokens that pass (token) => boolean can be picked (Cleave : next to the first)
 * @returns {Promise<{ attack : Activity, targets : Token[], attackMode : Function, disadvantage : Function }|null>}
 *          null if cancelled or refused (with a notification saying why)
 */
export async function pickAttack(item, { count = 1, disposition = "enemy", within = Infinity, long = true, confirm = "auto",
  clearTargets = true, strict = true, threatened : threatRule = true, repeat = false, activity, used = false, filter } = {}){
  const fail = (message, error) => attackFailed(item, message, error);

  try {
    /* Item : MacroHelper.pickAndAttack({ ... }) without the item is an easy slip, say so */
    if(item && (typeof item === "object") && !item.documentName) return fail(module.i18n("helpers.attack.itemFirst"));
    if(!item || (item.documentName !== "Item")) return fail(module.i18n("helpers.attack.noItem"));
    if(!game.settings.get(module.id, "rollItem")) return fail(module.i18n("rollItem.warn.disabled"));
    const attacks = item.system.activities?.getByType("attack") ?? [];
    const attack = (activity?.type === "attack") ? activity
      : activity ? attacks.find(a => (a.id === activity) || (a.name === activity)) : attacks[0];
    if(!attack) return fail(module.i18n("helpers.attack.noAttack"));
    /* used : dnd5e already used it (Roll Item's Pick Targets), its last use may have just been spent */
    if(!used && !attack.canUse) return fail(module.i18n("helpers.attack.cantUse"));

    /* Attacker */
    const actor = item.actor;
    if(!actor) return fail(module.i18n("helpers.attack.noActor"));
    const attacker = tokenOf(item);
    if(!attacker) return fail(module.format("helpers.attack.noToken", { name : actor.name }));
    if(!canvas.ready || (attacker.document.parent !== canvas.scene)) return fail(module.format("helpers.attack.otherScene", { name : actor.name }));
    if((actor.system.attributes?.hp?.value ?? 1) <= 0) return fail(module.format("helpers.attack.down", { name : actor.name }));

    /* Range : thrown weapons reach as far as they can be thrown */
    const thrown = canThrow(item);
    const range = Math.max(getRange(attack, { long }), thrown ? getRange(item, { thrown : true, long }) : 0);
    /* Normal range : beyond it (up to range) is long range, shown red on the map and attacked with disadvantage */
    const normalRange = Math.max(getRange(attack), thrown ? getRange(item, { thrown : true }) : 0);
    if(!(range > 0)) return fail(module.i18n("helpers.attack.noRange"));

    /* Running out : with strict (the default) nobody attacks with what they don't have, dnd5e itself only warns */
    const quantity = item.system.quantity ?? 1;
    if(strict && (item.type === "weapon") && (quantity <= 0)) return fail(module.i18n("helpers.attack.noneLeft"));

    /* Threatened : ranged / thrown attacks have disadvantage wherever they land, so the map shows them all red
       (a bow : all of its range, a dagger : everything past the stab) */
    const threats = threatRule ? getThreats(attacker) : [];
    const threatened = threats.length > 0;
    const shownNormal = threatened ? (isRangedItem(item) ? 0 : getRange(attack)) : normalRange;
    const notice = threatened ? module.format("helpers.attack.threatened", { names : threats.map(t => t.name).join(", ") }) : "";

    /* Pick */
    const targets = await pickTargets(item, {
      count : Math.max(1, Math.floor(count) || 1),
      range, within, disposition, confirm, notice, repeat, filter,
      normalRange : shownNormal,
      useTargets : !clearTargets,
    });
    if(!targets.length) return null;   // cancelled, or nothing in range (pickTargets said which)

    /* Enough to throw / shoot */
    const attackMode = target => attackModeFor(item, target, { long });
    if(strict){
      const throws = targets.filter(t => attackMode(t) === "thrown").length;
      if(throws && !item.system.properties?.has("ret") && (throws > quantity)){
        return fail(module.format("helpers.attack.notEnoughThrown", { throws, quantity }));
      }
    }
    const ammo = item.system.properties?.has("amm") ? getAmmunition(item) : null;
    if(strict && ammo && ((ammo.system.quantity ?? 0) < targets.length)){
      return fail(module.format("helpers.attack.notEnoughAmmo", { attacks : targets.length, quantity : ammo.system.quantity ?? 0, ammo : ammo.name }));
    }

    /* Disadvantage at long range, or for a ranged / thrown attack while threatened */
    const disadvantage = target => isLongRange(item, target) || (threatened && isRangedAttack(item, target));
    return { attack, targets, attackMode, disadvantage };
  }
  catch(error){
    return fail(module.i18n("helpers.attack.error"), error);
  }
}

/**
 * Is a target at long range for this weapon : beyond its normal range but within its long range (ranged or thrown) ?
 * 5e : attacks at long range have disadvantage. Melee attacks within reach never are.
 * @param {Item} item
 * @param {Token|TokenDocument} target
 * @returns {boolean}
 */
export function isLongRange(item, target){
  const from = tokenOf(item), to = tokenOf(target);
  if(!from || !to) return false;

  const thrown = attackModeFor(item, target, { long : true }) === "thrown";
  const ranged = thrown || (item.system.attackType === "ranged") || (item.type !== "weapon");
  if(!ranged) return false;

  const distance = distanceBetween(from, to);
  const normal = getRange(item, { thrown, long : false });
  const long = getRange(item, { thrown, long : true });
  return (long > normal) && (distance > normal) && (distance <= long);
}

/**
 * Is this item a ranged attack by nature : a ranged weapon (bow, Dart), or a ranged spell / feature attack (Fire Bolt) ?
 * Thrown melee weapons (Dagger) aren't : whether they're thrown depends on the target, see isRangedAttack.
 * @param {Item} item
 * @returns {boolean}
 */
export function isRangedItem(item){
  if(item?.type === "weapon") return item.system.attackType === "ranged";
  const attack = item?.system?.activities?.getByType?.("attack")[0];
  return attack?.attack?.type?.value === "ranged";
}

/**
 * Is an attack on this target a ranged attack : a ranged item, or a thrown weapon thrown at it (beyond reach) ?
 * 5e : ranged attacks while threatened (an enemy within 5 ft) have disadvantage, melee attacks don't.
 * @param {Item} item
 * @param {Token|TokenDocument} [target]
 * @returns {boolean}
 */
export function isRangedAttack(item, target){
  if(isRangedItem(item)) return true;
  return !!target && (attackModeFor(item, target)?.startsWith("thrown") ?? false);
}

/**
 * Can this weapon be thrown (the Thrown property) ?
 * @param {Item} item
 */
export function canThrow(item){
  return !!item?.system?.properties?.has("thr");
}

/**
 * The ammunition item dnd5e would use for this weapon's attack : the last one used, else the first it offers.
 * null for weapons without the Ammunition property.
 * @param {Item} item
 * @returns {Item|null}
 */
export function getAmmunition(item){
  const options = (item?.system?.ammunitionOptions ?? []).filter(o => o.value);
  if(!options.length) return null;
  const attack = item.system.activities?.getByType("attack")[0];
  const last = attack ? item.getFlag("dnd5e", `last.${attack.id}.ammunition`) : null;
  const id = options.some(o => o.value === last) ? last : options[0].value;
  return item.actor?.items.get(id) ?? null;
}

/* ---------- Limited uses (1/Day, Recharge...) ---------- */

/**
 * An item's limited uses, or null if it has none.
 * @param {Item} item
 * @returns {{ value : number, max : number, spent : number }|null}
 */
export function getUses(item){
  const uses = item?.system?.uses;
  const max = Number(uses?.max) || 0;
  if(!(max > 0)) return null;
  return { value : Number(uses.value) || 0, max, spent : Number(uses.spent) || 0 };
}

/**
 * Does the item have this many uses left ? Items without limited uses always do.
 * @param {Item} item
 * @param {number} [amount=1]
 * @returns {boolean}
 */
export function hasUses(item, amount = 1){
  const uses = getUses(item);
  return !uses || (uses.value >= amount);
}

/**
 * Use up some of an item's uses (a negative amount gives them back). Nothing happens if there aren't enough.
 * @param {Item} item
 * @param {number} [amount=1]
 * @param {object} [options]
 * @param {boolean} [options.warn=true]  say so when there aren't enough
 * @returns {Promise<Item|null>}  the fresh item, null if it has no limited uses or not enough left
 */
export async function spendUses(item, amount = 1, { warn = true } = {}){
  const uses = getUses(item);
  if(!uses) return null;
  if((amount > 0) && (uses.value < amount)){
    if(warn) ui.notifications.warn(module.format("helpers.uses.none", { name : item.name }));
    return null;
  }
  const spent = Math.clamp(uses.spent + amount, 0, uses.max);
  return updateItem(item, { "system.uses.spent" : spent });
}

/**
 * Use an item the dnd5e way (its uses / slots / action, its chat card, its effects) from inside its own item macro,
 * then carry on with what the macro adds (Healing Rage : the card and the daily use, then the healing).
 * No usage dialog unless asked.
 * @param {Item} item
 * @param {object} [options]
 * @param {string} [options.activity]      activity id, name or type ("utility"), default the first
 * @param {boolean} [options.configure=false]  show dnd5e's usage dialog
 * @param {Event} [options.event]
 * @returns {Promise<object|null>}  dnd5e's usage results, null if it wasn't used (no uses left, cancelled...)
 */
export async function useActivity(item, { activity, configure = false, event } = {}){
  const activities = item?.system?.activities;
  if(!activities?.size) return null;
  const chosen = activity
    ? activities.find(a => (a.id === activity) || (a.name === activity) || (a.type === activity))
    : activities.contents[0];
  if(!chosen) return null;
  return (await chosen.use({ event }, { configure }, {})) ?? null;
}

/* ---------- Multiattack ----------
 * dnd5e keeps Multiattack as text only, so it's read from the feature's description :
 *   "makes two attacks with its hand axes"                          -> Hand Axe × 2
 *   "makes three attacks: one with its bite and two with its claws" -> Bite × 1, then Claw × 2
 *   "makes two attacks, using Scimitar or Shortbow in any combination" -> 2, split between Scimitar and Shortbow
 *   "makes two melee attacks or two ranged attacks" (no weapon named) -> 2, split between all its attacks
 * Sentences about replacing an attack ("It can replace one attack with Spellcasting") are skipped.
 */

const NUMBER_WORDS = { once : 1, twice : 2, thrice : 3, one : 1, two : 2, three : 3, four : 4, five : 5, six : 6, seven : 7, eight : 8, nine : 9, ten : 10 };
const NUMBER = new RegExp(`\\b(\\d+|${Object.keys(NUMBER_WORDS).join("|")})\\b`, "i");

function numberIn(text){
  const match = String(text ?? "").match(NUMBER);
  return match ? (NUMBER_WORDS[match[1].toLowerCase()] ?? Number(match[1])) : null;
}

/* Plain text of an item's description */
function descriptionOf(item){
  const html = item?.system?.description?.value;
  if(!html) return "";
  return (new DOMParser().parseFromString(html, "text/html").body.textContent ?? "").replace(/\s+/g, " ").trim();
}

/* An item's name, singular or plural : "Hand Axe" matches "hand axes", "Claw" matches "claws" */
function nameMatcher(item){
  const name = (item?.name ?? "").replace(/\(.*?\)/g, "").trim().toLowerCase();
  if(!name) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}(?:e?s)?\\b`, "i");
}

/* The actor's items that make attacks : weapons, and features / spells with an attack activity */
function attackItems(actor){
  return (actor?.items?.contents ?? []).filter(i => i.system.activities?.getByType?.("attack")?.length);
}

/* The Multiattack feature : the item itself when given one that doesn't attack, else found by name */
function multiattackFeature(thing, feature){
  const isFeature = (thing?.documentName === "Item") && !attackItems(thing.actor).includes(thing);
  return isFeature ? thing : findItem(thing, feature);
}

/**
 * The attacks in a creature's Multiattack, in order : [{ items, count, choice }].
 * `items` has one item, or several when the attacks can be made with any of them (`choice` true).
 * @param {Actor|Token|Item} thing          the creature, or its Multiattack feature
 * @param {object} [options]
 * @param {string|string[]} [options.feature="Multiattack"]  the feature to read (see findItem)
 * @returns {{ items : Item[], count : number, choice : boolean }[]}  empty without a Multiattack or any attacks
 */
export function getMultiattackPlan(thing, { feature = "Multiattack" } = {}){
  const actor = actorOf(thing);
  const text = descriptionOf(multiattackFeature(thing, feature));
  const weapons = attackItems(actor).map(item => ({ item, named : nameMatcher(item) })).filter(w => w.named);
  if(!text || !weapons.length) return [];

  const plan = [];
  let total = null;
  for(const sentence of text.split(/(?<=\.)\s+/)){
    if(/\breplaces?\b/i.test(sentence)) continue;
    const sentenceCount = numberIn(sentence);
    if(/\battacks?\b/i.test(sentence)) total ??= sentenceCount;

    for(const clause of sentence.split(/[,:;]|\band\b/)){
      const items = weapons.filter(w => w.named.test(clause)).map(w => w.item);
      if(!items.length) continue;
      /* The clause's own number ("two with its claws"), else the sentence's ("two attacks, using Scimitar or Shortbow") */
      const count = numberIn(clause) ?? sentenceCount ?? 1;
      if(plan.some(p => (p.items.length === items.length) && p.items.every(i => items.includes(i)))) continue;
      plan.push({ items, count, choice : items.length > 1 });
    }
  }

  /* No weapon named : that many attacks, with any of them */
  if(!plan.length && total){
    const items = weapons.map(w => w.item);
    plan.push({ items, count : total, choice : items.length > 1 });
  }
  return plan;
}

/**
 * How many attacks this item gets in its owner's Multiattack (see getMultiattackPlan) :
 * Hand Axe in "two attacks with its hand axes" -> 2, Bite in "one with its bite and two with its claws" -> 1.
 * @param {Item} item
 * @param {object} [options]
 * @param {string|string[]} [options.feature="Multiattack"]
 * @param {number} [options.fallback=1]  when the Multiattack doesn't include this item, or there is none
 * @returns {number}
 */
export function getMultiattack(item, { feature = "Multiattack", fallback = 1 } = {}){
  const counts = getMultiattackPlan(item?.actor, { feature }).filter(p => p.items.includes(item)).map(p => p.count);
  return counts.length ? counts.reduce((a, b) => a + b, 0) : fallback;
}

/**
 * The whole Multiattack in one click : for each weapon in it, in order, pick targets on the map and attack
 * (pickAndAttack, one card per weapon). "Scimitar or Shortbow" asks how to split the attacks first.
 *   repeat (default true) lets a target take more than one of a weapon's attacks; it's allowed, never required.
 *   Picking fewer than a weapon's attacks is fine (Enter), Esc skips that weapon and carries on with the next.
 * @param {Actor|Token|Item} thing          the creature, or its Multiattack feature (from its item macro)
 * @param {object} [options]
 * @param {string|string[]} [options.feature="Multiattack"]
 * @param {boolean} [options.repeat=true]   the same target can be picked more than once for a weapon
 * @param {Event} [options.event]            advantage / disadvantage keys
 * @param {object} [options.attack]          more pickAndAttack options for every weapon (disposition, long, strict...)
 * @returns {Promise<object[]|null>}  each weapon's pickAndAttack result, null if there's no Multiattack or it was cancelled
 */
export async function multiattack(thing, { feature = "Multiattack", repeat = true, event, attack = {} } = {}){
  const actor = actorOf(thing);
  const plan = getMultiattackPlan(thing, { feature });
  if(!plan.length){
    ui.notifications.warn(module.format("helpers.multiattack.none", { name : actor?.name ?? "" }));
    return null;
  }

  /* Choices first, so the attacks themselves run back to back */
  const steps = [];
  for(const entry of plan){
    if(!entry.choice){ steps.push({ item : entry.items[0], count : entry.count }); continue; }
    const split = await splitAttacks(entry);
    if(!split) return null;
    steps.push(...split);
  }

  const results = [];
  for(const { item, count } of steps){
    results.push(await pickAndAttack(item, { ...attack, count, repeat, event }));
  }
  return results;
}

/* "Two attacks with Scimitar or Shortbow" : how many with each. All with the first by default. */
async function splitAttacks({ items, count }){
  const esc = Handlebars.escapeExpression;
  const rows = items.map((item, i) => `
    <div class="form-group">
      <label>${esc(item.name)}</label>
      <div class="form-fields">
        <input type="number" name="${item.id}" value="${i ? 0 : count}" min="0" max="${count}" step="1">
      </div>
    </div>`).join("");

  const values = await foundry.applications.api.DialogV2.prompt({
    window : { title : module.i18n("helpers.multiattack.title"), icon : "fa-solid fa-swords" },
    content : `<p class="hint">${esc(module.format("helpers.multiattack.hint", { count }))}</p>${rows}`,
    ok : {
      label : "helpers.multiattack.confirm", icon : "fa-solid fa-check",
      callback : (_event, button) => items.map(item => Number(button.form.elements[item.id]?.value) || 0),
    },
    rejectClose : false,
  });
  if(!values) return null;

  /* Never more than the Multiattack allows : later weapons lose the extra */
  let left = count;
  const split = items.map((item, i) => {
    const n = Math.max(0, Math.min(left, Math.floor(values[i])));
    left -= n;
    return { item, count : n };
  }).filter(s => s.count > 0);
  return split.length ? split : null;
}

/* ---------- Healing ---------- */

/**
 * How much an item heals, as a formula : its Heal activity's healing, else its Utility activity's roll formula,
 * else read from its description ("heal 11 hit points", "regains 10 (3d6) hit points").
 * @param {Item} item
 * @param {object} [options]
 * @param {boolean} [options.average=false]  description "10 (3d6)" : the fixed 10 instead of rolling 3d6
 * @returns {string|null}  e.g. "11", "3d6", "2d8 + @mod"; null if it doesn't say
 */
export function getHealing(item, { average = false } = {}){
  const activities = item?.system?.activities;
  const heal = activities?.getByType?.("heal").find(a => a.healing?.formula);
  if(heal) return heal.healing.formula;
  const utility = activities?.getByType?.("utility").find(a => a.roll?.formula);
  if(utility) return utility.roll.formula;

  const match = descriptionOf(item).match(/\b(?:heals?|regains?|restores?)\s+(\d+)\s*(?:\(([^)]+)\))?\s+hit points\b/i);
  if(!match) return null;
  return (match[2] && !average) ? match[2].replace(/\s+/g, " ").trim() : match[1];
}

/**
 * Update an item and return the fresh copy.
 * @param {Item} item
 * @param {object} changes
 * @returns {Promise<Item>}
 */
export async function updateItem(item, changes){
  await item.update(changes);
  return item.actor?.items.get(item.id) ?? item;
}

/**
 * Set an item's base (weapon) damage, only if it differs.
 * @param {Item} item
 * @param {object} damage
 * @param {number} [damage.number]        number of dice
 * @param {number} [damage.denomination]  die size (8 = d8)
 * @param {string|string[]} [damage.types]  damage type(s), e.g. "acid"
 * @param {string} [damage.bonus]
 * @returns {Promise<Item|null>}  the fresh item if something changed, null if it was already right
 */
export async function setBaseDamage(item, { number, denomination, types, bonus } = {}){
  const base = item?.system?.damage?.base;
  if(!base) return null;

  const changes = {};
  if((number !== undefined) && (base.number !== number)) changes["system.damage.base.number"] = number;
  if((denomination !== undefined) && (base.denomination !== denomination)) changes["system.damage.base.denomination"] = denomination;
  if((bonus !== undefined) && (base.bonus !== bonus)) changes["system.damage.base.bonus"] = bonus;
  if(types !== undefined){
    const wanted = [types].flat();
    const same = (base.types.size === wanted.length) && wanted.every(t => base.types.has(t));
    if(!same) changes["system.damage.base.types"] = wanted;
  }

  if(foundry.utils.isEmpty(changes)) return null;
  return updateItem(item, changes);
}
