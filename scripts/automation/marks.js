import { module } from '../module.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { uses } from '../uses.js';
import { casting, payCasting } from './casting.js';
import { idOf, whisperOwners } from '../helpers/utils.js';
import { tokenOf } from '../helpers/tokens.js';
import { pickTargets } from '../helpers/targets.js';
import { postTargetCard, registerTargetCards } from '../helpers/target-card.js';
import { eachAttack } from '../roll-item/extra-damage.js';
import { TYPES } from '../roll-item/message.js';
const log = logger.for(import.meta.url);

/**
 * The mark lego : a spell that marks one creature and hurts it more on every attack (Hunter's Mark, Hex), said once.
 *
 *   markSpell({
 *     id : "huntersMark",              the mark's flag on the creature's effect, its extra damage's key, its GM action
 *     spell : "hunters-mark",          the spell's identifier; name : "Hunter's Mark", for a creature without it
 *     items : ["favored-enemy"],       other items whose use casts it (Favored Enemy)
 *     enabled : () => true,
 *     range : 90,
 *     free : { left : actor => 2, spend : actor => {}, label : left => "..." }    free castings, offered before the slots
 *     hours : level => 1,              how long it lasts, by the slot level
 *     ask : async (actor, spell) => ({ ability }),   more to choose when cast (Hex's ability), kept in the mark's data;
 *                                      null : cancelled
 *     effect : (data, spell, caster) => ({ name, img, changes }),   the mark's effect on the creature
 *     damage : (attacker) => ({ formula : "1d6", type : "force", label }),   onto every attack card at it (Apply on a hit,
 *                                      doubled on a crit)
 *     text : actor-facing i18n keys : { marked, moved, mark, moveHere, done } ({ name, target, spell } and the data)
 *     icon : "fa-crosshairs",
 *   })
 *
 * Casting (from the spell, or one of the items) : how to pay (a free casting, or a spell slot : one a turn, its
 * components), the creature (within range, an enemy), Concentration begun at once, then the spell's card with a row for
 * the creature : its button (the GM, or the creature's owner) puts the mark on, taking the caster's old one off. It ends
 * with that Concentration. The marked creature at 0 HP : its caster's owners are told, and casting it again moves the
 * mark to another creature (no slot, no use).
 */
const rules = [];
let hooked = false;

export function markSpell(rule){
  if(!rule?.id || rules.some(r => r.id === rule.id)) return;
  rules.push(rule);
  uses.onItem(rule.id, (item, ctx, next) => {
    if(!on(rule) || !item?.actor || !casts(rule, item)) return next();
    return cast(rule, item.actor);
  });
  gm.handle(rule.id, (data, user) => applyMark(rule, data, user));
  registerTargetCards();
  if(hooked) return;
  hooked = true;
  /* The damage : on the attack card, when it's made (the attacker's client) */
  Hooks.on("createChatMessage", (message, options, userId) => { if(userId === game.user.id) onAttackCard(message); });
  /* Concentration on the spell ends : so does the mark (the active GM) */
  Hooks.on("deleteActiveEffect", effect => onConcentrationEnd(effect));
  /* The marked creature down : its caster is told */
  Hooks.on("updateActor", (actor, changes) => onDown(actor, changes));
}

function on(rule){
  return (game.system.id === "dnd5e") && (!rule.enabled || rule.enabled());
}

/* The spell itself, or one of the items that cast it */
function casts(rule, item){
  const id = idOf(item);
  return ((id === rule.spell) && (item.type === "spell")) || (rule.items ?? []).includes(id);
}

export function spellOf(rule, actor){
  return actor?.items?.find?.(i => (i.type === "spell") && (idOf(i) === rule.spell)) ?? null;
}

/**
 * The mark a caster has out now.
 * @param {string} id       the rule's id ("huntersMark", "hex")
 * @param {Actor} caster
 * @returns {{ effect : ActiveEffect, token : Token }|null}
 */
export function markOf(id, caster){
  for(const token of canvas.tokens?.placeables ?? []){
    const effect = token.actor?.effects?.find?.(e => e.getFlag(module.id, id)?.caster === caster?.uuid);
    if(effect) return { effect, token };
  }
  return null;
}

/* That attacker's mark on this token */
export function markedBy(id, token, attacker){
  return token?.actor?.effects?.find?.(e => e.getFlag(module.id, id)?.caster === attacker?.uuid) ?? null;
}

/* The ways to cast it now : its free castings, then each slot level left (the payCasting lego) */
function freeOf(rule){
  return rule.free ? { left : rule.free.left, spend : rule.free.spend, label : left => rule.free.label(left) } : null;
}

/* Cast it : move a mark whose creature is down, else pay and mark */
async function cast(rule, actor){
  const spell = spellOf(rule, actor);
  if(!spell){
    ui.notifications.warn(module.format("marks.noSpell", { name : actor.name, spell : rule.name ?? rule.spell }));
    return null;
  }
  const current = markOf(rule.id, actor);
  const down = current && ((Number(current.token.actor.system?.attributes?.hp?.value) || 0) <= 0);
  if(current && down && casting.concentrationOn(actor, spell)){
    return place(rule, actor, spell, { move : current, data : { ...(current.effect.getFlag(module.id, rule.id) ?? {}) } });
  }
  /* How to pay (its components, and one slot a turn : Casting), paid once the creature is picked */
  const pay = await payCasting(actor, spell, { free : freeOf(rule), minLevel : 1, spend : false, icon : `fa-solid ${rule.icon ?? "fa-crosshairs"}` });
  if(!pay) return null;
  const extra = rule.ask ? await rule.ask(actor, spell) : {};
  if(!extra) return null;
  return place(rule, actor, spell, { pay, data : extra });
}

