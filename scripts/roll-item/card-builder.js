import { module } from '../module.js';
import { gm } from '../gm.js';
import { uses } from '../uses.js';
import { logger } from '../log.js';
import { cells, gridSteps, tokenOf, forcedMove, forcedMoveAsGM, pushAway, distanceBetween, movedThisTurn } from '../helpers/tokens.js';
import { pickSpace, isEnemy } from '../helpers/targets.js';
import { postTargetCard, registerTargetCards, targetActions } from '../helpers/target-card.js';
import { rollOptions, rollOptionDamage, rollOptionD20, rollOptionDamageDice } from './roll-options.js';
import { disease } from '../automation/disease.js';
import { patch } from '../patch.js';
import { setDamage } from '../helpers/items.js';
import { rollSave, rollSaveAsGM, setStatus, giveEffectAsGM } from '../helpers/actors.js';
import { damageRoll } from './extra-damage.js';
import { onDamage } from './damage.js';
import { noteReason } from './reasons.js';
const log = logger.for(import.meta.url);

/**
 * Card builder : a macro adds to (or takes from) the card a use makes, and the card shows it like its own parts.
 *
 *   const card = await item.roll();              the item's normal use (targets, attack, damage...), its card returned
 *   card.remove("prone");                        an item's own effect taken off the card (by condition or name)
 *   card.append(applyCondition({ type : "prone", when : ["hit", pounce] }));
 *   card.append(followUp("Bite", { when : ["hit", pounce] }));
 *
 * Parts are kept on the card (flags.macro-helper.cardParts) and shown in each target's row, in the order appended.
 * `when` : "hit" / "miss" are judged live (Shield, cover, a reroll change them), "fail" / "save" once its save is rolled, a function (target) => boolean is a
 * fact judged once per target when appended (its size, how it was charged), true / false as given. Changes made
 * together reach the card in one update (no flicker).
 *
 *   applyCondition({ when, type, with, duration, save, escape, repeat, insteadOfDamage, self })
 *     an Apply button (the target's owner or the GM) : one effect with the condition's own icon and name, from the
 *     item. with : more conditions in that same effect, ending with it (a grapple's Blinded, Restrained); its name
 *     then says where it's from ("Grappled: Animated Rug"). save : { ability, dc, repeat : "end" | "start" } a save at
 *     each of its turns ends it. escape : a grapple's escape DC (the Escape button uses it). repeat : { at, damage,
 *     type } damage at the start / end of each of its turns. insteadOfDamage : this or the hit's damage for that
 *     target, not both. self : a linked effect on the creature that did it ("Smothering: Ranger"); either ending ends
 *     the other. Already under that condition : the harsher one stays (the longer, then no save, then the higher DC).
 *     noReactions / oneAction : as applyEffect's (Dretch's Fetid Cloud). duration "endOfMyNextTurn" : the end of the
 *     next turn of the one that did it (dnd5e's sourceEnd).
 *     save.fail : { type, duration, endsOn } a failed repeat save turns it into that condition instead (no more saves),
 *     lasting that long; endsOn : "damage" (it takes damage) and / or "wake" (a creature within 5 ft uses its Action :
 *     a Wake button on that creature's action bar). Sleep Breath.
 *   applyEffect({ when, name, img, duration, speed, noReactions, oneAction, changes })   an Apply button for an effect
 *                              that isn't a condition (Slowing Breath) : speed multiplies its Speeds (0.5 : halved),
 *                              noReactions (no Reactions : Rule Limits), oneAction (an Action or a Bonus Action, not
 *                              both : using one spends both), changes (Foundry's own). duration : "endOfNextTurn" (the
 *                              end of its next turn), "startOfNextTurn", rounds (a number) or Foundry's duration data.
 *   attach({ when, escape, check, with })   a fancy grapple (Darkmantle) : "Attached: <it>" on the target (with its
 *                              conditions), "Attached: <target>" on the one that attached (Speed 0, it moves with the
 *                              target). The target's Detach (its Action, a `check` : "ath" by default, against escape)
 *                              or the attacher's Detach (5 ft of its movement) ends both.
 *   applyDisease({ when, name, ability, dc, every, stages, removal })   a disease (Death Dog's Bite) : one effect that
 *                              cascades, its save asked again as game time passes (disease.js).
 *     until : web({ name, ac, hp, vulnerable, immune, resist }) : it lasts until that object is destroyed : a token on
 *     the target's space with that AC and HP (Ettercap's Web Strand); 0 HP, the token goes and the condition ends.
 *     aura : { radius, type } : every other creature within radius of it has that condition while there (Flumph's
 *     Stench Spray). removal : ["rest"] : a Long Rest ends it. duration { hours : "1d4" } : rolled when applied.
 *     randomMove : on its turn, a Random move button on its action bar (Euphoria Breath).
 *     expire : { status } : what happens if it runs its full time (not ended sooner) : that status (Gas Spore : dead).
 *     repeat : { at, damage, type, of : "source" } : the damage at the start / end of the turns of the one that did it.
 *   engulf({ when, escape, damage, type })   inside it (Gelatinous Cube) : "Engulfed: <it>" (Restrained), the target
 *                              moved into its space and moving with it, its damage at the start of its turns; Escape
 *                              (Athletics against escape) or a creature beside it pulling it out leaves it beside.
 *   immunity({ when, duration })   immune to this item of this creature that long (Ghast's Stench) : target.isImmuneTo(item).
 *   push(feet, { when, from })   a Push button at the bottom of the card (the GM, card moves) : the target pushed that far straight away from `from` (the
 *                              card's creature), stopping at walls and creatures.
 *   choice : "name"   (applyCondition, applyEffect, push, followUp) parts sharing a choice are one or the other : once
 *                              one is used on a target, the others are gone from its row (Spiked Shield : Prone or Push).
 *   followUp(item, { when })   a button for the card's owner : that item's attack at the target, part of this use
 *                              (no Action of its own for the Action Tracker).
 *   extraDamage(formula, { type, when })   more damage on the hit, in the hit's own damage line (by type), rolled
 *                              when appended if a target's facts hold (doubled on a critical hit).
 *
 *   item.roll({ uses : "Fire Breath" })   that item's use is spent for this one (checked before : none left, no use).
 *   item.roll({ activity, advantage, disadvantage, targets, cost, attackBonus, critical, ignoreCover, damageType,
 *               range, reach, d20, damageDice })   see roll-options.js : what to change before the roll.
 */
const KEY = "cardParts";
const uuidKey = uuid => String(uuid).replaceAll(".", "-");

/* ---------- Parts ---------- */

export function applyCondition({ type, when = [], with : also = [], duration = null, save = null, escape = null, repeat = null,
  insteadOfDamage = false, self = null, label = null, noReactions = false, oneAction = false, until = null, aura = null,
  removal = [], randomMove = false, expire = null, choice = null } = {}){
  return { kind : "condition", type, when : [when].flat(), with : [also].flat().filter(Boolean), duration, save, escape, repeat,
    insteadOfDamage : !!insteadOfDamage, self, label, noReactions : !!noReactions, oneAction : !!oneAction, until, aura,
    removal : [removal].flat().filter(Boolean), randomMove : !!randomMove, expire, choice };
}

export function engulf({ when = [], escape = null, damage = null, type = null, label = null } = {}){
  return { kind : "engulf", when : [when].flat(), escape, damage, type, label };
}

export function immunity({ when = [], duration = "24h", label = null } = {}){
  return { kind : "immunity", when : [when].flat(), duration, label };
}

/* A creature of that type ("undead", "beast"...) : dnd5e's creature type (characters : their species' type) */
export function isType(thing, type){
  const actor = thing?.actor ?? thing;
  const value = actor?.system?.details?.type?.value ?? (actor?.type === "character" ? "humanoid" : null);
  return !!value && [type].flat().some(t => String(t).toLowerCase() === String(value).toLowerCase());
}

/* Immune to this item of this creature (Ghast's Stench : an immunity part on a success) */
export function isImmuneTo(thing, item){
  const actor = thing?.actor ?? thing;
  return !!item && !!actor?.effects?.some?.(e => !e.disabled && (e.getFlag(module.id, "immuneTo") === item.uuid));
}

/* An object a condition lasts as long as (Ettercap's Web Strand) : a token with its own AC and Hit Points */
export function web({ name = null, ac = 10, hp = 5, vulnerable = [], immune = [], resist = [], img = "icons/svg/net.svg" } = {}){
  return { kind : "object", name, ac, hp, vulnerable : [vulnerable].flat(), immune : [immune].flat(), resist : [resist].flat(), img };
}

/* The creatures (tokens) under an effect that came from this item (Ettercap's Reel : those its Web Strand holds) */
export function affectedBy(item){
  const uuid = item?.uuid;
  if(!uuid) return [];
  return canvas.tokens.placeables.filter(t => t.actor?.effects?.some?.(e => !e.disabled && (e.origin === uuid)));
}

/* Pull a creature up to `feet` straight toward this one (Ettercap's Reel), stopping at walls and creatures */
export async function pull(thing, target, feet = 5){
  const from = tokenOf(thing), to = tokenOf(target);
  if(!from || !to) return 0;
  return forcedMove(to, { direction : "toward", from, feet });
}

export function applyDisease({ when = [], name = null, img = null, ability = "con", dc = null, every = "24h", stages = [], removal = ["save"], cure = "full", label = null } = {}){
  return { kind : "disease", when : [when].flat(), name, img, ability, dc, every, stages : [stages].flat().filter(Boolean), removal : [removal].flat(), cure, label };
}

/* In an "It moves through a creature's space" item-hook macro : it may (dnd5e would block it : Orc Bloodrunner's
   Unimpeded through a Prone creature) */
export function passThrough(args){
  const result = args?.[2];
  if(result && (typeof result === "object")) result.through = true;
  return true;
}

/* In a "Before an Opportunity Attack" item-hook macro : this move provokes none (Deer's Agile) */
export function suppressOA(args){
  const info = args?.[1];
  if(info && (typeof info === "object")) info.skip = true;
  return true;
}

export function applyEffect({ when = [], name = null, img = null, duration = null, speed = null, noReactions = false,
  oneAction = false, changes = [], label = null, choice = null } = {}){
  return { kind : "effect", when : [when].flat(), name, img, duration, speed, noReactions : !!noReactions, oneAction : !!oneAction,
    changes : [changes].flat().filter(Boolean), label, choice };
}

export function attach({ when = [], escape = null, check = "ath", with : also = [], label = null } = {}){
  return { kind : "attach", when : [when].flat(), escape, check, with : [also].flat().filter(Boolean), label };
}

export function push(feet, { when = [], from = null, label = null, choice = null } = {}){
  const by = from ? ((from.document ?? from)?.uuid ?? null) : null;
  return { kind : "push", feet : Number(feet) || 0, from : by, when : [when].flat(), label, choice };
}

export function followUp(item, { when = [], label = null, choice = null } = {}){
  const name = (typeof item === "string") ? item : (item?.name ?? "");
  return { kind : "followUp", item : name, when : [when].flat(), label, choice };
}

export function extraDamage(formula, { type = null, when = [], label = null } = {}){
  return { kind : "damage", formula : String(formula), type, when : [when].flat(), label };
}

/**
 * Teleport : pick an unoccupied space within `feet` it can see, use the item (when given : its card, its cost), then
 * move there by teleport (same elevation, no movement spent, no Opportunity Attacks). Blinded : it can't.
 *   await token.teleport(40, { item })      Blink Dog's Teleport
 * @returns {Promise<object|null>}  the item's card (or the space, without an item); null if cancelled or refused
 */
export async function teleport(thing, feet, { item = null } = {}){
  const from = tokenOf(thing);
  if(!from) return null;
  if(!from.document.isOwner){ ui.notifications.warn(module.format("cardBuilder.teleportOwner", { name : from.name })); return null; }
  if(from.actor?.statuses?.has?.("blinded")){ ui.notifications.warn(module.format("cardBuilder.teleportBlinded", { name : from.name })); return null; }
  const size = Math.max(1, Math.round(from.document.width ?? 1));
  const space = await pickSpace(from, { range : feet, size, seen : true, notice : item?.name ?? "",
    banner : module.format("cardBuilder.teleportBanner", { feet }) });
  if(!space) return null;
  const card = item ? await cardBuilder.roll(item) : null;
  if(item && !card) return null;
  await from.document.move({ x : space.x, y : space.y, action : "blink" });
  return card ?? space;
}

