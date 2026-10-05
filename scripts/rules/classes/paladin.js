import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { idOf, chooseOption, buttonRow, addButton, makeButton } from '../../helpers/utils.js';
import { usedThisTurn, markUsedThisTurn, setStatus } from '../../helpers/actors.js';
import { pickTargets } from '../../helpers/targets.js';
import { pushAway } from '../../helpers/tokens.js';
import { uses } from '../../uses.js';
import { itemFixes } from '../item-fixes.js';
import { limits } from '../limits.js';
import { actions } from '../actions.js';
import { masteries } from '../../roll-item/masteries.js';
import { TYPES } from '../../roll-item/message.js';
const log = logger.for(import.meta.url);

/**
 * Paladin, levels 1-2 (Classes setting). Weapon Mastery is rules/weapon-mastery.js; the Fighting Style is
 * rules/fighting-styles.js (swapped in Rest Choices).
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
 *   Lay on Hands    : both activities reach a creature you touch (picked on the map). Remove Poison ends Poisoned on a
 *                     creature you own; on anyone else the GM gets an End Poisoned button on the card.
 */
export class paladin{
  static SMITES = ["divine-smite", "searing-smite", "thunderous-smite", "wrathful-smite", "shining-smite", "blinding-smite", "staggering-smite", "banishing-smite"];
  static DIVINE = "divine-smite";
  static PALADINS_SMITE = "paladins-smite";
  static LAY_ON_HANDS = "lay-on-hands";
  /* Smites whose save happens on the hit (the rest : ongoing saves, the spell batch) */
  static RIDERS = ["wrathful-smite", "thunderous-smite"];
  static UNHOLY = ["fiend", "undead"];

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, context) => { this.cardButtons(message, buttons, context); this.pushButtons(message, buttons, context); });
    Hooks.on(`${module.id}.cardButton`, (message, id, context) => {
      if(id === "smite") this.smite(message, context?.ray ?? null);
      if(id?.startsWith?.("smitePush|")) this.push(message, id.split("|")[1]);
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
    Hooks.on("renderChatMessageHTML", (message, html) => this.poisonButton(message, html));
    /* Plutonium's Lay on Hands has no range : a creature you touch */
    itemFixes.add({ name : "Lay on Hands", where : "owned", plan : item => this.layOnHandsFix(item) });
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
    return (activity && (Number(activity.uses.value) > 0)) ? { item, activity } : null;
  }

  /* The spell slots left at a level or higher : { key : "spell2", level, value } (Pact Magic too) */
  static slotsFrom(actor, level){
    const spells = actor?.system?.spells ?? {};
    const out = [];
    for(let l = Math.max(1, level); l <= 9; l++){
      const slot = spells[`spell${l}`];
      if((Number(slot?.value) > 0) && (Number(slot?.max) > 0)) out.push({ key : `spell${l}`, level : l, value : Number(slot.value) });
    }
    const pact = spells.pact;
    if((Number(pact?.value) > 0) && (Number(pact?.level) >= level)) out.push({ key : "pact", level : Number(pact.level), value : Number(pact.value), pact : true });
    return out;
  }

  /* Every way to smite now : [{ value, label, spell, level, slot | free }] */
  static choicesFor(actor, { only = null, freeOnly = false } = {}){
    const out = [];
    for(const spell of this.smiteSpells(actor)){
      if(only && (idOf(spell) !== only)) continue;
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

  static smitten(message, ray){
    return !!message.getFlag(module.id, `smite.${masteries.rayKey(ray)}`);
  }

  static cardButtons(message, buttons, { ray } = {}){
    if(!this.enabled() || !message.isOwner) return;
    const actor = message.getAssociatedActor?.();
    if(!actor?.isOwner || !this.meleeHit(message, ray) || this.smitten(message, ray)) return;
    if(!this.choicesFor(actor).length) return;
    buttons.push({ id : "smite", label : module.i18n("classes.paladin.smite"), icon : "fa-sun" });
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
    if(!this.enabled() || !actor?.isOwner || !this.meleeHit(message, ray) || this.smitten(message, ray)) return false;
    const choices = this.choicesFor(actor, { only, freeOnly });
    if(!choices.length){
      ui.notifications.warn(module.format("classes.paladin.noSmite", { name : actor.name }));
      return false;
    }
    const value = await chooseOption({ title : module.i18n("classes.paladin.smite"), icon : "fa-solid fa-sun",
      prompt : module.i18n("classes.paladin.smitePrompt"), options : choices.map(c => ({ value : c.value, label : c.label })) });
    const choice = choices.find(c => c.value === value);
    if(!choice) return false;
    /* A Bonus Action : one a turn */
    if(usedThisTurn(actor, "smite") && !limits.allow(module.format("classes.paladin.smiteUsed", { name : actor.name }), { who : actor.name, what : choice.spell.name })) return false;

    const target = this.targetOf(message, ray);
    const damage = this.damageOf(choice.spell, choice.level, target);
    if(damage){
      const isCritical = !!message.system.attackOf(ray)?.isCritical;
      const roll = await new CONFIG.Dice.DamageRoll(damage.formula, {}, { type : damage.type, types : [damage.type], isCritical, properties : ["mgc"] }).evaluate();
      await message.system.addDamage([roll], { key : "smite", ray,
        label : module.format("classes.paladin.smiteLabel", { spell : choice.spell.name, level : choice.level }) });
    }
    await message.setFlag(module.id, `smite.${masteries.rayKey(ray)}`, choice.spell.id);
    await this.pay(actor, choice);
    await markUsedThisTurn(actor, "smite");
    await this.rider(message, choice.spell);
    /* Concentration (Wrathful, Searing...) : on the spell, as if cast */
    if(choice.spell.system.properties?.has?.("concentration")){
      const activity = choice.spell.system.activities?.contents?.[0];
      if(activity) await actor.beginConcentrating(activity).catch(error => log.error(error));
    }
    log.debug("Smite", actor.name, choice.spell.name, choice.level, damage?.formula);
    return true;
  }

  /* The free use or the slot */
  static async pay(actor, choice){
    if(choice.free){
      const free = this.freeSmite(actor);
      if(free?.activity) return free.item.update({ [`system.activities.${free.activity.id}.uses.spent`] : (Number(free.activity.uses.spent) || 0) + 1 });
      if(free) return free.item.update({ "system.uses.spent" : (Number(free.item.system.uses.spent) || 0) + 1 });
      return;
    }
    const slot = actor.system.spells?.[choice.slot.key];
    if(slot) await actor.update({ [`system.spells.${choice.slot.key}.value`] : Math.max(0, Number(slot.value) - 1) });
  }

  /* Wrathful and Thunderous : their save on the card, for the creatures hit (one save per card : an item's own rider stays) */
  static async rider(message, spell){
    if(!this.RIDERS.includes(idOf(spell)) || message.system.rider?.id) return;
    const save = spell.system.activities?.find?.(a => a.type === "save");
    if(!save) return;
    await message.update({ "system.rider" : { id : save.id, item : spell.uuid, ability : save.save?.ability?.first?.() ?? "",
      dc : Number.isFinite(save.save?.dc?.value) ? save.save.dc.value : null, onSave : null } });
  }

  /* Thunderous Smite : a creature that failed its save is pushed 10 ft away (the GM's button; Prone is the save's effect) */
  static PUSHES = { "thunderous-smite" : 10 };

  static pushOf(message){
    const rider = message.system?.rider;
    const spell = rider?.item ? fromUuidSync(rider.item, { strict : false }) : null;
    return spell ? (this.PUSHES[idOf(spell)] ?? 0) : 0;
  }

  static pushButtons(message, buttons, { ray } = {}){
    if(!game.user.isGM || !this.enabled() || Number.isInteger(ray) || !this.pushOf(message)) return;
    for(const [uuid, outcome] of message.system.outcomes ?? []){
      if((outcome !== "failure") || message.getFlag(module.id, `pushed.${uuid.replaceAll(".", "-")}`)) continue;
      const token = fromUuidSync(uuid, { strict : false });
      if(token) buttons.push({ id : `smitePush|${uuid}`, icon : "fa-arrows-left-right", label : module.format("classes.paladin.push", { name : token.name, feet : this.pushOf(message) }) });
    }
  }

  static async push(message, uuid){
    if(!game.user.isGM) return;
    const token = fromUuidSync(uuid, { strict : false })?.object;
    const from = message.getAssociatedToken?.()?.object ?? message.getAssociatedActor?.()?.getActiveTokens?.()?.[0];
    if(!token || !from) return;
    const moved = await pushAway(token, from, this.pushOf(message));
    if(!moved) ui.notifications.info(module.format("rollItem.mastery.blocked", { name : token.name }));
    await message.setFlag(module.id, `pushed.${uuid.replaceAll(".", "-")}`, true);
  }

  /* From the sheet : the latest attack card of this actor (among the last messages) with a melee hit not yet smitten */
  static latestHit(actor){
    const recent = game.messages.contents.slice(-15).reverse();
    for(const message of recent){
      if((message.type !== TYPES.attack) || (message.getAssociatedActor?.()?.id !== actor.id)) continue;
      const rays = message.system.isMulti ? message.system.rays.map((_, i) => i) : [null];
      const ray = rays.find(r => this.meleeHit(message, r) && !this.smitten(message, r));
      if(ray !== undefined) return { message, ray };
      return null;
    }
    return null;
  }

  static async smiteFromSheet(item){
    const actor = item.actor;
    const hit = actor && this.latestHit(actor);
    if(!hit){
      ui.notifications.warn(module.format("classes.paladin.noHit", { name : actor?.name ?? "", item : item.name }));
      return null;
    }
    const free = idOf(item) === this.PALADINS_SMITE;
    const done = await this.smite(hit.message, hit.ray, { only : free ? this.DIVINE : idOf(item), freeOnly : free });
    return done ? hit.message : null;
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

  /* Remove Poison : ended at once on a creature you own; anyone else's is the GM's button on the card */
  static async onUse(activity, usage, results){
    if(!this.enabled() || !this.isRemovePoison(activity) || !activity.actor?.isOwner) return;
    const target = fromUuidSync(usage?.[module.id]?.poisonTarget ?? "", { strict : false });
    if(!target?.actor) return;
    if(target.actor.isOwner){
      await setStatus(target.actor, "poisoned", false);
      await actions.autoApplied(results);
      return;
    }
    const card = await uses.cardOf(results);
    const message = (card?.documentName === "ChatMessage") ? card : (card?.message ?? results?.message);
    if(message?.isOwner) await message.setFlag(module.id, "removePoison", target.uuid);
  }

  static poisonButton(message, html){
    const uuid = message.getFlag?.(module.id, "removePoison");
    if(!uuid || !game.user.isGM) return;
    const target = fromUuidSync(uuid, { strict : false });
    if(!target?.actor?.statuses?.has?.("poisoned")) return;
    const row = buttonRow(html, { key : `${module.id}-remove-poison` });
    if(row.childElementCount) return;
    addButton(row, makeButton({ icon : "fa-flask", text : module.format("classes.paladin.endPoisoned", { name : target.name }), once : true,
      onClick : () => setStatus(target.actor, "poisoned", false) }));
  }
}