/* Pick the creature, pay, concentrate, and have the GM mark it */
async function place(rule, actor, spell, { pay = null, move = null, data = {} } = {}){
  const [target] = await pickTargets(tokenOf(actor) ?? spell, { count : 1, range : rule.range ?? 90, disposition : "enemy", useTargets : false, confirm : "auto",
    filter : t => !move || (t.id !== move.token.id) });
  if(!target) return null;
  const level = pay?.level ?? 1;
  if(pay){
    await pay.pay();
    await casting.concentrate(actor, spell, (rule.hours?.(level) ?? 1) * 3600);
  }
  const words = { name : actor.name, target : target.name, spell : spell.name, ...(rule.words?.(data) ?? {}) };
  /* The mark itself is on another creature : the spell's card, a row for it (the GM, or its owner) */
  await postTargetCard({ actor, item : spell, text : module.format(move ? rule.text.moved : rule.text.marked, words),
    rows : [{ token : target.document.uuid, action : rule.id,
      data : { ...data, caster : actor.uuid, spell : spell.uuid, target : target.document.uuid, from : move?.effect.uuid ?? null, hours : rule.hours?.(level) ?? 1 },
      label : module.i18n(move ? rule.text.moveHere : rule.text.mark), done : module.i18n(rule.text.done) }] });
  log.debug(rule.id, actor.name, target.name, move ? "moved" : pay?.value);
  return true;
}

/* GM : the mark on the creature (moved : off the old one first; a new casting : any other of the caster's goes) */
async function applyMark(rule, { caster : casterUuid, spell : spellUuid, target : targetUuid, from = null, hours = 1, ...data } = {}, user){
  const caster = fromUuidSync(casterUuid ?? "", { strict : false });
  const target = fromUuidSync(targetUuid ?? "", { strict : false });
  const spell = fromUuidSync(spellUuid ?? "", { strict : false });
  /* The caster's owner or the marked creature's (its row's button), or the GM */
  if(!game.user.isGM || !caster || !target?.actor || (user && !caster.testUserPermission(user, "OWNER") && !target.actor.testUserPermission(user, "OWNER"))) return false;
  /* Concentration gone before the GM got to it : nothing to mark */
  if(!casting.concentrationOn(caster, spell)){
    ui.notifications.warn(module.format("marks.noConcentration", { name : caster.name, spell : spell?.name ?? "" }));
    return false;
  }
  if(from){
    const old = fromUuidSync(from, { strict : false });
    if(old?.getFlag?.(module.id, rule.id)?.caster === caster.uuid) await old.delete();
  }
  else for(const t of canvas.tokens?.placeables ?? []){
    for(const e of t.actor?.effects?.filter?.(x => x.getFlag(module.id, rule.id)?.caster === caster.uuid) ?? []) await e.delete();
  }
  const mark = { ...data, caster : caster.uuid, spell : spellUuid };
  const own = rule.effect?.(mark, spell, caster) ?? {};
  await target.actor.createEmbeddedDocuments("ActiveEffect", [{
    name : spell?.name ?? rule.id, img : spell?.img ?? "icons/svg/target.svg", ...own,
    origin : spellUuid, duration : { value : hours * 3600, units : "seconds" }, start : { time : game.time.worldTime },
    showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2,
    flags : { [module.id] : { [rule.id] : mark } },
  }]);
  return true;
}

/* A new attack card : each rule's damage on every attack at the attacker's marked creature, hit or miss (no die would
   tell a miss); its Apply only on a hit */
async function onAttackCard(message){
  if(message.type !== TYPES.attack) return;
  const attacker = message.getAssociatedActor?.();
  if(!attacker) return;
  for(const rule of rules){
    if(!on(rule) || !markOf(rule.id, attacker)) continue;
    const damage = rule.damage(attacker);
    await eachAttack(message, async (card, ray, tokens) => {
      if(!tokens.some(t => markedBy(rule.id, t, attacker))) return;
      await card.system.extraDamage(damage.formula, { key : rule.id, type : damage.type, magical : true, ray, label : damage.label });
    });
  }
}

/* Concentration on the spell ended : the caster's mark goes (active GM) */
async function onConcentrationEnd(effect){
  if(!game.users.activeGM?.isSelf || !effect?.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING)) return;
  const item = fromUuidSync(effect.getFlag("dnd5e", "item")?.uuid ?? "", { strict : false });
  const caster = effect.parent;
  const rule = rules.find(r => r.spell === idOf(item));
  if(!rule || (caster?.documentName !== "Actor")) return;
  const mark = markOf(rule.id, caster);
  /* dnd5e ends the effects it counts as the Concentration's own (its dependents) itself */
  const dependents = (typeof effect.getDependents === "function") ? effect.getDependents() : [];
  if(!mark || mark.effect.isDeleted || dependents.some(d => d?.uuid === mark.effect.uuid)) return;
  await mark.effect.delete().catch(error => log.debug("Already gone", error));
}

/* The marked creature at 0 HP : its caster's owners are told the mark can move (active GM) */
async function onDown(actor, changes){
  if(!game.users.activeGM?.isSelf || !foundry.utils.hasProperty(changes ?? {}, "system.attributes.hp.value")) return;
  if((Number(actor.system?.attributes?.hp?.value) || 0) > 0) return;
  for(const rule of rules){
    const mark = actor.effects?.find?.(e => e.getFlag(module.id, rule.id));
    const caster = mark && fromUuidSync(mark.getFlag(module.id, rule.id).caster, { strict : false });
    if(!caster) continue;
    await whisperOwners(caster, module.format("marks.down", { target : actor.name, spell : spellOf(rule, caster)?.name ?? rule.spell }));
  }
}