/**
 * Leap : pick an unoccupied space within `feet` (not through a wall that blocks movement), use the item (when given),
 * then jump there, at the same elevation. Leaving a creature's reach provokes an Opportunity Attack (as a drag does).
 * The leap's distance isn't counted as movement : the macro says what it costs (token.useMovement(-10)).
 *   if(!await token.leap(30, { item })) return;
 *   await token.useMovement(-10);
 * @returns {Promise<object|null>}  the item's card (or the space, without an item); null if cancelled
 */
export async function leap(thing, feet, { item = null } = {}){
  const from = tokenOf(thing);
  if(!from) return null;
  if(!from.document.isOwner){ ui.notifications.warn(module.format("cardBuilder.teleportOwner", { name : from.name })); return null; }
  const size = Math.max(1, Math.round(from.document.width ?? 1));
  const space = await pickSpace(from, { range : feet, size, notice : item?.name ?? "", banner : module.format("cardBuilder.leapBanner", { feet }) });
  if(!space) return null;
  const card = item ? await cardBuilder.roll(item) : null;
  if(item && !card) return null;
  const { actionTracker } = await import('../automation/action-tracker.js');
  actionTracker.markLeap(from.id, space);
  /* Its own movement : Opportunity Attacks as for a drag (a teleport or a push doesn't provoke) */
  await from.document.move({ x : space.x, y : space.y, action : "jump" }, { [module.id] : { oaCheck : true } });
  return card ?? space;
}

/* Movement spent (negative feet) or given back (positive) this turn : token.useMovement(-10) */
export async function useMovement(thing, feet){
  const { actionTracker } = await import('../automation/action-tracker.js');
  return actionTracker.useMovement(tokenOf(thing) ?? thing, feet);
}

/**
 * A Reaction a macro takes (an Ochre Jelly's Split) : false if it has none left (already spent this round, or it can't
 * take Reactions), otherwise spent and logged. Out of combat, or with the Action Tracker off : true.
 *   if(!await token.useReaction("Split")) return;
 * @returns {Promise<boolean>}
 */
/**
 * Has it its Reaction now ? (no Action Tracker, or out of combat : true; it can't take Reactions : false). Right away,
 * for a hook macro that has to decide before its first await (Juke's Advantage on the save it's about to roll).
 *   if(!token.hasReaction()) return;
 * @returns {boolean}
 */
export function hasReaction(thing){
  return Hooks.call(`${module.id}.hasReaction`, thing?.actor ?? thing) !== false;
}

export async function useReaction(thing, what = ""){
  const { actionTracker } = await import('../automation/action-tracker.js');
  return actionTracker.useReaction(thing?.actor ?? thing, what);
}

/**
 * A creature's Reaction spent moving, on anyone's turn (Mantle of Inspiration, Maneuvering Attack) : its Reaction is
 * used, then its owner moves the token, up to `feet` (its walking Speed), until the end of the current turn. With
 * noOA : true it provokes no Opportunity Attacks; a list of tokens : none from those (the creature you hit). Moving
 * on someone else's turn needs no GM approval for it. False when it has no Reaction left.
 *   if(await token.reactionMove({ feet : 15, noOA : [target] })) ...
 * @param {Token|TokenDocument|Actor} thing
 * @param {object} [options]
 * @param {number} [options.feet]               default its walking Speed (half : Math.floor(speed / 2))
 * @param {boolean|Array} [options.noOA=true]   true, false, or the tokens (or uuids) that can't make one
 * @param {string} [options.name]               what it's for (the effect's name, the turn log)
 * @returns {Promise<boolean>}
 */
export async function reactionMove(thing, { feet = null, noOA = true, name = null } = {}){
  const actor = thing?.actor ?? thing;
  if(!actor?.isOwner) return false;
  if(!hasReaction(actor) || !await useReaction(actor, name ?? "")){
    ui.notifications.warn(module.format("cardBuilder.noReaction", { name : actor.name }));
    return false;
  }
  const speed = Number(actor.system?.attributes?.movement?.walk) || 30;
  const distance = Math.max(0, Number(feet ?? speed) || 0);
  const from = (noOA === true) ? true : (noOA === false) ? [] : [noOA].flat().map(t => (t?.document ?? t)?.uuid ?? t).filter(s => typeof s === "string");
  const label = module.format("cardBuilder.reactionMove", { name : name ?? module.i18n("cardBuilder.reaction"), feet : distance });
  const current = game.combat?.started ? game.combat.combatant?.actor : null;
  const { addTimedEffect } = await import('../helpers/actors.js');
  await addTimedEffect(actor, { name : label, img : "icons/skills/movement/feet-winged-boots-brown.webp",
    flags : { [module.id] : { reactionMove : { feet : distance, noOA : from, moved : 0 } } } }, { of : current ?? actor, until : "turnEnd", thisTurn : !!current });
  ui.notifications.info(label);
  return true;
}

/**
 * A card offering creatures their Reaction : a row each, its button for its player (the GM when they're away).
 * reactionMoveRows : Move (reactionMove : up to its Speed, or half with half : true; noOA true or tokens / uuids).
 * reactionAttackRows : Attack (reactionAttack : a weapon of its choice, extraDamage { formula, label } on a hit).
 */
export function reactionMoveRows(actor, item, tokens, { half = false, noOA = true, text = "" } = {}){
  const spared = (noOA === true) ? true : [noOA].flat().map(t => (t?.document ?? t)?.uuid ?? t).filter(s => typeof s === "string");
  return postTargetCard({ actor, item, text, rows : tokens.map(t => ({ token : (t.document ?? t).uuid, self : true, action : "reactionMove",
    icon : "fa-solid fa-person-running", label : module.i18n("cardBuilder.moveButton"), done : module.i18n("cardBuilder.moved"),
    data : { half, noOA : spared, name : item?.name ?? "" } })) });
}

export function reactionAttackRows(actor, item, tokens, { extraDamage = null, text = "" } = {}){
  return postTargetCard({ actor, item, text, rows : tokens.map(t => ({ token : (t.document ?? t).uuid, self : true, action : "reactionAttack",
    icon : "fa-solid fa-hand-fist", label : module.i18n("cardBuilder.attackButton"), done : module.i18n("cardBuilder.attacked"),
    data : { extraDamage, name : item?.name ?? "" } })) });
}

targetActions.set("reactionMove", (data, token) => {
  const speed = Number(token?.actor?.system?.attributes?.movement?.walk) || 30;
  return reactionMove(token, { feet : data.half ? Math.floor(speed / 2 / 5) * 5 : speed, noOA : data.noOA, name : data.name });
});
targetActions.set("reactionAttack", async (data, token) => !!(await reactionAttack(token, { extraDamage : data.extraDamage, name : data.name })));

/* Its Reaction move now, if any : { feet, noOA (true or uuids), moved, effect } */
export function reactionMoveOf(thing){
  const actor = thing?.actor ?? thing;
  const effect = actor?.effects?.find?.(e => !e.disabled && e.getFlag(module.id, "reactionMove"));
  return effect ? { ...effect.getFlag(module.id, "reactionMove"), effect } : null;
}

/**
 * A creature's Reaction spent on one weapon attack, on anyone's turn (Commander's Strike, Riposte) : it chooses the
 * weapon (melee only with melee : true), its Reaction is used, and the attack is made with no use (item.roll({ use :
 * false })) : at `targets`, else picked on the map. extraDamage : a formula added to its damage on a hit. Returns the
 * card, or null (no weapon, no Reaction, cancelled).
 *   await ally.reactionAttack({ extraDamage : { formula : "1d8", label : "Commander's Strike" } });
 */
export async function reactionAttack(thing, { targets = null, melee = false, extraDamage = null, name = null, before = null } = {}){
  const actor = thing?.actor ?? thing;
  if(!actor?.isOwner) return null;
  const weapons = actor.items.filter(i => (i.type === "weapon") && (i.system.equipped || (i.system.identifier === "unarmed-strike") || /^unarmed strike$/i.test(i.name))
    && (!melee || String(i.system.type?.value ?? "").endsWith("M")) && [...(i.system.activities ?? [])].some(a => a.type === "attack"));
  if(!weapons.length){ ui.notifications.warn(module.format("cardBuilder.noWeapon", { name : actor.name })); return null; }
  if(!hasReaction(actor)){ ui.notifications.warn(module.format("cardBuilder.noReaction", { name : actor.name })); return null; }
  const { chooseOne } = await import('../helpers/creatures.js');
  const uuid = (weapons.length === 1) ? weapons[0].uuid
    : await chooseOne(weapons.map(w => ({ value : w.uuid, label : w.name, img : w.img })), { title : name ?? actor.name, icon : "fa-solid fa-hand-fist" });
  const weapon = uuid ? fromUuidSync(uuid, { strict : false }) : null;
  if(!weapon) return null;
  /* Something to spend first (a Superiority Die) : false stops it */
  if(before && (await before(weapon)) === false) return null;
  if(!await useReaction(actor, name ?? weapon.name)) return null;
  const card = await cardBuilder.roll(weapon, { use : false, ...(Array.isArray(targets) ? { targets : targets.map(t => t?.object ?? t) } : {}) });
  if(extraDamage?.formula && card?.message?.system?.extraDamage) await card.message.system.extraDamage(extraDamage.formula,
    { key : extraDamage.key ?? "reactionAttack", label : extraDamage.label ?? name ?? "", type : extraDamage.type, rollData : extraDamage.rollData ?? actor.getRollData() });
  return card;
}

/**
 * The damage types a creature was just dealt, before its resistances or immunities (an Ochre Jelly immune to Slashing
 * is still "subjected to" it). From the options of "dnd5e.preApplyDamage" / "dnd5e.applyDamage" (args[2] / args[3]).
 *   const [, amount, options] = args;   // "dnd5e.applyDamage"
 *   if(damageTypes(options).includes("lightning")) ...
 * @param {object} options
 * @returns {string[]}
 */
export function damageTypes(options){
  return [...(options?.[module.id]?.damageTypes ?? [])];
}

/**
 * Did this damage make it Bloodied (half its HP or fewer, from above half) ? From the options of "dnd5e.applyDamage".
 *   const [, amount, options] = args;
 *   if(becameBloodied(actor, options)) ...
 * @param {Actor|Token|TokenDocument} thing
 * @param {object} options
 * @returns {boolean}
 */
export function becameBloodied(thing, options){
  const hp = (thing?.actor ?? thing)?.system?.attributes?.hp;
  const before = options?.[module.id]?.hpBefore;
  if(!hp || !Number.isFinite(before)) return false;
  /* dnd5e's own line : a percentage of its max HP (hp.bloodied, 50 by default) */
  const max = hp.effectiveMax ?? hp.max;
  const pct = n => max ? (n / max) * 100 : 100;
  const line = hp.bloodied ?? CONFIG.DND5E.bloodied?.threshold ?? 50;
  return (hp.value > 0) && (pct(hp.value) <= line) && (pct(before) > line);
}

/* The creature it's attached to (a Darkmantle's Crush), as a token, or null */
export function attachedTo(thing){
  const actor = thing?.actor ?? thing;
  const effect = actor?.effects?.find?.(e => !e.disabled && e.getFlag(module.id, "attachedTo"));
  const doc = effect ? fromUuidSync(effect.getFlag(module.id, "attachedTo"), { strict : false }) : null;
  return doc?.object ?? doc ?? null;
}

/**
 * Trample (Centaur's Trampling Charge) : pick a space within `feet`, then move there in a straight line, through the
 * spaces of creatures of `size` or smaller (a bigger one blocks the way). disengage : no Opportunity Attacks for this
 * move. It's movement like any other (token.useMovement(50) first : the 50 ft more the charge gives).
 * Returns the enemies whose space it entered, in order (null : cancelled).
 *   await token.useMovement(50);
 *   const trampled = await token.trample(50, { size : "medium", disengage : true });
 */
