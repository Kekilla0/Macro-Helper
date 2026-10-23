import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { idOf, originItem, esc, ownerIds, chooseOption, buttonRow, addButton, makeButton } from '../../helpers/utils.js';
import { slotsLeft, usedThisTurn, markUsedThisTurn } from '../../helpers/actors.js';
import { pickTargets } from '../../helpers/targets.js';
import { distanceBetween, tokenOf, getTokensWithin, hasLineOfSight } from '../../helpers/tokens.js';
import { conditions } from '../conditions.js';
import { damageRoll } from '../../roll-item/extra-damage.js';
import { gm } from '../../gm.js';
import { uses } from '../../uses.js';
import { itemFixes } from '../item-fixes.js';
import { limits } from '../limits.js';
import { actions } from '../actions.js';
import { masteries } from '../masteries.js';
import { endCondition } from '../../roll-item/card-builder.js';
import { TYPES } from '../../roll-item/message.js';
import { casting } from '../casting.js';
import { spellActions } from '../spell-actions.js';
import { actionTracker } from '../action-tracker.js';
const log = logger.for(import.meta.url);

/**
 * Paladin, levels 1-2 (Classes setting). Weapon Mastery is automation/weapon-mastery.js; the Fighting Style is
 * automation/fighting-styles.js (swapped in Rest Choices).
 *
 *   Smites          : after a melee weapon or Unarmed Strike hit, its owner's attack card has a Smite button : the smite
 *                     spells prepared (Divine Smite, Wrathful, Thunderous, Searing...), each with what can pay for it :
 *                     Paladin's Smite (Divine Smite only, its use left) or a spell slot of the spell's level or higher.
 *                     The damage goes on the card as its own box (crits like the attack); Divine Smite : 2d8 radiant,
 *                     +1d8 a slot level above 1st, +1d8 against a Fiend or Undead. Wrathful (Frightened) and Thunderous
 *                     (pushed, Prone) put their save on the card for the target (a failed Thunderous save : the GM's
 *                     Push button); concentration starts for any that need it (none of the 2024 ones do). Searing's burning each turn waits for the spell batch. Once per attack; a second
 *                     smite in a turn (a Bonus Action) follows Rule Limits. Using a smite spell or Paladin's Smite from
 *                     the sheet smites the latest melee hit instead (Plutonium makes them Actions with their own damage).
 *                     The Ranger's spells that follow a weapon hit work the same way (the button says Strike when only
 *                     they apply) : Ensnaring Strike (any weapon hit : its STR save on the card), Hail of Thorns (a
 *                     ranged weapon hit : a DEX save for everyone within 5 ft of the target, on the hit's card).
 *   Lay on Hands    : both activities reach a creature you touch (picked on the map). Remove Poison ends Poisoned (the
 *                     end-condition lego) : at once on a creature you own; on anyone else, the GM's button on a card.
 *   Divine Sense    : (level 3, Channel Divinity's uses are the item's data) using it tells the Paladin's owner, in a
 *                     card only they and the GM see, the Celestials, Fiends and Undead within 60 ft not behind total
 *                     cover : their creature type and how far, and pings each on their map only. Sense Again on the
 *                     card while it lasts. It ends when the Paladin is Incapacitated.
 */
