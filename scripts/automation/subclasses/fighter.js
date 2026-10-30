import { module } from '../../module.js';
import { logger } from '../../log.js';
import { gm } from '../../gm.js';
import { idOf, chooseOption, esc } from '../../helpers/utils.js';
import { giveEffect, rollSave, itemOf } from '../../helpers/actors.js';
import { tokenOf, distanceBetween, canSee, forcedMove } from '../../helpers/tokens.js';
import { pickTargets, pickSpace } from '../../helpers/targets.js';
import { spendUses, heldItems, dropHeld } from '../../helpers/items.js';
import { chooseOne } from '../../helpers/creatures.js';
import { giveMode } from '../../roll-item/reasons.js';
import { onHit, hitOf } from '../../roll-item/hit-bonus.js';
import { cutDamage } from '../../roll-item/damage-cuts.js';
import { cardBuilder, giveCondition, isSmaller, reactionAttack, reactionMoveRows, reactionAttackRows } from '../../roll-item/card-builder.js';
import { addDie, rerolls } from '../../roll-item/rerolls.js';
import { TYPES } from '../../roll-item/message.js';
import { rollModes } from '../roll-modes.js';
import { conditions } from '../conditions.js';
import { actions } from '../actions.js';
import { hands } from '../hands.js';
import { actionTracker } from '../action-tracker.js';
import { itemFixes } from '../item-fixes.js';
import { uses } from '../../uses.js';
import { subclasses } from './common.js';
const log = logger.for(import.meta.url);

/**
 * Fighter subclasses, level 3 (Subclasses setting). Improved Critical, Remarkable Athlete (dnd5e's flag : Initiative and
 * Athletics), the Eldritch Knight's spellcasting, Student of War and Rally's temporary Hit Points are the items' data.
 *
 *   Battle Master  Maneuvers : the Superiority Die (8 + STR or DEX + Proficiency for their saves), one maneuver per
 *                  attack. A hit : a button for each hit maneuver known (Trip, Pushing, Menacing, Goading, Disarming,
 *                  Distracting) : a die spent, its roll as extra damage, then its effect (the save, rolled at once).
 *                  Sweeping Attack : a creature within 5 ft of the target and of you that the attack roll would hit
 *                  takes the die (the item's own damage). Lunging Attack / Feinting Attack (Bonus Actions : Dash; Advantage on
 *                  the next attack this turn against a creature within 5 ft) : their die goes on the next hit this
 *                  turn. A miss : Precision Attack adds the die to the attack roll. Hit by a melee attack : Parry (its
 *                  Reaction) takes die + STR or DEX off the damage; missed by one : Riposte (its Reaction) attacks back
 *                  with the die as extra damage. Evasive Footwork : Disengage, the die on its AC until its next turn.
 *                  Bait and Switch : swap places with a willing creature within 5 ft, the die on one of your ACs.
 *                  Ambush (Stealth, Initiative), Commanding Presence (Intimidation, Performance, Persuasion), Tactical
 *                  Assessment (History, Investigation, Insight) : a button on that check adds the die. Maneuvering
 *                  Attack (a hit maneuver) : a willing ally may move half its Speed with its Reaction, no Opportunity
 *                  Attack from the target (reactionMove). Commander's Strike : one of the Attack action's attacks
 *                  (Action Tracker), a die spent : the ally's card, Attack (Reaction) with the die on its damage
 *                  (reactionAttack). Riposte uses reactionAttack too.
 *   Psi Warrior    Psionic Energy Dice : the Psionic Energy Die item's uses (else Psionic Power's). Protective Field : a creature it sees within
 *                  30 ft (itself too) is hit, or is on a save card's damage : a button (its Reaction, a die) takes
 *                  die + INT (at least 1) off the card's damage to it. Psionic Strike : once on each of its turns, a weapon hit on a creature within
 *                  30 ft : die + INT Force. Telekinetic Movement : a willing creature you see within 30 ft moves up to
 *                  30 ft to a space you pick (the GM's button for one you don't own).
 *   Eldritch Knight War Bond : Summon Weapon puts a bonded weapon (War Bonded) in your hand.
 */