export async function trample(thing, feet, { size = "medium", disengage = false, enemies = true, endInside = false } = {}){
  const from = tokenOf(thing);
  if(!from) return null;
  if(!from.document.isOwner){ ui.notifications.warn(module.format("cardBuilder.teleportOwner", { name : from.name })); return null; }
  const range = Number(feet) || 0;
  if(!(range > 0)) return null;
  const grid = canvas.grid.size;
  const w = Math.max(1, Math.round(from.document.width ?? 1)), h = Math.max(1, Math.round(from.document.height ?? 1));
  /* The creatures whose space it passes through on the way to a space, in order */
  const crossed = space => {
    const start = { x : from.document.x, y : from.document.y };
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(space.x - start.x), Math.abs(space.y - start.y)) / (grid / 2)));
    const found = [];
    for(let i = 1; i <= steps; i++){
      const x = start.x + ((space.x - start.x) * i / steps), y = start.y + ((space.y - start.y) * i / steps);
      for(const t of canvas.tokens.placeables){
        if((t === from) || !t.actor || found.includes(t)) continue;
        const r = { left : t.document.x, top : t.document.y, right : t.document.x + (t.document.width * grid), bottom : t.document.y + (t.document.height * grid) };
        if((x < r.right - 1) && (x + (w * grid) > r.left + 1) && (y < r.bottom - 1) && (y + (h * grid) > r.top + 1)) found.push(t);
      }
    }
    return found;
  };
  const check = space => {
    const big = crossed(space).find(t => !isSmaller(t, size));
    return big ? module.format("cardBuilder.throughTooBig", { name : big.name }) : "";
  };
  /* endInside : it may end its move on the creatures it passes through (a Gelatinous Cube engulfing them) */
  const space = await pickSpace(from, { range, size : w, check, occupied : !!endInside, banner : module.format("cardBuilder.throughBanner", { feet : range }) });
  if(!space) return null;
  const entered = crossed(space).filter(t => !enemies || isEnemy(t, from));
  await from.document.move({ x : space.x, y : space.y }, { constrainOptions : { ignoreTokens : true }, ...(disengage ? { [module.id] : { oaSkip : true } } : {}) });
  return entered;
}

/* A condition straight on a creature, no card (Flumph's Prone Deficiency) : applyCondition's options; from : the item,
   by : the creature doing it (default : the item's owner). Not the user's own creature (gm.mine) : a card with the GM's
   button (null). confirmed : on at once (a consequence of a change the GM already allowed) */
export async function applyConditionNow(thing, spec = {}){
  const actor = thing?.actor ?? thing;
  const doc = thing?.document ?? ((thing?.documentName === "Token") ? thing : actor?.token ?? actor?.getActiveTokens?.(false, true)?.[0]?.document ?? null);
  if(!actor) return false;
  const part = applyCondition(spec);
  const by = spec.by ? (tokenOf(spec.by)?.document ?? spec.by.actor ?? spec.by) : null;
  const data = { actor : actor.uuid, token : doc?.uuid ?? null, part, origin : spec.from?.uuid ?? spec.from ?? null, by : by?.uuid ?? null };
  /* Not the user's own creature : the GM's button puts it on */
  if(!spec.confirmed && !gm.mine(actor)){
    const status = CONFIG.statusEffects.find(s => s.id === spec.type);
    const condition = status ? game.i18n.localize(status.name) : String(spec.type ?? "");
    const name = (doc ?? actor).name;
    await gm.ask("applyConditionAsk", data, { actor : by?.actor ?? (by?.documentName === "Actor" ? by : null) ?? spec.from?.actor ?? null,
      text : module.format("cardBuilder.conditionAsk", { item : spec.from?.name ?? "", name, condition }),
      label : module.format("cardBuilder.conditionButton", { name, condition }) });
    return null;
  }
  return gm.run("applyConditionNow", data);
}

/**
 * The condition lego : a creature gets a condition now, the way every rule gives one (Topple, Shove, a push into a
 * wall, a monster's Prone). Read as : target.applyCondition("prone", { save : "con", dc : 13, from : item }).
 *   save, dc     it saves first (the ability, the DC) : a success and it doesn't get it
 *   duration     rounds, "endOfNextTurn" / "startOfNextTurn" / "endOfMyNextTurn", or Foundry's duration data
 *   repeat       "end" / "start" : it saves again (same ability and DC) at that point of each of its turns, ending it
 *   from, by     the item, and the creature doing it (default : the item's owner) : its name, its origin
 *   ...          applyCondition's other options (with, escape, label, insteadOfDamage...)
 * Already under it : the harsher one stays. Done by the GM's client; on a creature that isn't the user's own (gm.mine),
 * the GM's button on a card puts it on (asked : true).
 * @returns {Promise<{ applied : boolean, asked : boolean, save : { total : number, success : boolean }|null }>}
 */
export async function giveCondition(thing, type, { save = null, dc = null, repeat = null, ...options } = {}){
  const actor = thing?.actor ?? thing;
  if(!actor || !type) return { applied : false, save : null };
  let rolled = null;
  if(save && Number.isFinite(Number(dc))){
    rolled = await rollSave(thing, save, Number(dc), { from : options.from ?? null, flags : { against : [type] } });
    if(!rolled) return { applied : false, save : null };
    rolled = { total : rolled.total, success : rolled.success };
    if(rolled.success) return { applied : false, save : rolled };
  }
  const again = (repeat && save && Number.isFinite(Number(dc))) ? { ability : save, dc : Number(dc), repeat } : null;
  const result = await applyConditionNow(thing, { ...options, type, ...(again ? { save : again } : {}) });
  return { applied : !!result, asked : result === null, save : rolled };
}

/**
 * The end-condition lego : a condition taken off a creature, the way every rule ends one (Lay on Hands' Remove Poison,
 * Lesser Restoration). Read as : target.endCondition("poisoned", { from : item }). On the user's own creature (gm.mine)
 * it ends at once; on any other, the GM's button on a card ends it (asked : true). Nothing to end : neither.
 * @param {Token|Actor} thing
 * @param {string} type      the condition's id ("poisoned")
 * @param {object} [options]
 * @param {Item} [options.from]  the item doing it (its name on the card)
 * @param {Token|Actor} [options.by]  who does it (the card's speaker; default : the item's owner)
 * @returns {Promise<{ ended : boolean, asked : boolean }>}
 */
export async function endCondition(thing, type, { from = null, by = null } = {}){
  const actor = thing?.actor ?? thing;
  if(!actor?.statuses?.has?.(type)) return { ended : false, asked : false };
  if(gm.mine(actor)) return { ended : await setStatus(actor, type, false), asked : false };
  const status = CONFIG.statusEffects.find(s => s.id === type);
  const condition = status ? game.i18n.localize(status.name) : String(type);
  const name = (thing?.document ?? thing)?.name ?? actor.name;
  await gm.ask("endConditionAsk", { actor : actor.uuid, type }, { actor : by?.actor ?? (by?.documentName === "Actor" ? by : null) ?? from?.actor ?? null,
    text : module.format("cardBuilder.endConditionAsk", { item : from?.name ?? "", name, condition }),
    label : module.format("cardBuilder.endConditionButton", { name, condition }) });
  return { ended : false, asked : true };
}

/* Is that point difficult terrain for this creature (for now : another creature's space, as dnd5e judges it) */
export function isDifficultTerrain(thing, point){
  const token = tokenOf(thing);
  if(!token || !point || !canvas.tokens?.isOccupiedGridSpaceDifficult) return false;
  const offset = canvas.grid.getOffset(point);
  try { return !!canvas.tokens.isOccupiedGridSpaceDifficult(offset, token); } catch { return false; }
}

/* Sizes, smallest first : isSmaller("medium") means Medium or smaller (as stat blocks say it) */
const SIZES = ["tiny", "sm", "med", "lg", "huge", "grg"];
const SIZE_NAMES = { tiny : "tiny", small : "sm", medium : "med", large : "lg", huge : "huge", gargantuan : "grg" };

export function isSmaller(thing, size){
  const actor = thing?.actor ?? thing;
  const own = SIZES.indexOf(actor?.system?.traits?.size);
  const most = SIZES.indexOf(SIZE_NAMES[String(size).toLowerCase()] ?? String(size).toLowerCase());
  return (own >= 0) && (most >= 0) && (own <= most);
}

/* ---------- Grapples ---------- */

/* The 2024 escape DC of a grapple : 8 + the grappler's Strength modifier + its Proficiency Bonus */
export function escapeDC(grappler){
  const actor = grappler?.actor ?? grappler;
  if(!actor?.system) return 10;
  return 8 + (Number(actor.system.abilities?.str?.mod) || 0) + (Number(actor.system.attributes?.prof) || 0);
}

/**
 * The grapple lego : grappler.grapple(target, { escape, with, from }) (the Grapple action, a monster's grab).
 *   escape   its escape DC (default : escapeDC, 8 + STR + proficiency)
 *   with     more conditions held with it (Blinded, Restrained) : they end with it
 *   from     the item; applyCondition's other options too (duration, repeat damage, self...)
 * The target gets "Grappled" with who holds it and the DC : Escape on its action bar (its Action), Release on the
 * grappler's (any time), and grapplesOn / grappling read it back.
 * @returns {Promise<{ applied : boolean, save : null }>}
 */
export async function grapple(grappler, target, { escape = null, ...options } = {}){
  const by = tokenOf(grappler) ?? grappler;
  return giveCondition(target, "grappled", { ...options, escape : Number(escape) || escapeDC(by), by });
}

/* The grapples on a creature : [{ effect, dc, by (the grappler : token or actor), byName }] */
export function grapplesOn(actor){
  return (actor?.effects?.contents ?? [...(actor?.effects ?? [])]).filter(e => !e.disabled && (e.statuses?.has?.("grappled") || e.getFlag(module.id, "grapple")?.attach)).map(effect => {
    const f = effect.getFlag(module.id, "grapple") ?? {};
    let origin = null;
    try { origin = effect.origin ? fromUuidSync(effect.origin, { strict : false }) : null; } catch { origin = null; }
    const item = (origin?.documentName === "Item") ? origin : (origin?.item ?? null);
    const by = (f.by ? fromUuidSync(f.by, { strict : false }) : null) ?? item?.actor ?? null;
    const grappler = by?.actor ?? by;
    const save = [...(item?.system?.activities ?? [])].find(a => a.type === "save");
    const text = String(item?.system?.description?.value ?? "");
    const dc = Number(f.escape) || Number(save?.save?.dc?.value) || Number(text.match(/escape\s+DC\s+(\d+)/i)?.[1]) || escapeDC(grappler);
    return { effect, dc, by, byName : by?.name ?? grappler?.name ?? "?", skill : f.skill ?? null, attach : !!f.attach };
  });
}

/* The creatures it's grappling (read from their Grappled effects : nothing to keep up to date) */
export function grappling(thing){
  const doc = thing?.document ?? ((thing?.documentName === "TokenDocument") ? thing : (thing?.token ?? null));
  const actor = thing?.actor ?? ((thing?.documentName === "Actor") ? thing : null);
  const scene = doc?.parent ?? canvas.scene;
  const mine = by => !!by && ((doc && (by.uuid === doc.uuid)) || (actor && ((by.uuid === actor.uuid) || (by.actor?.uuid === actor.uuid) || (by.id === actor.id))));
  return (scene?.tokens?.contents ?? []).filter(t => t.actor && (t !== doc) && grapplesOn(t.actor).some(g => mine(g.by))).map(t => t.object ?? t);
}

/**
 * In a "Damage about to apply" (dnd5e.preApplyDamage) item-hook macro : the creature takes only part of the damage,
 * and another takes that same amount (Rug of Smothering : half, to the creature it smothers) : a card with that
 * creature's row and an Apply button (its owner or the GM).
 */
export function shareDamage(args, other, fraction = 0.5){
  const [actor, amount, updates, options] = args ?? [];
  const target = other?.actor ?? other;
  if(!actor || !updates || !(amount > 0) || !target || (target === actor)) return 0;
  const part = Math.floor(amount * fraction);
  const hp = actor.system?.attributes?.hp ?? {};
  const temp = Number(hp.temp) || 0;
  const fromTemp = Math.min(temp, part);
  updates["system.attributes.hp.temp"] = temp - fromTemp;
  updates["system.attributes.hp.value"] = Math.max(0, (Number(hp.value) || 0) - (part - fromTemp));
  /* The combat log : what it really took */
  if(options) options[module.id] = { ...(options[module.id] ?? {}), taken : part };
  if(part > 0) setTimeout(() => cardBuilder.postShared(actor, other, part).catch(error => log.debug("Shared damage", error)), 0);
  return part;
}

/**
 * Did it charge at the target : its last stretch of movement this turn in a straight line, at least `feet` long,
 * going toward the target and ending within reach of it (Allosaurus Pounce, Boar Charge).
 */
