import { module } from '../module.js';
import { logger } from '../log.js';
import { patch } from '../patch.js';
import { idOf } from '../helpers/utils.js';
import { onDamage, attackOf } from '../roll-item/damage.js';
import { effectsFrom } from '../helpers/actors.js';
const log = logger.for(import.meta.url);

/**
 * The "only when" lego : a bonus an effect gives (dnd5e applies it everywhere its key reaches) counted only when a check
 * holds. Rage's damage only on attacks with Strength, Innate Sorcery's +1 DC only on Sorcerer spells, Archery not on a
 * thrown melee weapon, Dueling only one-handed, Defense only in armor; a monster's "+2 AC while it holds a shield".
 *
 *   bonusOnlyWhen("rage", "system.bonuses.mwak.damage", attack => attack.ability === "str");
 *   bonusOnlyWhen(["archery", "fighting-style-archery"], "system.bonuses.rwak.attack", attack => !attack.meleeWeapon, { value : "2" });
 *
 * match : the item (identifier, or several) whose effects give it, on the creature or switched on on the item; or a
 *         check (effect) => boolean.
 * key   : the change's key (or several). What `test` gets, and how the bonus is kept off, follow the key :
 *   system.bonuses.{mwak|rwak|msak|rsak}.damage / .attack : test(attack), attack as the damage lego reads it (attackOf :
 *     actor, item, weapon, melee, ranged, meleeWeapon, thrown, twoHanded, ability...). dnd5e gives the bonus to that
 *     action type : taken out of a roll that fails the test, added to one of another type that passes it (Rage's
 *     Strength thrown weapon).
 *   system.bonuses.spell.dc : test(activity), a save activity's DC lowered again when it fails.
 *   anything else (an AC bonus) : test(actor), the item's own effect switched off while it fails (checked as items change).
 * options :
 *   value     the bonus when no effect gives it (the compendium's feat with no effect) : added where the test passes
 *   enabled() the rule's setting (default : on)
 *   id        a macro's rule : added again with the same id, it replaces the old one (default : match and key)
 */
const rules = [];
let hooked = false;

export function bonusOnlyWhen(match, key, test, { value = null, enabled = null, id = null } = {}){
  const keys = [key].flat().filter(Boolean);
  const rule = { id : id ?? `${[match].flat().join(",")}|${keys.join(",")}`, match, keys, test, value, enabled };
  const old = rules.findIndex(r => r.id === rule.id);
  if(old >= 0) rules[old] = rule;
  else rules.push(rule);
  hook();
}

const ACTION = /\.(mwak|rwak|msak|rsak)\./;
const kindOf = key => ACTION.test(key) ? (/attack$/.test(key) ? "attack" : "damage") : (/\.spell\.dc$/.test(key) ? "dc" : "toggle");
const on = rule => !rule.enabled || rule.enabled();

function hook(){
  if(hooked) return;
  hooked = true;
  onDamage((attack, damage) => {
    for(const rule of rules){
      if(!on(rule) || !attack.isAttack) continue;
      for(const key of rule.keys.filter(k => kindOf(k) === "damage")){
        const change = settle(rule, key, attack.actor, attack);
        if(change?.add) damage.add(change.add);
        if(change?.remove) damage.remove(change.remove);
      }
    }
  });
  Hooks.on("dnd5e.preRollAttackV2", config => {
    const roll = config?.rolls?.[0];
    if(!roll) return;
    const attack = attackOf(config);
    for(const rule of rules){
      if(!on(rule) || !attack.isAttack) continue;
      for(const key of rule.keys.filter(k => kindOf(k) === "attack")){
        const change = settle(rule, key, attack.actor, attack);
        const part = change?.add ?? (change?.remove ? `-(${change.remove})` : null);
        if(part) roll.parts = [...(roll.parts ?? []), part];
      }
    }
  });
  patch.wrap("CONFIG.DND5E.activityTypes.save.documentClass.prototype.prepareFinalData", function(wrapped, ...args){
    const result = wrapped(...args);
    try { lowerDC(this); } catch(error){ log.debug("Only-when DC", error); }
    return result;
  });
  for(const hook of ["createItem", "updateItem", "deleteItem"]){
    Hooks.on(hook, (item, ...rest) => toggle(item?.parent, rest.at(-1)));
  }
}

/* The bonus those effects give with this key, as written ("2", "@scale.barbarian.rage-damage"); "" for none */
function bonusOf(rule, key, actor){
  return effectsFrom(actor, rule.match).flatMap(e => [...(e.system?.changes ?? e.changes ?? [])])
    .filter(c => c.key === key).map(c => String(c.value ?? "").replace(/^\s*\+\s*/, "").trim()).filter(Boolean).join(" + ");
}

/* Does the creature have the rule's item at all (for `value`, the bonus with no effect) */
function hasItem(rule, actor){
  if(typeof rule.match === "function") return false;
  const ids = [rule.match].flat();
  return !!actor?.items?.some?.(i => ids.includes(idOf(i)));
}

/* An attack's damage or attack bonus : { add } or { remove } to put it where the test wants it */
function settle(rule, key, actor, attack){
  const action = key.match(ACTION)?.[1];
  const given = bonusOf(rule, key, actor);
  const wanted = !!rule.test(attack);
  const dnd5eGives = !!given && (attack.action === action);
  if(dnd5eGives && !wanted) return { remove : given };
  if(!dnd5eGives && wanted){
    if(given) return { add : given };
    if(rule.value && hasItem(rule, actor) && !effectsFrom(actor, rule.match).length) return { add : String(rule.value) };
  }
  return null;
}

/* A spell's save DC with the bonus taken off again where the test fails */
function lowerDC(activity){
  if((activity?.item?.type !== "spell") || !Number.isFinite(activity.save?.dc?.value)) return;
  let lower = 0;
  for(const rule of rules){
    if(!on(rule)) continue;
    for(const key of rule.keys.filter(k => kindOf(k) === "dc")){
      const bonus = Number(bonusOf(rule, key, activity.actor)) || 0;
      if(bonus && !rule.test(activity)) lower += bonus;
    }
  }
  if(!lower) return;
  activity.save.dc.value -= lower;
  if(activity.labels?.save) activity.labels.save = game.i18n.format("DND5E.SaveDC", { dc : activity.save.dc.value, ability : CONFIG.DND5E.abilities[activity.ability]?.label ?? "" });
}

/* Anything else : the rule's item's own effects with that key, switched off while the test fails (by this user) */
async function toggle(actor, userId){
  if((actor?.documentName !== "Actor") || !actor.isOwner || (userId && (userId !== game.user.id))) return;
  for(const rule of rules){
    if(!on(rule) || (typeof rule.match === "function")) continue;
    const keys = rule.keys.filter(k => kindOf(k) === "toggle");
    if(!keys.length) continue;
    const ids = [rule.match].flat();
    const disabled = !rule.test(actor);
    for(const item of actor.items.filter(i => ids.includes(idOf(i)))){
      const updates = item.effects.filter(e => e.transfer && (e.disabled !== disabled)
        && [...(e.system?.changes ?? e.changes ?? [])].some(c => keys.includes(c.key))).map(e => ({ _id : e.id, disabled }));
      if(updates.length) await item.updateEmbeddedDocuments("ActiveEffect", updates);
    }
  }
}