export class fighterArchetypes{
  /* The hit maneuvers : a die spent on the hit, its damage on the card, then their effect */
  static HIT = ["trip-attack", "pushing-attack", "menacing-attack", "goading-attack", "disarming-attack", "distracting-strike", "maneuvering-attack"];
  static COMMANDERS = "commanders-strike";
  /* Their die was spent by the Bonus Action : it goes on the next hit this turn */
  static PRIMED = ["lunging-attack", "feinting-attack"];
  static CHECKS = { "ambush" : ["ste"], "commanding-presence" : ["itm", "prf", "per"], "tactical-assessment" : ["his", "inv", "ins"] };
  static PSIONIC = "psionic-power";
  static WAR_BOND = "war-bond";

  static enabled(){
    return subclasses.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    for(const id of this.HIT){
      onHit({ id, feature : actor => this.has(actor, id), icon : "fa-chess-knight", enabled : () => this.enabled(),
        when : hit => !this.maneuvered(hit) && ((id !== "trip-attack" && id !== "pushing-attack") || !hit.target || isSmaller(hit.target, "large")),
        cost : hit => ({ item : this.diceOf(hit.actor), amount : 1 }),
        formula : hit => this.dieOf(hit.actor),
        after : hit => this.rider(id, hit), conditions : { "trip-attack" : ["prone"], "menacing-attack" : ["frightened"] }[id] ?? [] });
    }
    for(const id of this.PRIMED){
      onHit({ id, feature : actor => this.has(actor, id), icon : "fa-chess-knight", enabled : () => this.enabled(), ownTurn : true,
        when : hit => !this.maneuvered(hit) && !!this.primed(hit.actor, id, hit.target) && ((id !== "lunging-attack") || hit.melee),
        formula : hit => this.dieOf(hit.actor),
        after : hit => this.primed(hit.actor, id, hit.target)?.delete() });
    }
    onHit({ id : "psionic-strike", feature : "psionic-strike", icon : "fa-brain", enabled : () => this.enabled(), ownTurn : true, once : "turn",
      within : 30, when : hit => hit.weapon, cost : hit => ({ item : this.psionicOf(hit.actor), amount : 1 }),
      formula : hit => `${this.psionicDie(hit.actor)} + @abilities.int.mod`, types : () => ["force"] });
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => this.cardButtons(message, buttons, ray ?? null));
    Hooks.on(`${module.id}.saveCardButtons`, (message, buttons) => this.saveFieldButtons(message, buttons));
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => this.cardClicked(message, String(id), ray ?? null));
    Hooks.on(`${module.id}.rerollButtons`, (message, buttons, { actor, roll }) => this.checkButtons(message, buttons, actor, roll));
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.afterUse(activity, results));
    rollModes.add("feint", config => this.feintMode(config));
    gm.handle("fighterMove", (data, user) => this.moveAsGM(data, user));
    /* Commander's Strike : one of the Attack action's attacks, given to an ally (its Reaction attack) */
    for(const id of [this.COMMANDERS, `maneuvers-${this.COMMANDERS}`]){
      actionTracker.REPLACES_ATTACK.add(id);
      subclasses.onUseStep(id, (activity, ctx, next) => this.commandersStrike(activity, ctx, next));
    }
    Hooks.on(`${module.id}.damageType`, (activity, info) => this.presetType(activity, info));
    itemFixes.add({ name : "Lunging / Feinting Attack, Bait and Switch", where : "owned", plan : item => this.maneuverFix(item) });
  }

  /* Plutonium rolls Lunging / Feinting Attack's die as damage on use (asking its type) : the die goes on the next hit.
     Bait and Switch's card offers twelve "Baited AC +n" effects : the module puts the card's die on the AC chosen. */
  static maneuverFix(item){
    if(!this.enabled()) return null;
    const id = this.maneuverId(item);
    const update = {};
    for(const activity of item.system.activities ?? []){
      if(this.PRIMED.includes(id) && (activity.type === "damage") && activity.damage?.parts?.length) update[`system.activities.${activity.id}.damage.parts`] = [];
      if((id === "bait-and-switch") && activity.effects?.length) update[`system.activities.${activity.id}.effects`] = [];
    }
    return Object.keys(update).length ? { update } : null;
  }

  /* ---------- Battle Master ---------- */

  /* The Superiority Dice : Plutonium's Superiority Die item, else Combat Superiority's uses */
  static diceOf(actor){
    return actor?.items?.find?.(i => ["superiority-die", "superiority-dice"].includes(idOf(i)) || /^superiority di(c)?e$/i.test(i.name))
      ?? actor?.items?.find?.(i => (idOf(i) === "combat-superiority") && Number(i.system.uses?.max)) ?? null;
  }

  static dieOf(actor){
    const scale = actor?.system?.scale?.["battle-master"]?.superiority?.die ?? actor?.system?.scale?.["battle-master"]?.["superiority-die"];
    return scale?.formula || (scale?.faces ? `1d${scale.faces}` : "1d8");
  }

  static dcOf(actor){
    const a = actor?.system?.abilities ?? {};
    return 8 + Math.max(Number(a.str?.mod) || 0, Number(a.dex?.mod) || 0) + (Number(actor?.system?.attributes?.prof) || 0);
  }

  /* A maneuver by its name's identifier : Plutonium's 2024 ones are "maneuvers-riposte" */
  static has(actor, id){
    return itemOf(actor, [id, `maneuvers-${id}`]);
  }

  static maneuverId(item){
    return String(idOf(item)).replace(/^maneuvers-/, "");
  }

  /* One maneuver per attack : a hit maneuver's die, Precision's (on this client), or Riposte's own attack (its die, added
     to the whole card) */
  static maneuvered(hit){
    return [...this.HIT, ...this.PRIMED].some(id => hit.message.system.extraRolls?.(hit.ray, id)?.length)
      || this.#done.has(`m|${hit.message.id}|${hit.ray}`)
      || !!hit.message.system.extraRolls?.(null, "riposte")?.length;
  }

  /* The die rolled now (shown), for a use that isn't damage */
  static async rollDie(actor, message = null, bonus = ""){
    const roll = await new Roll(`${this.dieOf(actor)}${bonus}`, actor.getRollData()).evaluate();
    const { rollItem } = await import('../../roll-item/roll-item.js');
    await rollItem.showDice([roll], message);
    return roll;
  }

  /* What a hit maneuver does after its die */
  static async rider(id, hit){
    const target = hit.target;
    const item = this.has(hit.actor, id);
    const dc = this.dcOf(hit.actor);
    if(!target || !item) return;
    const me = hit.token;
    if(id === "trip-attack") await giveCondition(target, "prone", { save : "str", dc, from : item, by : me });
    else if(id === "menacing-attack") await giveCondition(target, "frightened", { save : "wis", dc, from : item, by : me, duration : "endOfMyNextTurn" });
    else if(id === "pushing-attack"){
      const save = await rollSave(target, "str", dc, { from : item });
      if(save && !save.success) await forcedMove(target, { direction : "away", feet : 15, from : me, item, name : item.name });
    }
    else if(id === "goading-attack") await subclasses.giveEffect(target, { name : module.i18n("subclasses.fighter.goaded"),
      flags : { [module.id] : { rule : { onlyAgainstOrigin : "disadvantage" } } } }, { save : "wis", dc, from : item, until : "turnEnd", of : hit.actor });
    else if(id === "distracting-strike") await subclasses.giveEffect(target, { name : module.i18n("subclasses.fighter.distracted"),
      flags : { [module.id] : { rule : { nextAttackAgainst : "advantage" } } } }, { from : item, until : "turnStart", of : hit.actor });
    /* A willing ally moves with its Reaction, half its Speed, no Opportunity Attack from the target */
    else if(id === "maneuvering-attack"){
      const [ally] = await pickTargets(me, { count : 1, range : Infinity, disposition : "ally", includeSelf : false, confirm : "auto", useTargets : false }) ?? [];
      if(ally) await reactionMoveRows(hit.actor, item, [ally], { half : true, noOA : [target], text : module.format("subclasses.fighter.maneuvering", { name : ally.name, target : target.name }) });
    }
    else if(id === "disarming-attack"){
      const save = await rollSave(target, "str", dc, { from : item });
      if(save && !save.success) await this.disarm(hit, target, item);
    }
  }

  /* Disarming Attack's failed save : it drops one object it's holding, the attacker's choice (still on its sheet) */
  static async disarm(hit, target, item){
    const speaker = ChatMessage.implementation.getSpeaker({ actor : hit.actor });
    const held = heldItems(target);
    if(!held.length) return ChatMessage.implementation.create({ speaker, content : `<p>${esc(module.format("subclasses.fighter.disarmedNothing", { name : target.name }))}</p>` });
    const chosen = (held.length === 1) ? held[0].id : await chooseOne(held.map(i => ({ value : i.id, label : i.name, img : i.img })),
      { title : item.name, icon : "fa-solid fa-hand", prompt : module.format("subclasses.fighter.disarmPrompt", { name : target.name }), columns : Math.min(3, held.length) });
    const object = chosen ? target.actor.items.get(chosen) : null;
    if(!object) return;
    const { dropped } = await dropHeld(target, object, { from : item });
    if(dropped) await ChatMessage.implementation.create({ speaker,
      content : `<p>${esc(module.format("helpers.dropHeld.dropped", { name : target.name, item : object.name, from : item.name }))}</p>` });
  }

  /* Commander's Strike : a willing ally, a die spent, then its card : the ally's Attack (Reaction) button, the die on
     its damage (no dnd5e roll of its own) */
  static async commandersStrike(activity, ctx, next){
    const actor = activity.actor;
    const me = tokenOf(activity.getUsageToken?.() ?? actor);
    const dice = this.diceOf(actor);
    if(!me || !dice) return next();
    if(!(Number(dice.system?.uses?.value) > 0)) return ui.notifications.warn(module.format("subclasses.fighter.noDice", { name : actor.name })), null;
    const [ally] = await pickTargets(me, { count : 1, range : Infinity, disposition : "ally", includeSelf : false, confirm : "auto", useTargets : false }) ?? [];
    if(!ally || !await spendUses(dice, 1)) return null;
    /* The die is rolled with the ally's damage (doubled on a critical hit) */
    const die = this.dieOf(actor);
    const message = await reactionAttackRows(actor, activity.item, [ally], { extraDamage : { formula : die, label : activity.item.name },
      text : module.format("subclasses.fighter.commanders", { name : ally.name, n : die }) });
    return message ? { message } : null;
  }

  /* Lunging / Feinting Attack's die, waiting for the next hit this turn (Feinting : on that creature) */
  static primed(actor, id, target = null){
    return actor?.effects?.find?.(e => (e.getFlag(module.id, "primed")?.id === id)
      && (!e.getFlag(module.id, "primed").target || (e.getFlag(module.id, "primed").target === target?.document?.uuid))) ?? null;
  }

  /* Feinting Attack : Advantage on the next attack this turn against that creature */
  static feintMode(config){
    const actor = config.subject?.actor;
    const target = conditions.targetOf(config);
    const feint = this.enabled() ? this.primed(actor, "feinting-attack", target) : null;
    if(feint && config.rolls?.[0] && !feint.getFlag(module.id, "primed").attacked) giveMode(config.rolls[0], "advantage", feint.name);
  }

  /* After a maneuver's own use (its Bonus Action) */
  static async afterUse(activity, results = null){
    if(!this.enabled() || !activity?.actor?.isOwner) return;
    const id = this.maneuverId(activity.item);
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    try {
      if(id === "lunging-attack"){
        await actions.mark(actor, "dash", "actions.dash.mark", "icons/skills/movement/feet-winged-boots-glowing-yellow.webp");
        await giveEffect(actor, { name : activity.item.name, img : activity.item.img, flags : { [module.id] : { primed : { id } } } }, { until : "turnEnd", thisTurn : true });
      }
      else if(id === "feinting-attack"){
        const [target] = await pickTargets(tokenOf(actor), { count : 1, range : 5, disposition : "nonAlly", confirm : "auto" }) ?? [];
        if(target) await giveEffect(actor, { name : activity.item.name, img : activity.item.img,
          flags : { [module.id] : { primed : { id, target : target.document.uuid } } } }, { until : "turnEnd", thisTurn : true });
      }
      else if(id === "evasive-footwork"){
        await actions.mark(actor, "disengage", "actions.disengage.mark", "icons/skills/movement/arrow-upward-yellow.webp");
        await this.acBonus(actor, activity.item, actor, await this.cardDie(results));
      }
      else if(id === "bait-and-switch") await this.baitAndSwitch(actor, activity.item, await this.cardDie(results));
      else if(id === "telekinetic-movement") await this.telekinetic(actor, activity.item);
      else if(id === this.WAR_BOND) await this.summonBonded(actor, activity);
    }
    catch(error){ log.error(error); ui.notifications.warn(error.message); }
  }

  /* The die the use's own card rolled (Plutonium's AC Bonus formula), if it did */
  static async cardDie(results){
    const card = await uses.cardOf(results);
    const message = (card?.documentName === "ChatMessage") ? card : (card?.message ?? null);
    const total = Number(message?.system?.formulaRolls?.[0]?.total);
    return Number.isFinite(total) ? total : null;
  }

  /* The die on a creature's AC until the start of the Fighter's next turn (the card's roll, else rolled now) */
  static async acBonus(fighter, item, onto, total = null){
    const n = Number.isFinite(total) ? total : (await this.rollDie(fighter)).total;
    const data = { name : module.format("subclasses.fighter.acBonus", { item : item.name, n }), img : item.img, origin : item.uuid,
      changes : [{ key : "system.attributes.ac.bonus", type : "add", mode : 2, value : String(n) }] };
    await giveEffect(onto, data, { from : item, until : "turnStart", of : fighter });
  }

  static async baitAndSwitch(actor, item, total = null){
    const me = tokenOf(actor);
    const [other] = await pickTargets(me, { count : 1, range : 5, disposition : "ally", confirm : "auto", useTargets : false }) ?? [];
    if(!me || !other) return;
    const a = { x : me.document.x, y : me.document.y }, b = { x : other.document.x, y : other.document.y };
    await this.moveTo(actor, me, b, item);
    await this.moveTo(actor, other, a, item);
    const who = await chooseOption({ title : item.name, icon : "fa-solid fa-shield", prompt : module.i18n("subclasses.fighter.baitWho"),
      options : [me, other].map(t => ({ value : t.document.uuid, label : t.name })) });
    const onto = who ? fromUuidSync(who, { strict : false })?.actor : null;
    if(onto) await this.acBonus(actor, item, onto, total);
  }

  /* A token moved to a space (the user's own creature, else the GM's button) */
  static async moveTo(actor, token, point, item){
    if(gm.mine(token.actor)) return token.document.update({ x : point.x, y : point.y }, { animate : false });
    return gm.ask("fighterMove", { token : token.document.uuid, x : point.x, y : point.y, item : item.uuid },
      { actor, label : module.i18n("subclasses.fighter.moveIt"), text : module.format("subclasses.fighter.moveAsk", { name : actor.name, item : item.name, target : token.name }) });
  }

  static async moveAsGM({ token : uuid, x, y } = {}){
    const token = fromUuidSync(uuid ?? "", { strict : false });
    if(token) await token.update({ x, y }, { animate : false });
    return true;
  }

  /* ---------- Card buttons : Sweeping, Precision, Parry, Riposte, Protective Field ---------- */

  static #done = new Set();

  static cardButtons(message, buttons, ray){
    if(!this.enabled() || (message.type !== TYPES.attack) || !message.system?.attackOf?.(ray)) return;
    const attacker = tokenOf(message.getAssociatedToken?.() ?? message.getAssociatedActor?.());
    const actor = message.getAssociatedActor?.();
    const hit = message.system.isHitOn?.(ray);
    const key = `${message.id}|${ray}`;
    const dice = a => Number(this.diceOf(a)?.system?.uses?.value) > 0;
    const melee = this.isMelee(message, ray);
    /* The attacker's own : Sweeping (a hit), Precision (a miss) */
    if(actor?.isOwner && dice(actor) && !this.#done.has(`m|${key}`)){
      if(hit && melee && this.has(actor, "sweeping-attack") && !this.maneuvered(hitOf(message, ray) ?? { message, ray })) buttons.push({ id : "sweep", icon : "fa-chess-knight", label : this.has(actor, "sweeping-attack").name });
      if(!hit && this.has(actor, "precision-attack")) buttons.push({ id : "precision", icon : "fa-chess-knight", label : this.has(actor, "precision-attack").name });
    }
    /* The targets' : Parry (hit by a melee attack), Riposte (missed by one), Protective Field (a creature near, hit) */
    const targets = (message.system.targetsOf?.(ray) ?? []).map(t => tokenOf(dnd5e.dataModels.chatMessage.fields.TargetsField.resolve(t).token)).filter(Boolean);
    const hits = new Set((message.system.hitTargets?.(ray) ?? []).map(t => tokenOf(t)));
    for(const t of targets){
      const a = t.actor;
      if(a?.isOwner && melee && dice(a) && actionTracker.left(a, "reaction") && !this.#done.has(`r|${key}|${t.id}`)){
        if(hits.has(t) && this.has(a, "parry")) buttons.push({ id : `parry|${t.document.uuid}`, icon : "fa-shield", label : this.has(a, "parry").name });
        if(!hits.has(t) && this.has(a, "riposte") && attacker) buttons.push({ id : `riposte|${t.document.uuid}`, icon : "fa-reply", label : this.has(a, "riposte").name });
      }
      if(!hits.has(t)) continue;
      for(const guard of this.fieldGuards(t)){
        if(this.#done.has(`f|${key}|${t.id}`)) break;
        buttons.push({ id : `field|${guard.document.uuid}|${t.document.uuid}`, icon : "fa-brain",
          label : module.format("subclasses.fighter.field", { name : t.name }) });
      }
    }
  }

  static isMelee(message, ray){
    let action = "";
    try { action = String(message.getAssociatedActivity?.()?.getActionType?.(message.system.attackOf?.(ray)?.options?.attackMode) ?? ""); } catch {}
    return action.startsWith("m");
  }

  static async cardClicked(message, id, ray){
    const [kind, a, b] = id.split("|");
    if(!["sweep", "precision", "parry", "riposte", "field"].includes(kind)) return;
    const key = `${message.id}|${ray}`;
    if(kind === "sweep") return this.sweep(message, ray, key);
    if(kind === "precision") return this.precision(message, ray, key);
    const token = tokenOf(fromUuidSync(a ?? "", { strict : false }));
    if(!token?.actor?.isOwner) return;
    if(kind === "parry") return this.parry(message, ray, token, key);
    if(kind === "riposte") return this.riposte(message, ray, token, key);
    if(kind === "field") return this.field(message, token, tokenOf(fromUuidSync(b ?? "", { strict : false })), key);
  }

  /* Sweeping : a creature within 5 ft of the target and of you, that the attack roll would hit, takes the die */
  static async sweep(message, ray, key){
    const actor = message.getAssociatedActor?.();
    const me = tokenOf(actor);
    const item = this.has(actor, "sweeping-attack");
    const first = (message.system.hitTargets?.(ray) ?? []).map(t => tokenOf(t))[0];
    const total = Number(message.system.attackOf?.(ray)?.total) || 0;
    if(!item || !me || !first || this.#done.has(`m|${key}`)) return;
    const [other] = await pickTargets(me, { count : 1, range : 5, disposition : "nonAlly", confirm : "auto", useTargets : false,
      filter : t => (t !== first) && (distanceBetween(t, first) <= 5) }) ?? [];
    if(!other) return;
    this.#done.add(`m|${key}`);
    if(total < (Number(other.actor?.system?.attributes?.ac?.value) || 0)){
      await spendUses(this.diceOf(actor), 1);
      return ui.notifications.info(module.format("subclasses.fighter.sweepMiss", { name : other.name }));
    }
    const damage = [...(item.system.activities ?? [])].find(x => x.type === "damage");
    this.#sweepType = { item : item.id, type : message.system.damageRolls?.[0]?.options?.type ?? null, at : Date.now() };
    if(damage) await cardBuilder.roll(item, { activity : damage.id, targets : [other] });
  }

  static #sweepType = null;

  /* The swept creature's damage : the weapon's type, no question */
  static presetType(activity, { types, preset }){
    const kept = this.#sweepType;
    /* While its use window may still be open, and its rerolls (2 minutes) */
    if(!kept || (kept.item !== activity?.item?.id) || ((Date.now() - kept.at) > 120000) || !types.includes(kept.type)) return;
    preset.type = kept.type;
  }

  /* Precision : the die onto the missed attack roll */
  static async precision(message, ray, key){
    const actor = message.getAssociatedActor?.();
    if(!actor?.isOwner || this.#done.has(`m|${key}`) || !await spendUses(this.diceOf(actor), 1)) return;
    this.#done.add(`m|${key}`);
    const roll = await this.rollDie(actor, message);
    await subclasses.changeRoll(message, { ray, add : String(roll.total) }, actor);
  }

  /* Parry : die + STR or DEX off this card's damage to it (its Reaction) */
  static async parry(message, ray, token, key){
    const actor = token.actor;
    const item = this.has(actor, "parry");
    if(!item || this.#done.has(`r|${key}|${token.id}`) || !await spendUses(this.diceOf(actor), 1)) return;
    this.#done.add(`r|${key}|${token.id}`);
    const roll = await this.rollDie(actor, message, " + max(@abilities.str.mod, @abilities.dex.mod)");
    await cutDamage(message, token, { id : "parry-maneuver", amount : roll.total, by : token.name, label : item.name, formula : roll.formula, result : roll.result });
    await actionTracker.spend(actor, { kind : "reaction", what : item.name }).catch(() => null);
  }

  /* Riposte : a melee attack back at the attacker, the die as extra damage (its Reaction : the reactionAttack lego) */
  static async riposte(message, ray, token, key){
    const actor = token.actor;
    const item = this.has(actor, "riposte");
    const attacker = tokenOf(message.getAssociatedToken?.() ?? message.getAssociatedActor?.());
    if(!item || !attacker || this.#done.has(`r|${key}|${token.id}`)) return;
    await reactionAttack(actor, { targets : [attacker], melee : true, name : item.name,
      before : async () => { if(!await spendUses(this.diceOf(actor), 1)) return false; this.#done.add(`r|${key}|${token.id}`); },
      extraDamage : { formula : this.dieOf(actor), key : "riposte", label : item.name } });
  }

  /* Ambush, Commanding Presence, Tactical Assessment : the die on that check */
  static checkButtons(message, buttons, actor, roll){
    if(!this.enabled() || !actor?.isOwner || message.getFlag?.(module.id, "maneuverDie")) return;
    const initiative = !!message.getFlag?.("core", "initiativeRoll");
    const skill = message.system?.skill ?? null;
    if(!(Number(this.diceOf(actor)?.system?.uses?.value) > 0)) return;
    for(const [id, skills] of Object.entries(this.CHECKS)){
      const item = this.has(actor, id);
      if(!item || !(skills.includes(skill) || (initiative && (id === "ambush")))) continue;
      buttons.push({ id : `maneuver-${id}`, icon : "fa-chess-knight", label : item.name, run : async () => {
        if(message.getFlag(module.id, "maneuverDie") || !await spendUses(this.diceOf(actor), 1)) return;
        const { updated, extra } = await addDie(message.rolls[0], this.dieOf(actor));
        await rerolls.replace(message, updated, [extra]);
        if(message.isOwner) await message.setFlag(module.id, "maneuverDie", true);
      } });
    }
  }

  /* ---------- Psi Warrior ---------- */

  /* The Psionic Energy Dice : Plutonium's "Psionic Energy Die" item (4 at level 3), else Psionic Power's uses (Plutonium's
     own Protective Field spends Psionic Power's single use : a short rest's one die, not the pool) */
  static psionicOf(actor){
    return itemOf(actor, "psionic-energy-die") ?? itemOf(actor, "psionic-energy-dice") ?? itemOf(actor, this.PSIONIC);
  }

  static psionicDie(actor){
    const scale = actor?.system?.scale?.["psi-warrior"]?.die ?? actor?.system?.scale?.["psi-warrior"]?.["energy-die"];
    return scale?.formula ? `1d${scale.faces ?? String(scale.formula).replace(/^\d*d/, "")}` : (scale?.faces ? `1d${scale.faces}` : "1d6");
  }

  /* This user's Psi Warriors that can shield that creature : within 30 ft, seeing it (or it), Reaction and a die left */
  /* Protective Field on a save card : each creature its damage reaches (all its targets : half on a success still hurts) */
  static saveFieldButtons(message, buttons){
    if(!this.enabled() || (message.type !== TYPES.save) || !message.system?.dealsDamage) return;
    const key = `${message.id}|null`;
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    for(const t of (message.system.targets ?? []).map(x => tokenOf(TargetsField.resolve(x)?.token)).filter(Boolean)){
      if(this.#done.has(`f|${key}|${t.id}`)) continue;
      for(const guard of this.fieldGuards(t)) buttons.push({ id : `field|${guard.document.uuid}|${t.document.uuid}`, icon : "fa-brain",
        label : module.format("subclasses.fighter.field", { name : t.name }) });
    }
  }

  static fieldGuards(token){
    if(!this.enabled()) return [];
    return (canvas.tokens?.placeables ?? []).filter(g => g.actor?.isOwner && itemOf(g.actor, "protective-field")
      && ((g === token) || ((distanceBetween(g, token) <= 30) && canSee(g, token))) && actionTracker.left(g.actor, "reaction")
      && (Number(this.psionicOf(g.actor)?.system?.uses?.value) > 0));
  }

  static async field(message, guard, target, key){
    if(!guard || !target || this.#done.has(`f|${key}|${target.id}`)) return;
    const actor = guard.actor;
    const item = itemOf(actor, "protective-field");
    if(!await spendUses(this.psionicOf(actor), 1)) return;
    this.#done.add(`f|${key}|${target.id}`);
    const roll = await new Roll(`max(1, ${this.psionicDie(actor)} + @abilities.int.mod)`, actor.getRollData()).evaluate();
    const { rollItem } = await import('../../roll-item/roll-item.js');
    await rollItem.showDice([roll], message);
    await cutDamage(message, target, { id : "protective-field", amount : roll.total, by : guard.name, label : item?.name ?? "Protective Field", formula : roll.formula, result : roll.result });
    await actionTracker.spend(actor, { kind : "reaction", what : item?.name ?? "" }).catch(() => null);
  }

  /* Telekinetic Movement : a willing creature you see within 30 ft, up to 30 ft to a space you pick */
  static async telekinetic(actor, item){
    const me = tokenOf(actor);
    const [target] = await pickTargets(me, { count : 1, range : 30, disposition : "any", confirm : "auto", useTargets : false, filter : t => t !== me }) ?? [];
    if(!target) return;
    const space = await pickSpace(target, { range : 30, size : Math.max(1, Math.round(target.document.width ?? 1)), notice : item.name });
    if(space) await this.moveTo(actor, target, space, item);
  }

  /* ---------- Eldritch Knight : War Bond ---------- */

  static bonded(actor, bond){
    return actor.items.filter(i => (i.type === "weapon") && i.effects.some(e => !e.disabled && ((e.origin?.startsWith?.(bond.uuid)) || /war bond/i.test(e.name))));
  }

  /* Summon Weapon : a bonded weapon to your hand */
  static async summonBonded(actor, activity){
    if(activity.type === "enchant") return;
    const weapons = this.bonded(actor, activity.item);
    if(!weapons.length) return ui.notifications.warn(module.format("subclasses.fighter.noBond", { name : actor.name }));
    const uuid = (weapons.length === 1) ? weapons[0].uuid : await chooseOne(weapons.map(w => ({ value : w.uuid, label : w.name, img : w.img })), { title : activity.item.name, icon : "fa-solid fa-hand-sparkles" });
    const weapon = uuid ? actor.items.find(i => i.uuid === uuid) : null;
    if(!weapon) return;
    if(hands.manages(actor)){
      const slot = hands.freeHand(actor, weapon);
      if(!slot) return ui.notifications.warn(module.format("subclasses.fighter.noHand", { name : actor.name, item : weapon.name }));
      await hands.put(actor, weapon, slot);
    }
    else await weapon.update({ "system.equipped" : true });
  }
}