export function chargedAt(thing, target, feet = 30, { reach = null } = {}){
  const doc = thing?.document ?? thing;
  const other = target?.document ?? target;
  const scene = doc?.parent;
  if(!doc || !other || !scene) return false;
  const size = scene.grid.size, unit = scene.grid.distance || 5;
  const points = (doc.movementHistory ?? []).map(w => ({ x : w.x, y : w.y }));
  const now = { x : doc.x, y : doc.y };
  if(!points.length || (points.at(-1).x !== now.x) || (points.at(-1).y !== now.y)) points.push(now);
  if(points.length < 2) return false;
  /* Back along the path while it keeps the last stretch's direction */
  const angle = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
  const end = points.at(-1);
  let i = points.length - 2;
  while((i >= 0) && (points[i].x === end.x) && (points[i].y === end.y)) i--;
  if(i < 0) return false;
  const heading = angle(points[i], end);
  while((i > 0) && (Math.abs(angle(points[i - 1], points[i]) - heading) < 0.15)) i--;
  const start = points[i];
  const foot = p => ({ x : p.x, y : p.y, width : doc.width, height : doc.height });
  const centre = p => ({ x : p.x + ((doc.width || 1) * size / 2), y : p.y + ((doc.height || 1) * size / 2) });
  const length = scene.grid.measurePath([centre(start), centre(end)]).distance;
  const gap = p => { const a = cells(foot(p)), b = cells(other);
    return gridSteps(Math.max(0, b.left - a.right, a.left - b.right), Math.max(0, b.top - a.bottom, a.top - b.bottom)) * unit; };
  const within = reach ?? unit;
  return (length >= feet) && (gap(end) <= within) && ((gap(start) - gap(end)) >= (feet - unit));
}

/* ---------- The card ---------- */

export class CardBuilder{
  #draft = null;
  #timer = null;

  constructor(message){
    this.message = message;
  }

  #state(){
    return foundry.utils.deepClone(this.message.getFlag(module.id, KEY) ?? { parts : [], removed : [] });
  }

  /* Changes made one after another reach the card together, once the macro pauses or ends */
  #change(fn){
    this.#draft ??= this.#state();
    fn(this.#draft);
    this.#timer ??= setTimeout(() => this.flush(), 0);
    return this;
  }

  async flush(){
    const draft = this.#draft;
    this.#draft = null;
    clearTimeout(this.#timer);
    this.#timer = null;
    if(!draft) return this;
    const rolls = await this.#extraDamage(draft);
    const update = { [`flags.${module.id}.${KEY}`] : draft };
    if(rolls.length){
      const { rollItem } = await import('./roll-item.js');
      await rollItem.showDice(rolls, this.message);
      update.rolls = [...this.message.rolls, ...rolls].map(r => JSON.stringify(r));
      if(game.dice3d) update["flags.dice-so-nice.skip"] = true;
    }
    await this.message.update(update);
    return this;
  }

  /* Extra damage parts whose facts hold for a target : rolled once, into the hit's own damage (doubled on a crit) */
  async #extraDamage(draft){
    const rolls = [];
    const attack = this.message.system?.attackRoll ?? null;
    const actor = this.message.getAssociatedActor?.();
    const rollData = this.message.getAssociatedActivity?.()?.getRollData?.() ?? actor?.getRollData?.() ?? {};
    for(const part of draft.parts){
      if((part.kind !== "damage") || part.rolled) continue;
      part.rolled = true;
      const facts = Object.values(part.facts ?? {});
      if(facts.length && !facts.some(Boolean)) continue;
      const type = part.type ?? this.message.system?.damageRolls?.[0]?.options?.type ?? null;
      rolls.push(await damageRoll(part.formula, { type, crit : !!attack?.isCritical, rollData }));
    }
    return rolls;
  }

  /* The attack roll had Advantage (Darkmantle's Crush : "if the darkmantle had Advantage on the attack roll") */
  get hadAdvantage(){
    const roll = this.message.system?.attackRoll;
    return !!(roll?.hasAdvantage ?? (roll?.options?.advantageMode > 0));
  }

  get targets(){
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    return (this.message.system?.targets ?? []).map(d => TargetsField.resolve(d)?.token).filter(Boolean);
  }

  /* The targets its attack hit (every attack, on a card with several), as the card judges them now */
  get hits(){
    const system = this.message.system;
    if(!system?.hitTargets) return [];
    const rays = system.rays?.length ? system.rays.map((_, i) => i) : [null];
    return [...new Set(rays.flatMap(ray => system.hitTargets(ray)))];
  }

  /**
   * Waits until this card's damage is applied to a target (its Apply pressed), then gives its Hit Points after it.
   * Orc Fury's Relentless : did its attack drop the target to 0 ?
   *   const hp = await card.damageApplied(target);
   * @param {Token|TokenDocument|Actor} target
   * @param {object} [options]
   * @param {number} [options.timeout]   ms to wait (none by default) : then null
   * @returns {Promise<number|null>}      its HP once the damage is on, null if the card went away or time ran out
   */
  damageApplied(target, { timeout = null } = {}){
    const actor = target?.actor ?? target;
    const id = this.message.id;
    const done = () => !!Object.keys(actor?.getFlag?.(module.id, `applied.${id}`) ?? {}).length;
    const hp = () => Number(actor?.system?.attributes?.hp?.value) || 0;
    if(!actor) return Promise.resolve(null);
    if(done()) return Promise.resolve(hp());
    return new Promise(resolve => {
      let timer = null;
      const finish = value => { Hooks.off("updateActor", onActor); Hooks.off("deleteChatMessage", onDelete); clearTimeout(timer); resolve(value); };
      const onActor = changed => { if((changed === actor) && done()) finish(hp()); };
      const onDelete = message => { if(message.id === id) finish(null); };
      Hooks.on("updateActor", onActor);
      Hooks.on("deleteChatMessage", onDelete);
      if(timeout) timer = setTimeout(() => finish(null), timeout);
    });
  }

  /* A part, after the others; its target facts (functions) judged now, for each target */
  append(part){
    if(!part?.kind) return this;
    const facts = {};
    for(const token of this.targets){
      const doc = token.document ?? token;
      const ok = part.when.every(w => (typeof w !== "function") || !!w(doc.object ?? token));
      facts[uuidKey(doc.uuid)] = ok;
    }
    const stored = { ...part, when : part.when.filter(w => (typeof w === "string") || (typeof w === "boolean")), facts };
    return this.#change(state => state.parts.push(stored));
  }

  /* An item's own effect off the card (by its condition, or its name), a part appended before, or "save" : the attack's
     on-hit save (its rider) */
  remove(what){
    return this.#change(state => {
      if(typeof what === "string") state.removed.push(what.toLowerCase());
      else state.parts = state.parts.filter(p => p !== what);
    });
  }

  /* Nothing of the item's own effects, no parts : everything from here on is appended */
  clear(){
    return this.#change(state => { state.parts = []; state.removed = ["*"]; });
  }
}

export class cardBuilder{
  /* The use an item macro is running for, by item uuid : item.roll() inside it is that use (an Opportunity Attack stays
     the Reaction, a readied use stays readied, its target stays its target) */
  static inherited = new Map();
  static INHERIT = ["economy", "oa", "readied", "skipPick", "useTargets"];

  /* item.roll() : the item's normal use, its card as a CardBuilder (null : nothing was rolled).
     use : false : an attack that's part of something else (Cleave, a Multiattack) : no dnd5e use (no uses or slots
     spent, no macro, not counted by the Action Tracker), straight to its card (rollFree) */
  static async roll(item, { post = true, activity = null, uses : shared = null, use = true, ...options } = {}){
    /* uses : another item's uses spend for this one (a wyrmling's two breaths share one Recharge 5–6) : checked first */
    const pool = shared ? (item.actor?.items?.getName(shared) ?? item.actor?.items?.get(shared) ?? null) : null;
    if(shared && !pool){ ui.notifications.warn(module.format("cardBuilder.noItem", { name : shared })); return null; }
    if(pool && !(Number(pool.system?.uses?.value) > 0)){ ui.notifications.warn(module.format("cardBuilder.usesSpent", { name : pool.name, item : item.name })); return null; }
    /* Several activities (Plutonium's two Talons) : the one asked for, else dnd5e asks */
    const list = [...(item.system?.activities ?? [])];
    const chosen = (activity === null) ? null : (Number.isInteger(activity) ? list[activity] : list.find(a => (a.id === activity) || (a.name === activity)));
    const from = this.inherited.get(item.uuid) ?? {};
    const kept = Object.fromEntries(this.INHERIT.filter(k => from[k] !== undefined).map(k => [k, from[k]]));
    const config = { [module.id] : { ...kept, skipMacro : true, ...(options.cost ? { economy : options.cost } : {}) } };
    /* Targets given : no pick, those are the targets */
    if(Array.isArray(options.targets)){
      canvas.tokens.setTargets(options.targets.map(t => (t.object ?? t)?.id).filter(Boolean));
      config[module.id].skipPick = true;
      config[module.id].useTargets = true;
      /* Its targets are known (item.target() read its area) : an instantaneous area isn't placed again; a lasting one
         (Web, Spirit Guardians) is the spell itself on the map, so it is */
      const aimed = chosen ?? list.find(a => a.target?.template?.type);
      const duration = aimed?.duration ?? {};
      if(aimed?.target?.template?.type && (duration.units === "inst") && !duration.concentration) config.create = { measuredTemplate : false };
    }
    const keys = [chosen?.uuid, item.uuid];
    /* An activity named : only it is rolled (not the item's other damage activities : Plutonium's split charge damage) */
    rollOptions.set(keys, chosen ? { ...options, only : true } : options);
    let made = null;
    try {
      if(use === false) made = (await this.rollFree(item, chosen, options))?.message ?? null;
      else {
        const results = chosen ? await chosen.use(config) : await item.use(config);
        if(!results) return null;
        made = await uses.cardOf(results);
      }
    }
    finally { rollOptions.clear(keys); }
    /* The card itself (the use may hand back its data, or the message) */
    const id = made?.id ?? made?._id ?? made?.message?.id ?? null;
    const message = (made?.documentName === "ChatMessage") ? made : (id ? game.messages.get(id) : null);
    if(!message) return null;
    if(options.ignoreCover && message.isOwner) await message.setFlag(module.id, "ignoreCover", true);
    if(options.saveDisadvantage && message.isOwner) await message.setFlag(module.id, "saveDisadvantage", true);
    if(pool) await pool.update({ "system.uses.spent" : (Number(pool.system.uses.spent) || 0) + 1 });
    if(!post) log.debug("item.roll : the card is already posted by the use; post : false is not supported yet");
    return new CardBuilder(message);
  }

  /**
   * item.roll({ use : false }) : the attack straight onto its card, no dnd5e use. Targets given : those (one attack
   * each); else picked on the map like a normal use (the Pick Targets setting; item.roll's targets check filters it),
   * else your targets. item.roll's advantage / disadvantage options apply through its roll options, like a normal use.
   * Internal options : attack (the attack activity, the item's other damage still rolled, where activity rolls only
   * that one), picked (a pickAttack result already made : its targets, attack modes and long range disadvantage),
   * count (attacks), tags (rules' marks : Cleave's { noMod }).
   * @returns {Promise<object|null>}  Roll Item's result ({ message, ... }), null if cancelled
   */
  static async rollFree(item, chosen, { attack = null, picked = null, targets, count, tags, event } = {}){
    const { rollItem } = await import('./roll-item.js');
    const activity = chosen ?? ((typeof attack === "string") ? item.system?.activities?.get(attack) : attack) ?? rollItem.getActivity(item);
    if(activity?.type !== "attack"){ ui.notifications.warn(module.format("cardBuilder.freeAttackOnly", { name : item?.name ?? "" })); return null; }
    /* No targets given : picked like a normal use's attack (the targeting lego) */
    if(!picked && !Array.isArray(targets)){
      picked = await rollItem.pickAttackFor(activity, {}, { count });
      if(!picked) return null;
      if(!picked.targets.length) picked = null;
      else count = picked.count ?? count;
    }
    if(picked) targets = picked.targets;
    else if(!Array.isArray(targets)) targets = undefined;
    return rollItem.roll(item, { activity : activity.id, event, count, attackMode : picked?.attackMode, disadvantage : picked?.disadvantage, targets, tags });
  }

  /* The item's own effects the card shows : those not removed */
  static keeps(message, effect){
    const removed = message?.getFlag?.(module.id, KEY)?.removed ?? [];
    if(!removed.length) return true;
    if(removed.includes("*")) return false;
    const statuses = [...(effect?.statuses ?? [])];
    return !removed.some(r => statuses.includes(r) || (effect?.name ?? "").toLowerCase() === r);
  }

  static shown(part, uuid, result){
    if(part.facts && (part.facts[uuidKey(uuid)] === false)) return false;
    return part.when.every(w => (w === "hit") ? (result?.hit === true) : (w === "miss") ? (result?.hit === false)
      : (w === "fail") ? (result?.success === false) : (w === "save") ? (result?.success === true) : (w !== false));
  }

