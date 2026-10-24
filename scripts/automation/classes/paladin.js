import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { idOf, originItem, esc, ownerIds, buttonRow, addButton, makeButton } from '../../helpers/utils.js';
import { countedUses } from '../../helpers/actors.js';
import { pickTargets } from '../../helpers/targets.js';
import { distanceBetween, tokenOf, getTokensWithin, hasLineOfSight } from '../../helpers/tokens.js';
import { conditions } from '../conditions.js';
import { uses } from '../../uses.js';
import { itemFixes } from '../item-fixes.js';
import { actions } from '../actions.js';
import { endCondition } from '../../roll-item/card-builder.js';
import { TYPES } from '../../roll-item/message.js';
import { castOnHit, spellDamage } from '../../roll-item/cast-on-hit.js';
import { casting } from '../casting.js';
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
 *                     Push button); concentration starts for any that need it (none of the 2024 ones do). Searing's Seared and Shining's
 *                     Shining go on the creature hit (the GM's button when it isn't the caster's own). Once per attack; a second
 *                     smite in a turn (a Bonus Action) follows Rule Limits. Using a smite spell or Paladin's Smite from
 *                     the sheet smites the latest melee hit instead (Plutonium makes them Actions with their own damage).
 *                     The Ranger's spells that follow a weapon hit work the same way (the button says Strike when only
 *                     they apply) : Ensnaring Strike (any weapon hit : its STR save on the card), Hail of Thorns (a
 *                     ranged weapon hit : a DEX save for everyone within 5 ft of the target, on the hit's card).
 *   Lay on Hands    : both activities reach a creature you touch (picked on the map). Remove Poison ends Poisoned (the
 *                     end-condition lego) : at once on the user's own creature (gm.mine); on any other, the GM's
 *                     button on a card.
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
  /* Smites whose effect goes on the creature hit (Searing's burn each turn : repeating effects) */
  static ON_TARGET = ["searing-smite", "shining-smite"];
  static UNHOLY = ["fiend", "undead"];
  static DIVINE_SENSE = "divine-sense";
  static SENSED = ["celestial", "fiend", "undead"];

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    /* The smites and the Ranger's strikes : the cast-on-hit lego (one button for every one prepared) */
    castOnHit({
      id : "smite", enabled : () => this.enabled(),
      spells : actor => this.smiteSpells(actor),
      fits : (spell, kind) => { const need = this.HIT_NEEDS[idOf(spell)] ?? "melee"; return (need === "any") || (need === kind); },
      damage : (spell, level, target) => this.damageOf(spell, level, target),
      effect : spell => this.ON_TARGET.includes(idOf(spell)),
      save : spell => this.AROUND_TARGET[idOf(spell)] ? { around : this.AROUND_TARGET[idOf(spell)] } : this.RIDERS.includes(idOf(spell)),
      /* Paladin's Smite's free Divine Smite (the payCasting lego's ways) */
      free : (actor, spell) => (idOf(spell) === this.DIVINE) ? { left : a => (this.freeSmite(a) ? 1 : 0), spend : a => this.payFree(a),
        label : () => module.format("classes.paladin.smiteFree", { spell : spell.name }) } : null,
      slotLabel : (slot, spell) => module.format(slot.pact ? "classes.paladin.smitePact" : "classes.paladin.smiteSlot", { spell : spell.name, level : slot.level, left : slot.value }),
      /* A smite spell (or Paladin's Smite) used from the sheet : the latest hit */
      sheet : item => !this.isSmiteSource(item) ? null : (idOf(item) === this.PALADINS_SMITE) ? { only : this.DIVINE, freeOnly : true } : { only : idOf(item) },
      /* Only the Ranger's strikes apply : "Strike" */
      label : choices => module.i18n(choices.some(c => !this.HIT_NEEDS[idOf(c.spell)]) ? "classes.paladin.smite" : "classes.paladin.strike"),
      icon : choices => choices.some(c => !this.HIT_NEEDS[idOf(c.spell)]) ? "fa-sun" : "fa-crosshairs",
      title : () => module.i18n("classes.paladin.smite"), prompt : () => module.i18n("classes.paladin.smitePrompt"),
      noChoice : actor => module.format("classes.paladin.noSmite", { name : actor.name }),
      noHit : (actor, item) => module.format("classes.paladin.noHit", { name : actor?.name ?? "", item : item.name }),
      /* For the rules that follow a smite (Inspiring Smite) : Hooks "macro-helper.smite" (actor, spell, message) */
      after : (actor, spell, message) => Hooks.callAll(`${module.id}.smite`, actor, spell, message),
    });
    Hooks.on(`${module.id}.cardMoves`, (message, uuid, moves, { result } = {}) => this.pushMove(message, moves, result));
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
    /* Paladin's Smite with no uses anywhere : once a Long Rest, counted on the actor */
    this.smiteCount = countedUses("paladinsSmite", { max : () => 1 });
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
    return this.smiteCount.left(actor) ? { item, activity : null, counted : true } : null;
  }

  /**
   * A smite's extra damage at a slot level : its first damage part (a damage activity's, else its save's), scaled.
   * @returns {{ formula : string, type : string }|null}
   */
  static damageOf(spell, level, target){
    if(idOf(spell) === this.DIVINE){
      const extra = Math.max(0, level - (Number(spell.system.level) || 1));
      const unholy = this.UNHOLY.includes(target?.actor?.system?.details?.type?.value);
      return { formula : `${2 + extra + (unholy ? 1 : 0)}d8`, type : "radiant" };
    }
    /* No damage onto the hit's card : a save instead (Ensnaring Strike, Hail of Thorns) */
    return this.NO_HIT_DAMAGE.includes(idOf(spell)) ? null : spellDamage(spell, level);
  }


  /* Paladin's Smite's free Divine Smite spent : the item's use, its activity's, or counted on the actor */
  static async payFree(actor){
    const free = this.freeSmite(actor);
    if(free?.counted) return this.smiteCount.spend(actor);
    if(free?.activity) return free.item.update({ [`system.activities.${free.activity.id}.uses.spent`] : (Number(free.activity.uses.spent) || 0) + 1 });
    if(free) return free.item.update({ "system.uses.spent" : (Number(free.item.system.uses.spent) || 0) + 1 });
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

  /* Remove Poison : the end-condition lego (at once on itself or the player's character; anyone else : the GM's button) */
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