export class paladin{
  static SMITES = ["divine-smite", "searing-smite", "thunderous-smite", "wrathful-smite", "shining-smite", "blinding-smite", "staggering-smite", "banishing-smite",
    "ensnaring-strike", "hail-of-thorns"];
  /* The hit each needs : a melee weapon hit unless said (any weapon, a ranged weapon) */
  static HIT_NEEDS = { "ensnaring-strike" : "any", "hail-of-thorns" : "ranged" };
  /* No damage onto the hit's card : a save instead (on the card, or around the target) */
  static NO_HIT_DAMAGE = ["ensnaring-strike", "hail-of-thorns"];
  /* A save for everyone around the target (feet), its own card */
  static AROUND_TARGET = { "hail-of-thorns" : 5 };
  static DIVINE = "divine-smite";
  static PALADINS_SMITE = "paladins-smite";
  static LAY_ON_HANDS = "lay-on-hands";
  /* Smites whose save happens on the hit (the rest : ongoing saves, the spell batch) */
  static RIDERS = ["wrathful-smite", "thunderous-smite", "ensnaring-strike"];
  static UNHOLY = ["fiend", "undead"];
  static DIVINE_SENSE = "divine-sense";
  static SENSED = ["celestial", "fiend", "undead"];

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, context) => this.cardButtons(message, buttons, context));
    gm.handle("paladinSmiteCard", (data, user) => this.smiteCardAsGM(data, user));
    /* A smite on the card : its spell's face (name and rules) under the weapon's, like the spell's own card */
    Hooks.on(`${module.id}.cardFaces`, (message, faces) => this.smiteFaces(message, faces));
    Hooks.on(`${module.id}.cardMoves`, (message, uuid, moves, { result } = {}) => this.pushMove(message, moves, result));
    Hooks.on(`${module.id}.cardButton`, (message, id, context) => {
      if(id === "smite") this.smite(message, context?.ray ?? null);
    });
    /* A smite spell (or Paladin's Smite) used from the sheet : the latest melee hit */
    uses.onItem("smite", (item, ctx, next) => {
      if(!this.enabled() || !this.isSmiteSource(item)) return next();
      return this.smiteFromSheet(item);
    });
    /* Lay on Hands : Remove Poison picks who it touches (it has no effect for Roll Item to aim) */
    uses.onActivity("layOnHands", async (activity, ctx, next) => {
      if(!this.enabled() || !this.isRemovePoison(activity)) return next();
      const [target] = await pickTargets(activity.item, { count : 1, range : canvas.scene?.grid.distance ?? 5, disposition : "any", includeSelf : true, confirm : "auto" });
      if(!target) return;
      uses.mark(ctx, { poisonTarget : target.document.uuid });
      return next();
    });
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.onUse(activity, usage, results));
    /* Divine Sense */
    conditions.endOnIncapacitated(this.DIVINE_SENSE);
    Hooks.on("dnd5e.postUseActivity", activity => { if(this.enabled() && (idOf(activity?.item) === this.DIVINE_SENSE)) this.divineSense(activity.getUsageToken?.()?.actor ?? activity.actor); });
    Hooks.on("renderChatMessageHTML", (message, html) => this.senseButton(message, html));
    Hooks.on("dnd5e.restCompleted", (actor, result) => {
      if(result?.longRest && actor?.isOwner && actor.getFlag(module.id, "paladinsSmiteUsed")) actor.unsetFlag(module.id, "paladinsSmiteUsed");
    });
    /* Plutonium's Lay on Hands has no range : a creature you touch */
    itemFixes.add({ name : "Lay on Hands", where : "owned", plan : item => this.layOnHandsFix(item) });
    /* Plutonium's Paladin's Smite keeps its use on its cast activity too : one use, the item's (as Favored Enemy has it),
       so its Divine Smite shows it in the spellbook */
    itemFixes.add({ name : "Paladin's Smite", where : "owned", plan : item => this.smiteFix(item) });
    itemFixes.add({ name : "Divine Smite class", where : "owned", plan : item => this.divineSmiteFix(item) });
  }

  /* ---------- Smites ---------- */

  static isSmiteSource(item){
    return ((item?.type === "spell") && this.SMITES.includes(idOf(item))) || (idOf(item) === this.PALADINS_SMITE);
  }

  /* The smite spells an actor can cast now (prepared, always prepared, or not needing preparation), one per spell */
  static smiteSpells(actor){
    const found = new Map();
    for(const spell of actor?.items?.filter?.(i => (i.type === "spell") && this.SMITES.includes(idOf(i))) ?? []){
      const ready = (Number(spell.system.prepared) > 0) || !spell.system.canPrepare;
      const have = found.get(idOf(spell));
      if(!have || (ready && !have.ready)) found.set(idOf(spell), { spell, ready });
    }
    return [...found.values()].filter(f => f.ready).map(f => f.spell).sort((a, b) => (a.system.level - b.system.level) || a.name.localeCompare(b.name));
  }

  /* Paladin's Smite's free casting of Divine Smite, while its use is left : the item's (the one the sheet shows; Plutonium
     also gives its activity one, used only when the item has none) */
  static freeSmite(actor){
    const item = actor?.items?.find?.(i => idOf(i) === this.PALADINS_SMITE);
    if(!item) return null;
    if(item.system.uses?.max) return (Number(item.system.uses.value) > 0) ? { item, activity : null } : null;
    const activity = item.system.activities?.find?.(a => a.uses?.max) ?? null;
    if(activity) return (Number(activity.uses.value) > 0) ? { item, activity } : null;
    /* dnd5e's own : the use is on the Divine Smite it grants (once a Long Rest, with its "free casting" activity) */
    const granted = actor.items.find(i => (i.type === "spell") && (idOf(i) === this.DIVINE) && (Number(i.system.uses?.max) > 0));
    if(granted) return (Number(granted.system.uses.value) > 0) ? { item : granted, activity : null } : null;
    /* No uses anywhere : once a Long Rest, counted on the actor */
    return actor.getFlag(module.id, "paladinsSmiteUsed") ? null : { item, activity : null, counted : true };
  }

  /* The spell slots left at a level or higher : { key : "spell2", level, value } (Pact Magic too) */
  static slotsFrom(actor, level){
    return slotsLeft(actor, level);
  }

  /* A weapon hit on the card : "melee" or "ranged" (a thrown weapon : ranged), null when it isn't one */
  static hitKind(message, ray){
    const card = message?.system;
    if((message?.type !== TYPES.attack) || !card?.isHitOn?.(ray)) return null;
    const activity = message.getAssociatedActivity?.();
    if((activity?.type !== "attack") || (activity.item?.type !== "weapon")) return null;
    const type = String(activity.getActionType?.(card.attackOf(ray)?.options?.attackMode) ?? "");
    return type.startsWith("m") ? "melee" : type.startsWith("r") ? "ranged" : null;
  }

  /* Can this spell follow that kind of hit ? */
  static fits(spell, kind){
    if(!kind) return false;
    const need = this.HIT_NEEDS[idOf(spell)] ?? "melee";
    return (need === "any") || (need === kind);
  }

  /* Every way to smite now : [{ value, label, spell, level, slot | free }] (for a kind of hit : the spells that fit it) */
  static choicesFor(actor, { only = null, freeOnly = false, kind = null } = {}){
    const out = [];
    for(const spell of this.smiteSpells(actor)){
      if(only && (idOf(spell) !== only)) continue;
      if(kind && !this.fits(spell, kind)) continue;
      const level = Number(spell.system.level) || 1;
      if((idOf(spell) === this.DIVINE) && this.freeSmite(actor)){
        out.push({ value : `${spell.id}|free`, label : module.format("classes.paladin.smiteFree", { spell : spell.name }), spell, level : 1, free : true });
      }
      if(freeOnly) continue;
      for(const slot of this.slotsFrom(actor, level)){
        out.push({ value : `${spell.id}|${slot.key}`, spell, level : slot.level, slot,
          label : module.format(slot.pact ? "classes.paladin.smitePact" : "classes.paladin.smiteSlot", { spell : spell.name, level : slot.level, left : slot.value }) });
      }
    }
    return out;
  }

  /* A melee weapon (or Unarmed Strike) attack that hit, on this card */
  static meleeHit(message, ray){
    const card = message?.system;
    if((message?.type !== TYPES.attack) || !card?.isHitOn?.(ray)) return false;
    const activity = message.getAssociatedActivity?.();
    if((activity?.type !== "attack") || (activity.item?.type !== "weapon")) return false;
    const mode = card.attackOf(ray)?.options?.attackMode;
    return String(activity.getActionType?.(mode) ?? "").startsWith("m");
  }

  static smiteFaces(message, faces){
    const ids = Object.values(message?.getFlag?.(module.id, "smite") ?? {});
    const actor = ids.length ? message.getAssociatedActor?.() : null;
    for(const id of new Set(ids)){
      const spell = actor?.items?.get(id);
      if(spell && !faces.some(f => f.uuid === spell.uuid)) faces.push({ uuid : spell.uuid });
    }
  }

  static smitten(message, ray){
    return !!message.getFlag(module.id, `smite.${masteries.rayKey(ray)}`);
  }

  static cardButtons(message, buttons, { ray } = {}){
    if(!this.enabled()) return;
    /* The card's roller, or the character's owner (the GM rolled for them : the card's part goes through the GM) */
    const actor = message.getAssociatedActor?.();
    if(!message.isOwner && !(actor?.isOwner && !game.user.isGM)) return;
    const kind = this.hitKind(message, ray);
    if(!actor?.isOwner || !kind || this.smitten(message, ray)) return;
    const choices = this.choicesFor(actor, { kind });
    if(!choices.length) return;
    /* A smite is a Bonus Action : only on its own turn (not an Opportunity Attack or a readied attack), one left */
    if(this.offTurn(actor) || !actionTracker.left(actor, "bonus")) return;
    /* Only the Ranger's strikes apply : "Strike" */
    const smite = choices.some(c => !this.HIT_NEEDS[idOf(c.spell)]);
    buttons.push({ id : "smite", label : module.i18n(smite ? "classes.paladin.smite" : "classes.paladin.strike"), icon : smite ? "fa-sun" : "fa-crosshairs" });
  }

  /* In a started combat, someone else's turn */
  static offTurn(actor){
    const combat = game.combat;
    if(!combat?.started || !combat.combatant) return false;
    const current = combat.combatant.actor;
    return !!current && (current !== actor) && (current.uuid !== actor?.uuid);
  }

  /* The creature the attack hit (its Fiend / Undead die) */
  static targetOf(message, ray){
    return message.system.hitTargets?.(ray)?.[0] ?? null;
  }

  /**
   * A smite's extra damage at a slot level : its first damage part (a damage activity's, else its save's), scaled.
   * @returns {{ formula : string, type : string }|null}
   */
  static damageOf(spell, level, target){
    const extra = Math.max(0, level - (Number(spell.system.level) || 1));
    if(idOf(spell) === this.DIVINE){
      const unholy = this.UNHOLY.includes(target?.actor?.system?.details?.type?.value);
      return { formula : `${2 + extra + (unholy ? 1 : 0)}d8`, type : "radiant" };
    }
    const activities = spell.system.activities?.contents ?? [];
    const withDamage = a => a.damage?.parts?.some?.(p => p.number && p.denomination);
    const activity = activities.find(a => (a.type === "damage") && withDamage(a)) ?? activities.find(withDamage);
    const part = activity?.damage.parts.find(p => p.number && p.denomination);
    if(!part) return null;
    const number = part.number + (extra * (Number(part.scaling?.number) || 1));
    return { formula : `${number}d${part.denomination}`, type : [...(part.types ?? [])][0] ?? "" };
  }

  /**
   * Smite this card's hit : choose what to cast and how to pay, then its damage on the card.
   * @param {ChatMessage} message
   * @param {number|null} ray
   * @param {object} [options]
   * @param {string} [options.only]       one spell (from the sheet)
   * @param {boolean} [options.freeOnly]  Paladin's Smite (from the sheet)
   */
  static async smite(message, ray, { only = null, freeOnly = false } = {}){
    const actor = message.getAssociatedActor?.();
    const kind = this.hitKind(message, ray);
    if(!this.enabled() || !actor?.isOwner || !kind || this.smitten(message, ray)) return false;
    const choices = this.choicesFor(actor, { only, freeOnly, kind });
    if(!choices.length){
      ui.notifications.warn(module.format("classes.paladin.noSmite", { name : actor.name }));
      return false;
    }
    const value = await chooseOption({ title : module.i18n("classes.paladin.smite"), icon : "fa-solid fa-sun",
      prompt : module.i18n("classes.paladin.smitePrompt"), options : choices.map(c => ({ value : c.value, label : c.label })) });
    const choice = choices.find(c => c.value === value);
    if(!choice) return false;
    /* Its components, and one slot a turn (Casting) */
    if(!casting.allowsCast(choice.spell, { slot : !choice.free })) return false;
    /* A Bonus Action : one a turn */
    if(usedThisTurn(actor, "smite") && !limits.allow(module.format("classes.paladin.smiteUsed", { name : actor.name }), { who : actor.name, what : choice.spell.name })) return false;
    if(!actionTracker.left(actor, "bonus") && !limits.allow(module.format("actionTracker.spent", { name : actor.name, kind : actionTracker.label("bonus") }), { who : actor.name, what : choice.spell.name })) return false;

    const target = this.targetOf(message, ray);
    const damage = this.NO_HIT_DAMAGE.includes(idOf(choice.spell)) ? null : this.damageOf(choice.spell, choice.level, target);
    let roll = null;
    if(damage){
      roll = await damageRoll(damage.formula, { type : damage.type, crit : !!message.system.attackOf(ray)?.isCritical, magical : true });
    }
    /* The card's part : here when it's this user's card, else the GM's client (the GM rolled the attack for them) */
    const card = { message : message.id, ray, spell : choice.spell.id, level : choice.level, formula : damage?.formula ?? null, roll : roll ? roll.toJSON() : null };
    if(message.isOwner) await this.writeCard(card);
    else if(!await gm.run("paladinSmiteCard", card)) return false;
    await this.pay(actor, choice);
    await markUsedThisTurn(actor, "smite");
    await actionTracker.spend(actor, { kind : "bonus", what : choice.spell.name }).catch(error => log.debug(error));
    /* Concentration (Wrathful, Searing...) : on the spell, as if cast */
    if(choice.spell.system.properties?.has?.("concentration")){
      const activity = choice.spell.system.activities?.contents?.[0];
      if(activity) await actor.beginConcentrating(activity).catch(error => log.error(error));
    }
    log.debug("Smite", actor.name, choice.spell.name, choice.level, damage?.formula);
    /* For the rules that follow a smite (Inspiring Smite) : Hooks "macro-helper.smite" (actor, spell, message) */
    Hooks.callAll(`${module.id}.smite`, actor, choice.spell, message);
    return true;
  }

  /* The smite on the card : its damage, the smitten mark, its save (Wrathful...) or its burst (Hail of Thorns) */
  static async writeCard({ message : id, ray = null, spell : spellId, level, formula = null, roll = null } = {}){
    const message = game.messages.get(id);
    const actor = message?.getAssociatedActor?.();
    const spell = actor?.items?.get(spellId);
    if(!message || !spell) return false;
    if(roll){
      const damage = CONFIG.Dice.DamageRoll.fromData(roll);
      await message.system.addDamage([damage], { key : "smite", ray, formula,
        label : module.format("classes.paladin.smiteLabel", { spell : spell.name, level }) });
    }
    await message.setFlag(module.id, `smite.${masteries.rayKey(ray)}`, spell.id);
    await this.rider(message, spell);
    /* Hail of Thorns : everyone within 5 ft of the target saves, on this card (its save and damage, like Ice Knife's) */
    const around = this.AROUND_TARGET[idOf(spell)];
    const target = this.targetOf(message, ray);
    if(around && target) await this.aroundRider(message, spell, level, target, around);
    return true;
  }

  /* GM : a player's smite on a card the GM rolled for their character */
  static async smiteCardAsGM(data = {}, user){
    const message = game.messages.get(data.message);
    const actor = message?.getAssociatedActor?.();
    if(!actor || !(user.isGM || actor.testUserPermission(user, "OWNER")) || this.smitten(message, data.ray ?? null)) return false;
    return this.writeCard(data);
  }

  /* The free use or the slot */
  static async pay(actor, choice){
    if(choice.free){
      const free = this.freeSmite(actor);
      if(free?.counted) return actor.setFlag(module.id, "paladinsSmiteUsed", true);
      if(free?.activity) return free.item.update({ [`system.activities.${free.activity.id}.uses.spent`] : (Number(free.activity.uses.spent) || 0) + 1 });
      if(free) return free.item.update({ "system.uses.spent" : (Number(free.item.system.uses.spent) || 0) + 1 });
      return;
    }
    await casting.spendSlot(actor, choice.slot.key);
  }

  /* Wrathful and Thunderous : their save on the card, for the creatures hit (one save per card : an item's own rider stays) */
  static async rider(message, spell){
    if(!this.RIDERS.includes(idOf(spell)) || message.system.rider?.id) return;
    const save = spell.system.activities?.find?.(a => a.type === "save");
    if(!save) return;
    await message.update({ "system.rider" : { id : save.id, item : spell.uuid, ability : save.save?.ability?.first?.() ?? "",
      dc : Number.isFinite(save.save?.dc?.value) ? save.save.dc.value : null, onSave : null } });
  }

  /* A save for the target and everyone within some feet of it, on the hit's card : the spell's save as the card's own,
     with its creatures, its damage rolled at the slot's level onto the card, the burst shown on the map */
  static async aroundRider(message, spell, level, target, feet){
    const save = spell.system.activities?.find?.(a => a.type === "save");
    const token = target?.object ?? target;
    if(!save || !token?.document) return;
    const scene = token.document.parent;
    const targets = scene.tokens.filter(t => t.actor && t.object && ((t === token.document) || (distanceBetween(t.object, token) <= feet))).map(t => t.uuid);
    const rolls = [];
    for(const part of save.damage?.parts ?? []){
      const formula = part.scaledFormula?.(Math.max(0, (Number(level) || 1) - (Number(spell.system.level) || 1)), { rollData : save.getRollData?.() ?? {} }) ?? part.formula;
      if(!formula) continue;
      const type = part.types?.first?.() ?? [...(part.types ?? [])][0] ?? "";
      const roll = await new CONFIG.Dice.DamageRoll(formula, save.getRollData?.() ?? {}, { type, types : [type], properties : ["mgc"] }).evaluate();
      roll.options[module.id] = { part : "save" };
      rolls.push(roll);
    }
    await message.update({
      "system.rider" : { id : save.id, item : spell.uuid, ability : save.save?.ability?.first?.() ?? "",
        dc : Number.isFinite(save.save?.dc?.value) ? save.save.dc.value : null, onSave : save.damage?.onSave ?? null, targets },
      ...(rolls.length ? { rolls : [...message.rolls, ...rolls].map(r => JSON.stringify(r)) } : {}),
    });
    const radius = (feet / scene.grid.distance) * scene.grid.size + (Math.max(token.w, token.h) / 2);
    gm.run("areaRegion", { scene : scene.id, name : spell.name, color : game.user.color?.css ?? "#ffd700",
      x : token.center.x, y : token.center.y, radius, activity : save.uuid, origin : (message.getAssociatedToken?.() ?? token.document).uuid }).catch(error => log.debug(error));
  }

  /* Thunderous Smite : a creature that failed its save is pushed 10 ft away (the GM's button; Prone is the save's effect) */
  static PUSHES = { "thunderous-smite" : 10 };

  static pushOf(message){
    const rider = message.system?.rider;
    const spell = rider?.item ? fromUuidSync(rider.item, { strict : false }) : null;
    return spell ? (this.PUSHES[idOf(spell)] ?? 0) : 0;
  }

  /* A creature that failed its save : the GM's push (card moves) */
  static pushMove(message, moves, result){
    if(!this.enabled() || (message.type !== TYPES.attack) || (result?.success !== false)) return;
    const feet = this.pushOf(message);
    if(feet) moves.push({ id : "smitePush", feet, name : fromUuidSync(message.system.rider.item, { strict : false })?.name });
  }

  /* From the sheet : the latest attack card of this actor (among the last messages) with a melee hit not yet smitten */
  static latestHit(actor, spellId = null){
    const recent = game.messages.contents.slice(-15).reverse();
    for(const message of recent){
      if((message.type !== TYPES.attack) || (message.getAssociatedActor?.()?.id !== actor.id)) continue;
      const rays = message.system.isMulti ? message.system.rays.map((_, i) => i) : [null];
      const ray = rays.find(r => (spellId ? this.fits({ system : { identifier : spellId } }, this.hitKind(message, r)) : this.meleeHit(message, r)) && !this.smitten(message, r));
      if(ray !== undefined) return { message, ray };
      return null;
    }
    return null;
  }

  static async smiteFromSheet(item){
    const actor = item.actor;
    const hit = actor && this.latestHit(actor, (item.type === "spell") ? idOf(item) : null);
    if(!hit){
      ui.notifications.warn(module.format("classes.paladin.noHit", { name : actor?.name ?? "", item : item.name }));
      return null;
    }
    const free = idOf(item) === this.PALADINS_SMITE;
    const done = await this.smite(hit.message, hit.ray, { only : free ? this.DIVINE : idOf(item), freeOnly : free });
    return done ? hit.message : null;
  }

  static smiteFix(item){
    if(idOf(item) !== this.PALADINS_SMITE) return null;
    const update = {};
    for(const activity of item.system.activities ?? []){
      const targets = activity.consumption?.targets ?? [];
      if(!activity.uses?.max && !targets.some(t => t.type === "activityUses")) continue;
      update[`system.activities.${activity.id}.uses`] = { max : "", spent : 0, recovery : [] };
      update[`system.activities.${activity.id}.consumption.targets`] = [...targets.filter(t => t.type !== "activityUses"), { type : "itemUses", value : "1", target : "", scaling : {} }];
    }
    if(!Object.keys(update).length) return null;
    if(!item.system.uses?.max){
      update["system.uses.max"] = "1";
      update["system.uses.recovery"] = [{ period : "lr", type : "recoverAll" }];
    }
    return { update };
  }

  /* Paladin's Smite's Divine Smite comes with no class : the Paladin's (Prepared Spells lists it) */
  static divineSmiteFix(item){
    if((item.type !== "spell") || (idOf(item) !== this.DIVINE) || item.system.sourceItem || !item.parent?.classes?.paladin) return null;
    return { update : { "system.sourceItem" : "class:paladin" } };
  }

  /* ---------- Lay on Hands ---------- */

  static isRemovePoison(activity){
    return (idOf(activity?.item) === this.LAY_ON_HANDS) && (activity.type === "utility");
  }

  /* Both activities : a creature you touch */
  static layOnHandsFix(item){
    if(idOf(item) !== this.LAY_ON_HANDS) return null;
    const update = {};
    for(const activity of item.system.activities ?? []){
      if(activity.range?.override || !["", "self", undefined, null].includes(activity.range?.units)) continue;
      update[`system.activities.${activity.id}.range`] = { override : true, units : "touch" };
    }
    return Object.keys(update).length ? { update } : null;
  }

  /* Remove Poison : the end-condition lego (at once on a creature you own; anyone else's : the GM's button on a card) */
  static async onUse(activity, usage, results){
    if(!this.enabled() || !this.isRemovePoison(activity) || !activity.actor?.isOwner) return;
    const target = fromUuidSync(usage?.[module.id]?.poisonTarget ?? "", { strict : false });
    if(!target?.actor) return;
    const { ended } = await endCondition(target, "poisoned", { from : activity.item, by : activity.actor });
    if(ended) await actions.autoApplied(results);
  }

  /* ---------- Divine Sense ---------- */

  static senseEffect(actor){
    return [...(actor?.appliedEffects ?? [])].find(e => idOf(originItem(e)) === this.DIVINE_SENSE) ?? null;
  }

  /* The creatures it senses : their type and distance, a ping each on this user's map */
  static async divineSense(actor){
    const token = tokenOf(actor);
    if(!token || !actor?.isOwner) return;
    const sensed = getTokensWithin(token, 60, { includeHidden : true, includeDead : true,
      filter : t => this.SENSED.includes(t.actor?.system?.details?.type?.value) && hasLineOfSight(token, t) });
    const lines = sensed.map(t => {
      const type = CONFIG.DND5E.creatureTypes?.[t.actor.system.details.type.value]?.label ?? t.actor.system.details.type.value;
      return `<li>${esc(game.i18n.localize(type))} : ${Math.round(distanceBetween(token, t))} ft</li>`;
    });
    for(const t of sensed){
      canvas.controls?.handlePing?.(game.user, t.center, { scene : canvas.scene?.id, style : CONFIG.Canvas.pings.types.PULSE, zoom : canvas.stage.scale.x });
    }
    await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor }),
      whisper : [...new Set([...ownerIds(actor), ...game.users.filter(u => u.isGM).map(u => u.id)])],
      content : `<p><i class="fa-solid fa-eye" inert></i> ${esc(module.format("classes.paladin.sense", { name : actor.name }))}</p>`
        + (lines.length ? `<ul>${lines.join("")}</ul>` : `<p>${esc(module.i18n("classes.paladin.senseNone"))}</p>`),
      flags : { [module.id] : { divineSense : actor.uuid } },
    });
  }

  /* Sense Again (its owner, while it lasts) */
  static senseButton(message, html){
    const uuid = message.getFlag?.(module.id, "divineSense");
    const actor = uuid ? fromUuidSync(uuid, { strict : false }) : null;
    if(!actor?.isOwner || !this.senseEffect(actor) || (message.id !== game.messages.contents.findLast(m => m.getFlag(module.id, "divineSense") === uuid)?.id)) return;
    const row = buttonRow(html, { key : `${module.id}-divine-sense` });
    if(row.childElementCount) return;
    addButton(row, makeButton({ icon : "fa-eye", text : module.i18n("classes.paladin.senseAgain"), once : true, onClick : () => this.divineSense(actor) }));
  }
}