  /* Card macros' building blocks, on the documents whatever the Helpers → Methods switches say :
     item.roll(), token.chargedAt(target, feet), token.teleport(feet, { item }), token.leap(feet, { item }), token.useMovement(feet), token.useReaction(what), token.reactionMove(opts), token.reactionAttack(opts), item.setDamage(formula), creature.isSmaller(size), creature.grappling() (never over an existing method) */
  static addMethods(){
    const add = (cls, name, fn) => {
      const proto = cls?.prototype;
      if(!proto || (name in proto)) return;
      Object.defineProperty(proto, name, { value : fn, writable : true, configurable : true, enumerable : false });
    };
    const self = this;
    add(CONFIG.Item.documentClass, "roll", function(options){ return self.roll(this, options); });
    add(CONFIG.Item.documentClass, "target", async function(options){ const { rollItem } = await import('./roll-item.js'); return rollItem.target(this, options); });
    add(CONFIG.Item.documentClass, "setDamage", function(formula, options){ return setDamage(this, formula, options); });
    for(const cls of [CONFIG.Actor.documentClass, CONFIG.Token.documentClass, CONFIG.Token.objectClass]){
      add(cls, "isSmaller", function(size){ return isSmaller(this, size); });
      add(cls, "grappling", function(){ return grappling(this); });
      add(cls, "grapple", function(target, options){ return grapple(this, target, options); });
      add(cls, "attachedTo", function(){ return attachedTo(this); });
      add(cls, "save", function(ability, dc, options){ return rollSave(this, ability, dc, options); });
      add(cls, "applyCondition", function(type, options){ return (typeof type === "string") ? giveCondition(this, type, options) : applyConditionNow(this, type); });
      add(cls, "endCondition", function(type, options){ return endCondition(this, type, options); });
      add(cls, "isType", function(type){ return isType(this, type); });
      add(cls, "isImmuneTo", function(item){ return isImmuneTo(this, item); });
    }
    for(const cls of [CONFIG.Token.documentClass, CONFIG.Token.objectClass]){
      add(cls, "chargedAt", function(target, feet, options){ return chargedAt(this, target, feet, options); });
      add(cls, "teleport", function(feet, options){ return teleport(this, feet, options); });
      add(cls, "leap", function(feet, options){ return leap(this, feet, options); });
      add(cls, "useMovement", function(feet){ return useMovement(this, feet); });
      add(cls, "movedThisTurn", function(){ return movedThisTurn(this); });
      add(cls, "useReaction", function(what){ return useReaction(this, what); });
      add(cls, "hasReaction", function(){ return hasReaction(this); });
      add(cls, "reactionMove", function(options){ return reactionMove(this, options); });
      add(cls, "reactionAttack", function(options){ return reactionAttack(this, options); });
      add(cls, "trample", function(feet, options){ return trample(this, feet, options); });
      add(cls, "pull", function(target, feet){ return pull(this, target, feet); });
      add(cls, "push", function(target, feet, options){ return pushAway(target, this, feet, options); });
      add(cls, "isDifficultTerrain", function(point){ return isDifficultTerrain(this, point); });
    }
  }

  static register(){
    Hooks.once("setup", () => this.addMethods());
    /* The damage types dealt, before resistances (damageTypes(options)), and the HP before it (becameBloodied) : dnd5e's
       hooks after this only see the total */
    Hooks.once("setup", () => patch.wrap("CONFIG.Actor.documentClass.prototype.applyDamage", function(wrapped, damages, options = {}, ...rest){
      const types = Array.isArray(damages) ? [...new Set(damages.filter(d => d?.type && (Number(d.value) > 0)).map(d => d.type))] : [];
      const hpBefore = this.system?.attributes?.hp?.value;
      return wrapped(damages, { ...options, [module.id] : { ...(options?.[module.id] ?? {}), damageTypes : types, hpBefore } }, ...rest);
    }));
    onDamage(rollOptionDamage);
    Hooks.on("dnd5e.postAttackRollConfiguration", (rolls, config) => rollOptionD20(rolls, config));
    Hooks.on("dnd5e.postDamageRollConfiguration", (rolls, config) => rollOptionDamageDice(rolls, config));
    /* "Its turn ends" (hook macros) : about the creature whose turn it was (actor, token, combat). "Its turn starts" is
       gm.js's (combat, combatant), once the order is settled : fired here too, it ran every start-of-turn rule twice */
    /* A Reaction move (reactionMove) : its feet counted as it goes (the client that moved it), over once they're used */
    Hooks.on("moveToken", (token, movement, options, user) => {
      if((user?.id ?? user) !== game.user.id) return;
      const reacting = reactionMoveOf(token.actor);
      if(!reacting?.effect?.isOwner) return;
      const moved = (Number(reacting.moved) || 0) + (Number(movement?.passed?.cost) || 0);
      if(moved >= reacting.feet - 0.01) reacting.effect.delete().catch(() => {});
      else reacting.effect.setFlag(module.id, "reactionMove.moved", moved).catch(() => {});
    });
    Hooks.on("combatTurnChange", (combat, prior) => {
      const ended = combat.combatants.get(prior?.combatantId);
      if(ended?.actor) Hooks.callAll(`${module.id}.turnEnd`, ended.actor, ended.token, combat);
    });
    gm.handle("cardRelease", (data, user) => this.releaseAsGM(data, user));
    /* GM : the button of release()'s ask card (the GM said yes) */
    gm.handle("cardReleaseAsk", data => this.releaseAsGM(data, game.user));
    gm.handle("cardShared", (data, user) => this.sharedAsGM(data, user));
    registerTargetCards();
    /* This instead of the damage : that creature takes none of the card's damage */
    Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options = {}) => {
      const card = options.origin;
      const tokens = (actor?.getActiveTokens?.(false, true) ?? []).map(t => uuidKey((t.document ?? t).uuid));
      const instead = card?.getFlag?.(module.id, "cardInstead") ?? {};
      if(!(amount > 0) || !tokens.some(k => instead[k])) return;
      ui.notifications.info(module.format("cardBuilder.insteadOfDamage", { name : actor.name }));
      return false;
    });
    /* A linked effect (a grapple and its grappler's Smothering) : one ending ends the other (the active GM) */
    Hooks.on("deleteActiveEffect", (effect, options = {}) => {
      if(!game.users.activeGM?.isSelf) return;
      const linked = effect.getFlag?.(module.id, "linked");
      const other = linked ? fromUuidSync(linked, { strict : false }) : null;
      if(other) other.delete({ [module.id] : { reason : options?.[module.id]?.reason ?? module.format("cardBuilder.endedWith", { name : effect.name }) } }).catch(() => null);
    });
    gm.handle("cardCondition", (data, user) => this.conditionAsGM(data, user));
    gm.handle("cardMove", ({ token : uuid, x, y } = {}, user) => {
      const doc = fromUuidSync(uuid ?? "", { strict : false });
      if(!doc) return false;
      return doc.move({ x, y, action : "displace" }, { [module.id] : { oaSkip : true } }).then(() => true);
    });
    gm.handle("applyConditionNow", (data, user) => this.applyNowAsGM(data, user));
    /* GM : the button of applyConditionNow's ask card (the GM said yes) */
    gm.handle("applyConditionAsk", data => this.applyNowAsGM(data, game.user));
    gm.handle("endConditionAsk", ({ actor, type } = {}) => setStatus(fromUuidSync(actor ?? "", { strict : false }), type, false));
    /* GM : a push / pull a player's macro asked for (forcedMove on a creature they don't own) */
    gm.handle("forcedMove", data => forcedMoveAsGM(data));
    /* GM : a save for a creature the asking user doesn't own (rollSave) */
    gm.handle("rollSave", data => rollSaveAsGM(data));
    /* GM : an effect giveEffect puts on (the user's own creature), or its ask card's button (the GM said yes) */
    gm.handle("giveEffect", (data, user) => giveEffectAsGM(data, user));
    gm.handle("giveEffectAsk", data => giveEffectAsGM(data, game.user));
    /* GM : a creature pulled out of the one engulfing it (by a creature its user owns, beside it; the one pulled out the
       user's own creature, else the GM's button : cardPullOutAsk) */
    gm.handle("cardPullOut", (data, user) => this.pullOutAsGM(data, user));
    /* GM : the button of a pull-out's ask card (the GM said yes) */
    gm.handle("cardPullOutAsk", data => this.pullOutAsGM(data, game.user));
    this.objectHooks();
    this.expiryHooks();
    /* Out of an engulfing creature once that effect ends (escape, pulled out) : beside it */
    Hooks.on("deleteActiveEffect", effect => {
      if(game.users.activeGM?.isSelf && effect.getFlag?.(module.id, "engulfedBy")) this.leaveEngulf(effect).catch(error => log.debug(error));
    });
    /* "A creature enters its space" (hook macros) : a move ending inside another creature's space (Ooze Cube).
       "Enters a creature's space" : the mover's side, any square of the move through another creature's space
       (Orc Bloodrunner's Unimpeded), once per creature per move */
    Hooks.on("moveToken", (doc, movement, options = {}) => {
      /* Not the module's own placing (into an engulfing creature, following one) */
      if(!game.users.activeGM?.isSelf || !movement?.destination || options?.[module.id]?.oaSkip) return;
      const grid = canvas.grid.size, at = movement.destination;
      const overlaps = (p, t) => (p.x < t.x + (t.width * grid)) && (p.x + (doc.width * grid) > t.x) && (p.y < t.y + (t.height * grid)) && (p.y + (doc.height * grid) > t.y);
      /* Every square along the move (its waypoints are only where it turned), not the one it started on */
      const corners = [movement.origin, ...(movement.passed?.waypoints ?? []), at].filter(Boolean);
      const path = [];
      for(let i = 1; i < corners.length; i++){
        const a = corners[i - 1], b = corners[i];
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / grid));
        for(let k = 1; k <= steps; k++) path.push({ x : a.x + (b.x - a.x) * k / steps, y : a.y + (b.y - a.y) * k / steps });
      }
      for(const t of doc.parent?.tokens ?? []){
        if((t === doc) || !t.actor) continue;
        if(overlaps(at, t)) Hooks.callAll(`${module.id}.entersSpace`, t, doc);
        if(path.some(p => overlaps(p, t))) Hooks.callAll(`${module.id}.entersCreatureSpace`, doc, t);
      }
    });
    /* "It moves through a creature's space" (hook macros) : a creature dnd5e's movement automation would stop it at
       (an enemy within one size of it); passThrough(args) lets it through. On the mover's client, as it's measured */
    Hooks.on("dnd5e.determineOccupiedGridSpaceBlocking", (space, token, options, found) => {
      for(const other of [...(found ?? [])]){
        const result = { through : false };
        Hooks.callAll(`${module.id}.movesThrough`, token?.document, other?.document, result);
        if(result.through) found.delete(other);
      }
    });
    /* "Any creature's turn starts" (hook macros) : every creature's, for the creatures around it (Ghast's Stench) */
    Hooks.on("combatTurnChange", (combat, prior, current) => {
      const started = combat.combatants.get(current?.combatantId);
      if(started?.actor) Hooks.callAll(`${module.id}.anyTurnStart`, started.actor, started.token, combat);
    });
    /* item.roll({ saveDisadvantage }) : the card's saves with disadvantage (entering an Ooze Cube) */
    Hooks.on("dnd5e.preRollSavingThrowV2", (config, dialog, message) => {
      const card = game.messages.get(message?.data?.system?.origin?.id ?? message?.data?.system?.origin);
      if(!card?.getFlag?.(module.id, "saveDisadvantage")) return;
      if(config.rolls?.[0]) noteReason(config.rolls[0], "disadvantage", card.getAssociatedItem?.()?.name ?? ""), (config.rolls[0].options.disadvantage = true);
      else config.disadvantage = true;
    });
    for(const hook of ["createToken", "deleteToken", "createActiveEffect", "deleteActiveEffect", "canvasReady"]) Hooks.on(hook, () => this.syncAuras());
    Hooks.on("updateToken", (doc, changes) => { if(("x" in changes) || ("y" in changes)) this.syncAuras(); });
    /* A Long Rest ends the conditions a rest ends (Flumph's stench : removal ["rest"]) */
    Hooks.on("dnd5e.restCompleted", (actor, result) => {
      if(!result?.longRest || !actor?.isOwner) return;
      const ended = actor.effects.filter(e => e.getFlag(module.id, "restEnds")).map(e => e.id);
      if(ended.length) actor.deleteEmbeddedDocuments("ActiveEffect", ended).catch(error => log.debug(error));
    });
    /* "Gains a condition" (hook macros) : each condition a new effect brings (the active GM, once) */
    Hooks.on("createActiveEffect", effect => {
      if(!game.users.activeGM?.isSelf || (effect.parent?.documentName !== "Actor") || effect.getFlag?.(module.id, "auraOf")) return;
      for(const status of effect.statuses ?? []) Hooks.callAll(`${module.id}.gainsCondition`, effect.parent, status, effect);
    });
    /* "Drops to 0 HP" (hook macros) : its Hit Points went from above 0 to 0 (the active GM, once) */
    Hooks.on("preUpdateActor", (actor, changes, options) => {
      if(foundry.utils.hasProperty(changes ?? {}, "system.attributes.hp.value")) options[`${module.id}HP`] = Number(actor.system?.attributes?.hp?.value) || 0;
    });
    Hooks.on("updateActor", (actor, changes, options) => {
      if(!game.users.activeGM?.isSelf || !foundry.utils.hasProperty(changes ?? {}, "system.attributes.hp.value")) return;
      const before = Number(options?.[`${module.id}HP`]), now = Number(actor.system?.attributes?.hp?.value);
      if((before > 0) && (now <= 0)) Hooks.callAll(`${module.id}.zeroHP`, actor, actor.token ?? actor.getActiveTokens?.(false, true)?.[0] ?? null);
    });
    Hooks.on("moveToken", (doc, movement) => this.followAttached(doc, movement));
    gm.handle("cardPartDone", (data, user) => this.doneAsGM(data, user));
    /* Each target's row : its parts as buttons */
    Hooks.on(`${module.id}.rowButtons`, (message, uuid, buttons, { result } = {}) => {
      const parts = message.getFlag?.(module.id, KEY)?.parts ?? [];
      parts.forEach((part, index) => {
        if(!this.shown(part, uuid, result)) return;
        const done = !!message.getFlag(module.id, `cardDone.${index}.${uuidKey(uuid)}`);
        /* One of a choice : another of it already used on this target, this one is gone */
        if(part.choice && !done && parts.some((p, i) => (i !== index) && (p.choice === part.choice) && message.getFlag(module.id, `cardDone.${i}.${uuidKey(uuid)}`))) return;
        const target = fromUuidSync(uuid, { strict : false });
        /* This or the damage : once the damage is applied to it, the choice is made */
        if(part.insteadOfDamage && !done && Object.keys(target?.actor?.getFlag?.(module.id, `applied.${message.id}`) ?? {}).length) return;
        if(part.kind === "condition"){
          if(!(game.user.isGM || gm.mine(target?.actor))) return;
          const status = CONFIG.statusEffects.find(s => s.id === part.type);
          const name = part.label ?? game.i18n.localize(status?.name ?? part.type);
          /* The condition's own picture and name; once applied, greyed out */
          buttons.push({ id : `part:${index}`, img : status?.img ?? null, icon : "fa-circle-exclamation", disabled : done, label : name });
        }
        else if(["effect", "attach", "disease", "engulf", "immunity"].includes(part.kind)){
          if(!(game.user.isGM || gm.mine(target?.actor))) return;
          const item = message.getAssociatedItem?.();
          /* An attach that brings conditions says so : "Attach (Blinded)" */
          const also = (part.with ?? []).map(id => game.i18n.localize(CONFIG.statusEffects.find(st => st.id === id)?.name ?? id)).join(", ");
          const label = part.label ?? ((part.kind === "attach") ? (module.i18n("cardBuilder.attach") + (also ? ` (${also})` : ""))
            : (part.kind === "engulf") ? module.i18n("cardBuilder.engulf") : (part.kind === "immunity") ? module.i18n("cardBuilder.immunity") : (part.name ?? item?.name ?? ""));
          buttons.push({ id : `part:${index}`, img : part.img ?? item?.img ?? null, icon : "fa-circle-exclamation", disabled : done, label });
        }
        else if(part.kind === "followUp"){
          if(!message.isOwner) return;
          buttons.push({ id : `part:${index}`, icon : "fa-hand-fist", disabled : done, label : part.label ?? part.item });
        }
      });
    });
    Hooks.on(`${module.id}.rowButton`, (message, uuid, id) => {
      if(String(id).startsWith("part:")) this.press(message, uuid, Number(String(id).slice(5)));
    });
    /* Its push parts : at the bottom of the card with every other push (card moves) */
    Hooks.on(`${module.id}.cardMoves`, (message, uuid, moves, { result } = {}) => {
      const parts = message.getFlag?.(module.id, KEY)?.parts ?? [];
      parts.forEach((part, index) => {
        if((part.kind !== "push") || !this.shown(part, uuid, result)) return;
        const done = !!message.getFlag(module.id, `cardDone.${index}.${uuidKey(uuid)}`);
        if(part.choice && !done && parts.some((p, i) => (i !== index) && (p.choice === part.choice) && message.getFlag(module.id, `cardDone.${i}.${uuidKey(uuid)}`))) return;
        if(part.insteadOfDamage && !done && Object.keys(fromUuidSync(uuid, { strict : false })?.actor?.getFlag?.(module.id, `applied.${message.id}`) ?? {}).length) return;
        moves.push({ id : `part:${index}`, feet : part.feet, from : part.from, name : part.label, label : part.label, done,
          after : () => this.doneAsGM({ message : message.id, index, target : uuid }) });
      });
    });
  }

  static async press(message, uuid, index){
    const part = message.getFlag(module.id, KEY)?.parts?.[index];
    if(!part || message.getFlag(module.id, `cardDone.${index}.${uuidKey(uuid)}`)) return;
    const parts = message.getFlag(module.id, KEY)?.parts ?? [];
    if(part.choice && parts.some((p, i) => (i !== index) && (p.choice === part.choice) && message.getFlag(module.id, `cardDone.${i}.${uuidKey(uuid)}`))) return;
    const target = fromUuidSync(uuid, { strict : false });
    if(["condition", "effect", "attach", "disease", "engulf", "immunity"].includes(part.kind)){
      const ok = await gm.run("cardCondition", { message : message.id, index, target : uuid });
      if(ok) await gm.run("cardPartDone", { message : message.id, index, target : uuid, instead : part.insteadOfDamage });
      return;
    }
    if(part.kind === "followUp"){
      const actor = message.getAssociatedActor?.();
      const item = actor?.items?.getName(part.item) ?? actor?.items?.get(part.item);
      const attack = item?.system?.activities?.find?.(a => a.type === "attack");
      if(!attack || !target?.object) return ui.notifications.warn(module.format("cardBuilder.noItem", { name : part.item }));
      canvas.tokens.setTargets([target.object.id]);
      const used = await attack.use({ [module.id] : { economy : "free", skipPick : true, useTargets : true, skipMacro : true } });
      if(used) await gm.run("cardPartDone", { message : message.id, index, target : uuid });
    }
  }

  /* GM : the condition on the target (its owner or the GM pressed it), the harsher one kept */
  static async conditionAsGM({ message : id, index, target : uuid } = {}, user){
    const message = game.messages.get(id);
    const part = message?.getFlag(module.id, KEY)?.parts?.[index];
    const actor = fromUuidSync(uuid ?? "", { strict : false })?.actor;
    if(!part || !actor || !(user.isGM || gm.mine(actor, user))) return false;
    const item = message.getAssociatedItem?.();
    const sourceToken = message.getAssociatedToken?.() ?? null;
    const context = { origin : item?.uuid ?? null, by : message.getAssociatedActor?.() ?? null, sourceToken, targetToken : fromUuidSync(uuid, { strict : false }) };
    if(part.kind === "effect") await this.applyEffectTo(actor, part, context);
    else if(part.kind === "attach") await this.attachTo(actor, part, context);
    else if(part.kind === "disease") await disease.applyTo(actor, part, context);
    else if(part.kind === "engulf") await this.engulfTo(actor, part, context);
    else if(part.kind === "immunity") await this.immunityTo(actor, part, context);
    else await this.applyConditionTo(actor, part, context);
    return true;
  }

  static async doneAsGM({ message : id, index, target : uuid, instead = false } = {}){
    const message = game.messages.get(id);
    if(!message) return false;
    await message.setFlag(module.id, `cardDone.${index}.${uuidKey(uuid)}`, true);
    if(instead) await message.setFlag(module.id, `cardInstead.${uuidKey(uuid)}`, true);
    return true;
  }

  static async pullOutAsGM({ target : uuid, puller } = {}, user){
    const doc = fromUuidSync(uuid ?? "", { strict : false });
    const by = fromUuidSync(puller ?? "", { strict : false });
    if(!doc?.actor || !(user.isGM || (by?.testUserPermission?.(user, "OWNER") && gm.mine(doc, user)))) return false;
    const ids = doc.actor.effects.filter(e => e.getFlag(module.id, "engulfedBy")).map(e => e.id);
    if(ids.length) await doc.actor.deleteEmbeddedDocuments("ActiveEffect", ids, { [module.id] : { reason : module.format("cardBuilder.pulledOut", { name : by?.name ?? "" }) } });
    return true;
  }

  /* GM : a grappler lets go (its owner or the GM pressed Release) */
  static async releaseAsGM({ target : uuid, by } = {}, user){
    const token = fromUuidSync(uuid ?? "", { strict : false });
    const grappler = fromUuidSync(by ?? "", { strict : false });
    const owner = grappler?.actor ?? grappler;
    if(!token?.actor || !(user.isGM || (owner?.testUserPermission?.(user, "OWNER") && gm.mine(token, user)))) return false;
    const mine = g => g.by && ((g.by.uuid === grappler?.uuid) || (g.by.actor?.uuid === owner?.uuid) || (g.by.uuid === owner?.uuid));
    const ids = grapplesOn(token.actor).filter(mine).map(g => g.effect.id);
    if(ids.length) await token.actor.deleteEmbeddedDocuments("ActiveEffect", ids, { [module.id] : { reason : module.format("cardBuilder.released", { name : grappler?.name ?? "" }) } });
    return true;
  }

  /* The shared damage's card : one row, Apply (the creature's owner or the GM) */
  static async postShared(from, other, amount){
    const token = (other?.document ?? other);
    const tokenDoc = (token?.documentName === "TokenDocument") ? token : (other?.actor ?? other)?.getActiveTokens?.(false, true)?.[0] ?? null;
    if(!tokenDoc) return;
    /* The feature it comes from : the effect that links them (the Rug's Smothering), else none */
    const link = from.effects?.find?.(e => e.getFlag(module.id, "holding") === tokenDoc.uuid);
    const item = link?.origin ? fromUuidSync(link.origin, { strict : false }) : null;
    await postTargetCard({ actor : from, item : item ?? { name : from.name, img : from.img, labels : {} },
      text : module.format("cardBuilder.sharedText", { name : tokenDoc.name, n : amount, from : from.name }),
      rows : [{ token : tokenDoc.uuid, label : module.format("cardBuilder.sharedApply", { n : amount }), action : "cardShared",
        data : { token : tokenDoc.uuid, amount, from : from.name }, done : module.format("cardBuilder.sharedDone", { n : amount }) }] });
  }

  static async sharedAsGM({ token : uuid, amount, from } = {}, user){
    const actor = fromUuidSync(uuid ?? "", { strict : false })?.actor;
    if(!actor || !(user.isGM || gm.mine(actor, user))) return false;
    await actor.applyDamage(Number(amount) || 0, { [module.id] : { shared : { from } } });
    return true;
  }

  /* Let go : at once when the one held is the user's own creature (gm.mine), else the GM's button */
  static async release(grappler, target){
    const by = (grappler?.document ?? grappler)?.uuid;
    const uuid = (target?.document ?? target)?.uuid;
    if(!by || !uuid) return;
    if(gm.mine(target)) return gm.run("cardRelease", { target : uuid, by });
    const name = (target?.document ?? target)?.name ?? "";
    await gm.ask("cardReleaseAsk", { target : uuid, by }, { actor : grappler?.actor ?? null,
      text : module.format("cardBuilder.releaseAsk", { by : (grappler?.document ?? grappler)?.name ?? "", name }),
      label : module.format("cardBuilder.releaseButton", { name }) });
  }

  /* A part's duration : rounds (a number) or Foundry's duration data */
  static durationOf(duration){
    if(duration === null || duration === undefined) return null;
    /* dnd5e's : the end (start) of the affected creature's next turn */
    if(duration === "endOfNextTurn") return { expiry : "targetEnd" };
    if(duration === "startOfNextTurn") return { expiry : "targetStart" };
    if(duration === "endOfMyNextTurn") return { expiry : "sourceEnd" };
    if(duration === "startOfMyNextTurn") return { expiry : "sourceStart" };
    return (typeof duration === "number") ? { rounds : duration } : duration;
  }

  /* How long it can last, in seconds (Infinity : until something ends it) */
  static lasting(duration){
    if(!duration) return Infinity;
    const d = duration;
    return (Number(d.seconds) || 0) + ((Number(d.rounds) || 0) * 6) + ((Number(d.turns) || 0) * 6) || Infinity;
  }

  /* Which is harsher : the longer, then the one with no save, then the higher DC */
  static harsher(a, b){
    const la = this.lasting(a.duration), lb = this.lasting(b.duration);
    if(la !== lb) return (la > lb) ? a : b;
    if(!!a.save !== !!b.save) return a.save ? b : a;
    return ((Number(a.save?.dc) || 0) >= (Number(b.save?.dc) || 0)) ? a : b;
  }

  /* A duration with dice in it ({ hours : "1d4" }) : rolled, as seconds */
  static async rolledDuration(duration){
    if(!duration || (typeof duration !== "object")) return duration;
    const UNIT = { seconds : 1, minutes : 60, hours : 3600, days : 86400 };
    const dice = Object.entries(duration).find(([k, v]) => UNIT[k] && (typeof v === "string") && !Number.isFinite(Number(v)));
    if(!dice) return duration;
    const roll = await new Roll(dice[1]).evaluate();
    return { seconds : roll.total * UNIT[dice[0]] };
  }

  static async applyConditionTo(actor, part, { origin = null, by = null, sourceToken = null, targetToken = null } = {}){
    if(part.duration && (typeof part.duration === "object")) part = { ...part, duration : await this.rolledDuration(part.duration) };
    const status = CONFIG.statusEffects.find(s => s.id === part.type);
    const base = game.i18n.localize(status?.name ?? part.type);
    const source = sourceToken?.name ?? by?.name ?? "";
    /* Several conditions, an escape DC or a linked effect : the name says where it's from */
    const name = part.label ?? ((part.with?.length || part.escape || part.self) && source ? `${base}: ${source}` : base);
    const duration = this.durationOf(part.duration) ?? {};
    const at = part.repeat?.at ?? part.save?.repeat ?? "end";
    const repeat = (part.save || part.repeat) ? { label : at, from : { item : origin, actor : by?.uuid ?? null },
      roll : part.save ? { type : "save", ability : part.save.ability, dc : Number(part.save.dc) || null } : null,
      when : { at, of : (part.repeat?.of === "source") ? ((sourceToken?.actor ?? by)?.uuid ?? actor.uuid) : actor.uuid },
      /* A failed repeat save worsens it (Sleep Breath : Unconscious for 1 minute, ended by damage or a Wake) */
      ...(part.save?.fail ? { onFail : part.save.fail.type, onFailDuration : this.durationOf(part.save.fail.duration),
        onFailEndsOn : [part.save.fail.endsOn ?? []].flat() } : {}),
      damage : part.repeat?.damage ? `(${part.repeat.damage})${part.repeat.type ? `[${part.repeat.type}]` : ""}` : null } : null;
    const incoming = { duration, save : part.save };
    /* Already under it : the harsher stays */
    const existing = actor.effects.filter(e => !e.disabled && e.statuses?.has?.(part.type));
    for(const e of existing){
      const old = { duration : e.duration, save : e.getFlag(module.id, "repeat")?.roll ?? null };
      if(this.harsher(old, incoming) === old) return log.debug("Kept the harsher", part.type, actor.name);
    }
    if(existing.length) await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(e => e.id),
      { [module.id] : { reason : module.format("cardBuilder.replaced", { name }) } }).catch(() => null);
    const grapple = (part.type === "grappled") ? { grapple : { by : sourceToken?.uuid ?? by?.uuid ?? null, escape : Number(part.escape) || null } } : {};
    const [made] = await actor.createEmbeddedDocuments("ActiveEffect", [{ name, img : status?.img ?? "icons/svg/aura.svg",
      statuses : [part.type, ...(part.with ?? [])], origin, duration,
      flags : { [module.id] : { cardCondition : true, ...(repeat ? { repeat } : {}), ...grapple,
        ...((part.noReactions || part.oneAction || part.randomMove) ? { rule : { ...(part.noReactions ? { noReactions : true } : {}), ...(part.oneAction ? { oneAction : true } : {}), ...(part.randomMove ? { randomMove : true } : {}) } } : {}),
        ...(part.aura ? { aura : { radius : Number(part.aura.radius) || 5, type : part.aura.type ?? part.type } } : {}),
        ...((part.removal ?? []).includes("rest") ? { restEnds : true } : {}),
        ...(part.expire ? { expire : part.expire } : {}) } } }]);
    /* Until an object is destroyed (a web) : its token on the target's space */
    if(made && (part.until?.kind === "object")) await this.makeObject(made, part.until, { targetToken, item : origin ? fromUuidSync(origin, { strict : false }) : null });
    if(made && part.aura) this.syncAuras();
    /* The doer's linked effect (the Rug's Smothering) : either ending ends the other */
    const doer = sourceToken?.actor ?? by;
    if(made && part.self && doer){
      const [mine] = await doer.createEmbeddedDocuments("ActiveEffect", [{ name : `${part.self}: ${targetToken?.name ?? actor.name}`,
        img : fromUuidSync(origin ?? "", { strict : false })?.img ?? "icons/svg/aura.svg", origin,
        flags : { [module.id] : { linked : made.uuid, holding : targetToken?.uuid ?? null } } }]);
      if(mine) await made.setFlag(module.id, "linked", mine.uuid);
    }
  }

  /* An effect that isn't a condition (Slowing Breath) : its rules and changes, the same one again replaced */
  static async applyEffectTo(actor, part, { origin = null } = {}){
    const item = origin ? fromUuidSync(origin, { strict : false }) : null;
    const name = part.name ?? item?.name ?? module.i18n("cardBuilder.effect");
    const changes = [...(part.changes ?? [])];
    if((part.speed !== null) && Number.isFinite(Number(part.speed))) for(const kind of ["walk", "fly", "climb", "swim", "burrow"])
      changes.push({ key : `system.attributes.movement.speeds.${kind}`, type : "multiply", mode : 1, value : String(part.speed) });
    const rule = { ...(part.noReactions ? { noReactions : true } : {}), ...(part.oneAction ? { oneAction : true } : {}) };
    const old = actor.effects.filter(e => (e.name === name) && (e.origin === origin));
    if(old.length) await actor.deleteEmbeddedDocuments("ActiveEffect", old.map(e => e.id), { [module.id] : { reason : module.format("cardBuilder.replaced", { name }) } }).catch(() => null);
    await actor.createEmbeddedDocuments("ActiveEffect", [{ name, img : part.img ?? item?.img ?? "icons/svg/aura.svg", origin,
      duration : this.durationOf(part.duration) ?? {}, changes,
      flags : { [module.id] : { cardCondition : true, ...(Object.keys(rule).length ? { rule } : {}) } } }]);
  }

  /* A fancy grapple (Darkmantle's Crush) : "Attached: <it>" on the target, "Attached: <target>" on it (Speed 0, follows) */
  static async attachTo(actor, part, { origin = null, by = null, sourceToken = null, targetToken = null } = {}){
    const doer = sourceToken?.actor ?? by;
    const item = origin ? fromUuidSync(origin, { strict : false }) : null;
    const img = item?.img ?? "icons/svg/net.svg";
    const source = sourceToken?.name ?? by?.name ?? "";
    const byUuid = sourceToken?.uuid ?? by?.uuid ?? null;
    /* Already attached to it : this one replaces it */
    const old = actor.effects.filter(e => e.getFlag(module.id, "grapple")?.attach && (e.getFlag(module.id, "grapple")?.by === byUuid));
    if(old.length) await actor.deleteEmbeddedDocuments("ActiveEffect", old.map(e => e.id), { [module.id] : { reason : module.format("cardBuilder.replaced", { name : source }) } }).catch(() => null);
    const [made] = await actor.createEmbeddedDocuments("ActiveEffect", [{ name : module.format("cardBuilder.attachedName", { name : source }), img, origin,
      statuses : [...(part.with ?? [])],
      flags : { [module.id] : { cardCondition : true, ownImg : true, grapple : { by : byUuid, escape : Number(part.escape) || null, skill : part.check ?? "ath", attach : true } } } }]);
    if(!made || !doer) return;
    const speed0 = ["walk", "fly", "climb", "swim", "burrow"].map(kind => ({ key : `system.attributes.movement.speeds.${kind}`, type : "override", mode : 5, value : "0" }));
    const [mine] = await doer.createEmbeddedDocuments("ActiveEffect", [{ name : module.format("cardBuilder.attachedName", { name : targetToken?.name ?? actor.name }), img, origin,
      changes : speed0, flags : { [module.id] : { linked : made.uuid, holding : targetToken?.uuid ?? null, attachedTo : targetToken?.uuid ?? null } } }]);
    if(mine) await made.setFlag(module.id, "linked", mine.uuid);
  }

  /* An attached creature moves with the one it's attached to (the active GM) */
  static followAttached(doc, movement){
    if(!game.users.activeGM?.isSelf || !movement?.origin || !movement?.destination) return;
    /* The hook comes as the move starts : from its origin to its destination */
    const dx = movement.destination.x - movement.origin.x, dy = movement.destination.y - movement.origin.y;
    if(!dx && !dy) return;
    /* An attached creature (Darkmantle), or the object holding it (a web) */
    const holds = t => {
      const held = t.getFlag?.(module.id, "objectFor");
      return !!held && (fromUuidSync(held, { strict : false })?.parent === doc.actor);
    };
    const inside = t => !!t.actor?.effects?.some?.(e => e.getFlag(module.id, "engulfedBy") === doc.uuid);
    for(const t of doc.parent?.tokens ?? []){
      if((t === doc) || !(t.actor?.effects?.some?.(e => e.getFlag(module.id, "attachedTo") === doc.uuid) || holds(t) || inside(t))) continue;
      t.move({ x : t.x + dx, y : t.y + dy, action : "displace" }, { constrainOptions : { ignoreTokens : true, ignoreWalls : true }, [module.id] : { oaSkip : true } }).catch(error => log.debug(error));
    }
  }

  static async applyNowAsGM({ actor : uuid, token : tokenUuid, part, origin, by : byUuid = null } = {}, user){
    const actor = fromUuidSync(uuid ?? "", { strict : false });
    if(!actor || !part || !(user.isGM || gm.mine(actor, user))) return false;
    const targetToken = tokenUuid ? fromUuidSync(tokenUuid, { strict : false }) : null;
    const item = origin ? fromUuidSync(origin, { strict : false }) : null;
    const doer = byUuid ? fromUuidSync(byUuid, { strict : false }) : null;
    const sourceToken = (doer?.documentName === "Token") ? doer : null;
    await this.applyConditionTo(actor, part, { origin, by : sourceToken?.actor ?? doer ?? item?.actor ?? actor, sourceToken, targetToken });
    return true;
  }

  /* ---------- Objects (a web) ---------- */

  /* The world actor every object token is made from (in the Macro Helper folder; its tokens carry their own AC, HP) */
  static async objectActor(){
    const name = module.i18n("cardBuilder.objectActor");
    let actor = game.actors.find(a => a.getFlag(module.id, "objectTemplate"));
    if(actor) return actor;
    const folderName = module.title ?? "Macro Helper";
    const folder = game.folders.find(f => (f.type === "Actor") && (f.name === folderName))
      ?? await Folder.implementation.create({ name : folderName, type : "Actor" });
    [actor] = await Actor.implementation.create([{ name, type : "npc", img : "icons/svg/net.svg", folder : folder?.id ?? null,
      system : { traits : { size : "tiny" } }, prototypeToken : { actorLink : false, disposition : 0 },
      flags : { [module.id] : { objectTemplate : true } } }]);
    return actor;
  }

  static async makeObject(effect, spec, { targetToken = null, item = null } = {}){
    const target = targetToken ?? effect.parent?.getActiveTokens?.(false, true)?.[0] ?? null;
    if(!target) return;
    const base = await this.objectActor();
    const name = spec.name ?? item?.name ?? base.name;
    const data = (await base.getTokenDocument({ x : target.x, y : target.y, name, width : target.width, height : target.height })).toObject();
    foundry.utils.mergeObject(data, { texture : { src : spec.img ?? "icons/svg/net.svg" }, actorLink : false, disposition : 0,
      delta : { name, system : { attributes : { hp : { value : Number(spec.hp) || 1, max : Number(spec.hp) || 1 }, ac : { calc : "flat", flat : Number(spec.ac) || 10 } },
        traits : { dv : { value : spec.vulnerable ?? [] }, di : { value : spec.immune ?? [] }, dr : { value : spec.resist ?? [] } } } },
      flags : { [module.id] : { objectFor : effect.uuid } } });
    const [made] = await target.parent.createEmbeddedDocuments("Token", [data]);
    if(made) await effect.setFlag(module.id, "until", made.uuid);
  }

  /* An object at 0 HP : gone, and what it held ends; an object gone : the same; the condition ending : the object goes */
  static objectHooks(){
    Hooks.on("updateActor", (actor, changes) => {
      if(!game.users.activeGM?.isSelf || !actor.isToken || !actor.token?.getFlag?.(module.id, "objectFor")) return;
      if(Number(actor.system?.attributes?.hp?.value) <= 0) actor.token.delete().catch(error => log.debug(error));
    });
    Hooks.on("deleteToken", doc => {
      if(!game.users.activeGM?.isSelf) return;
      const held = doc.getFlag?.(module.id, "objectFor");
      const effect = held ? fromUuidSync(held, { strict : false }) : null;
      if(effect) effect.delete({ [module.id] : { reason : module.format("cardBuilder.objectGone", { name : doc.name }) } }).catch(() => null);
    });
    Hooks.on("deleteActiveEffect", effect => {
      if(!game.users.activeGM?.isSelf) return;
      const obj = effect.getFlag?.(module.id, "until");
      const doc = obj ? fromUuidSync(obj, { strict : false }) : null;
      if(doc) doc.delete().catch(() => null);
    });
  }

  /* ---------- Auras (a stench) : the others within its radius have its condition while there ---------- */

  static #auraTimer = null;
  static syncAuras(){
    if(!game.users.activeGM?.isSelf) return;
    clearTimeout(this.#auraTimer);
    this.#auraTimer = setTimeout(() => this.#syncAuras().catch(error => log.debug(error)), 300);
  }

  static async #syncAuras(){
    const tokens = canvas.tokens?.placeables ?? [];
    const wanted = new Map();   /* actor uuid -> [{ aura effect, type, bearer }] */
    for(const bearer of tokens){
      for(const effect of bearer.actor?.effects ?? []){
        const aura = effect.getFlag(module.id, "aura");
        if(!aura || effect.disabled) continue;
        for(const t of tokens){
          if((t === bearer) || !t.actor || (distanceBetween(t, bearer) > aura.radius)) continue;
          const list = wanted.get(t.actor.uuid) ?? [];
          list.push({ effect, type : aura.type, bearer });
          wanted.set(t.actor.uuid, list);
        }
      }
    }
    for(const t of tokens){
      const actor = t.actor;
      if(!actor) continue;
      const mine = actor.effects.filter(e => e.getFlag(module.id, "auraOf"));
      const want = wanted.get(actor.uuid) ?? [];
      const gone = mine.filter(e => !want.some(w => w.effect.uuid === e.getFlag(module.id, "auraOf"))).map(e => e.id);
      if(gone.length) await actor.deleteEmbeddedDocuments("ActiveEffect", gone, { [module.id] : { reason : module.i18n("cardBuilder.auraLeft") } });
      for(const w of want){
        if(mine.some(e => e.getFlag(module.id, "auraOf") === w.effect.uuid)) continue;
        const status = CONFIG.statusEffects.find(s => s.id === w.type);
        await actor.createEmbeddedDocuments("ActiveEffect", [{ name : `${game.i18n.localize(status?.name ?? w.type)}: ${w.bearer.name}`,
          img : status?.img ?? "icons/svg/aura.svg", statuses : [w.type], origin : w.effect.origin,
          flags : { [module.id] : { auraOf : w.effect.uuid } } }]);
      }
    }
  }

  /* ---------- Random movement (Euphoria Breath) ---------- */

  /**
   * Its movement this turn in random directions : a d8 for the direction, a d(movement / 5) for how many squares;
   * stopped by a wall or a creature, the rest is rolled again (up to 12 times).
   */
  static async randomMove(token){
    const doc = token?.document ?? token;
    if(!doc?.actor) return;
    const { actionTracker } = await import('../automation/action-tracker.js');
    const grid = canvas.grid.size, unit = canvas.scene.grid.distance || 5;
    const DIRS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
    const NAMES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    let left = actionTracker.movementOf(doc.actor, "walk") - (actionTracker.movedOf(doc) + (Number(actionTracker.state(doc.actor)?.rec?.standing) || 0));
    const steps = [];
    let x = doc.x, y = doc.y;
    for(let tries = 0; (left >= unit) && (tries < 12); tries++){
      const dir = (await new Roll("1d8").evaluate()).total - 1;
      const max = Math.floor(left / unit);
      const n = (await new Roll(`1d${max}`).evaluate()).total;
      let moved = 0;
      for(let k = 1; k <= n; k++){
        const nx = x + (DIRS[dir][0] * grid), ny = y + (DIRS[dir][1] * grid);
        const from = { x : x + (doc.width * grid / 2), y : y + (doc.height * grid / 2) }, to = { x : nx + (doc.width * grid / 2), y : ny + (doc.height * grid / 2) };
        let blocked = false;
        try { blocked = !!CONFIG.Canvas.polygonBackends.move.testCollision(from, to, { type : "move", mode : "any" }); } catch { blocked = false; }
        const taken = canvas.tokens.placeables.some(t => (t.document !== doc) && t.actor
          && (nx < t.document.x + (t.document.width * grid)) && (nx + (doc.width * grid) > t.document.x)
          && (ny < t.document.y + (t.document.height * grid)) && (ny + (doc.height * grid) > t.document.y));
        if(blocked || taken) break;
        x = nx; y = ny; moved++;
      }
      steps.push(`${NAMES[dir]} ${n}${(moved < n) ? ` (${moved})` : ""}`);
      left -= moved * unit;
      if(moved) await doc.move({ x, y, action : "walk" }, { [module.id] : { oaSkip : true } }).catch(error => log.debug(error));
    }
    await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ token : doc }),
      content : `<p>${module.format("cardBuilder.randomMoved", { name : doc.name, steps : steps.join(", ") || "—" })}</p>` });
  }

  /* ---------- Engulf (Gelatinous Cube) ---------- */

  static async engulfTo(actor, part, { origin = null, by = null, sourceToken = null, targetToken = null } = {}){
    const cube = sourceToken ?? by?.getActiveTokens?.(false, true)?.[0] ?? null;
    if(!cube || !targetToken) return;
    const item = origin ? fromUuidSync(origin, { strict : false }) : null;
    const status = CONFIG.statusEffects.find(s => s.id === "restrained");
    const damage = part.damage ? `(${part.damage})${part.type ? `[${part.type}]` : ""}` : null;
    const [made] = await actor.createEmbeddedDocuments("ActiveEffect", [{ name : module.format("cardBuilder.engulfedName", { name : cube.name }),
      img : item?.img ?? status?.img ?? "icons/svg/acid.svg", origin, statuses : ["restrained"],
      flags : { [module.id] : { cardCondition : true, ownImg : true, engulfedBy : cube.uuid, pullDamage : damage,
        grapple : { by : cube.uuid, escape : Number(part.escape) || null, skill : "ath", attach : true, engulf : true },
        ...(damage ? { repeat : { label : "start", from : { item : origin, actor : cube.actor?.uuid ?? null }, roll : null,
          when : { at : "start", of : cube.actor?.uuid ?? null }, damage } } : {}) } } }]);
    if(!made) return;
    /* Inside it : on its space */
    await targetToken.move({ x : cube.x + ((cube.width - targetToken.width) * canvas.grid.size / 2), y : cube.y + ((cube.height - targetToken.height) * canvas.grid.size / 2), action : "displace" },
      { constrainOptions : { ignoreTokens : true, ignoreWalls : true }, [module.id] : { oaSkip : true } }).catch(error => log.debug(error));
  }

  /* Out of it (escaped, pulled out, the effect gone) : the nearest unoccupied space beside it */
  static async leaveEngulf(effect){
    const cube = fromUuidSync(effect.getFlag(module.id, "engulfedBy") ?? "", { strict : false });
    const doc = effect.parent?.getActiveTokens?.(false, true)?.[0] ?? null;
    if(!cube || !doc) return;
    const grid = canvas.grid.size;
    let best = null;
    for(let gx = cube.x - (doc.width * grid); gx <= cube.x + (cube.width * grid); gx += grid){
      for(let gy = cube.y - (doc.height * grid); gy <= cube.y + (cube.height * grid); gy += grid){
        const inCube = (gx > cube.x - (doc.width * grid)) && (gx < cube.x + (cube.width * grid)) && (gy > cube.y - (doc.height * grid)) && (gy < cube.y + (cube.height * grid));
        if(inCube) continue;
        const taken = canvas.tokens.placeables.some(t => (t.document !== doc) && t.actor && (gx < t.document.x + (t.document.width * grid)) && (gx + (doc.width * grid) > t.document.x)
          && (gy < t.document.y + (t.document.height * grid)) && (gy + (doc.height * grid) > t.document.y));
        if(taken) continue;
        const d = Math.hypot(gx - doc.x, gy - doc.y);
        if(!best || (d < best.d)) best = { x : gx, y : gy, d };
      }
    }
    if(best) await doc.move({ x : best.x, y : best.y, action : "displace" }, { constrainOptions : { ignoreTokens : true }, [module.id] : { oaSkip : true } }).catch(error => log.debug(error));
  }

  /* Its Action : pull a creature out of the one engulfing it (Athletics against its escape DC; the puller takes its damage) */
  static async pullOut(actor, token, inside){
    const effect = inside?.actor?.effects?.find?.(e => e.getFlag(module.id, "engulfedBy"));
    if(!effect) return;
    const { actionTracker } = await import('../automation/action-tracker.js');
    const dc = effect.getFlag(module.id, "grapple")?.escape ?? 10;
    const rolls = await actor.rollSkill?.({ skill : "ath", target : dc }, { configure : false }).catch(() => null);
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    if(!roll) return;
    await actionTracker.spend(actor, { kind : "action", what : module.format("actionTracker.bar.pullOut", { name : inside.name }) });
    /* Out first (the burn could drop the puller), then the burn, success or not */
    const damage = effect.getFlag(module.id, "pullDamage");
    const out = { target : inside.document.uuid, puller : actor.uuid };
    if(roll.total < dc) log.debug("Pull out failed", inside.name);
    else if(gm.mine(inside)) await gm.run("cardPullOut", out).catch(error => log.debug(error));
    else await gm.ask("cardPullOutAsk", out, { actor, text : module.format("cardBuilder.pullOutAsk", { by : actor.name, name : inside.name }),
      label : module.format("actionTracker.bar.pullOut", { name : inside.name }) });
    if(damage){
      const hurt = await new CONFIG.Dice.DamageRoll(damage, {}, {}).evaluate();
      await hurt.toMessage({ speaker : ChatMessage.implementation.getSpeaker({ actor }), flavor : module.format("cardBuilder.pullBurn", { name : actor.name }) });
      await actor.applyDamage([{ value : hurt.total, type : damage.match(/\[(\w+)\]/)?.[1] }]).catch(error => log.debug(error));
    }
  }

  /* ---------- Immunity (Ghast's Stench) ---------- */

  static async immunityTo(actor, part, { origin = null, sourceToken = null, by = null } = {}){
    const item = origin ? fromUuidSync(origin, { strict : false }) : null;
    if(!item || isImmuneTo(actor, item)) return;
    const seconds = disease.seconds(part.duration) || 86400;
    await actor.createEmbeddedDocuments("ActiveEffect", [{ name : module.format("cardBuilder.immuneName", { item : item.name, name : sourceToken?.name ?? by?.name ?? "" }),
      img : item.img, origin, duration : { seconds }, flags : { [module.id] : { immuneTo : item.uuid } } }]);
  }

  /* ---------- A condition that runs its full time : what then (Gas Spore : dead) ---------- */

  static expiryHooks(){
    Hooks.on("updateActiveEffect", (effect, changes) => {
      if(!game.users.activeGM?.isSelf || !foundry.utils.getProperty(changes ?? {}, "duration.expired")) return;
      const expire = effect.getFlag(module.id, "expire");
      const actor = effect.parent;
      if(!expire || (actor?.documentName !== "Actor")) return;
      (async () => {
        if(expire.status) await actor.toggleStatusEffect(expire.status, { active : true, overlay : expire.status === "dead" });
        await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }),
          content : `<p>${module.format("cardBuilder.expired", { name : actor.name, effect : effect.name })}</p>` });
        await effect.delete();
      })().catch(error => log.debug(error));
    });
  }
}
