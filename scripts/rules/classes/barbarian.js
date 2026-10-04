import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { limits } from '../limits.js';
import { logger } from '../../log.js';
import { tokenOf } from '../../helpers/tokens.js';
import { findItem, addTimedEffect } from '../../helpers/actors.js';
import { originOf } from '../../helpers/utils.js';
import { giveMode } from '../../roll-item/reasons.js';
import { conditions } from '../conditions.js';
const log = logger.for(import.meta.url);

/**
 * Barbarian, levels 1-2 (Class Rules setting), on top of what the 2024 items' own data does. dnd5e's Rage effect
 * already gives the B / P / S resistance, STR check and save advantage and the Rage damage; Danger Sense's effect gives
 * DEX save advantage; Unarmored Defense and Weapon Mastery are dnd5e's.
 *
 *   Rage           : raging = Rage's effect is active (dnd5e's switched-on item effect, or a copy on the creature).
 *                    Using Rage turns it on, and ends Concentration. Using it again while raging extends it without
 *                    spending a use (the Bonus Action extension).
 *     Damage       : only attacks using Strength : a DEX melee attack loses it, a STR thrown attack gets it.
 *     Lasts        : until the end of your next turn. Each of your turns keeps it going if you make an attack roll
 *                    against an enemy, or post a card that forces an enemy to make a saving throw (or extend it).
 *                    Otherwise it ends at the end of that turn (in combat; out of combat, dnd5e's 10 minutes).
 *     Ends early   : Incapacitated, heavy armor equipped, or the combat ends. Can't start in heavy armor.
 *     No spells    : casting a spell while raging is refused.
 *   Danger Sense   : no DEX save advantage while Incapacitated.
 *   Reckless Attack: examples/items/reckless-attack.json. Using it (on your turn) makes you Reckless until the start of
 *                    your next turn : advantage on your attack rolls using Strength, and attack rolls against you have
 *                    advantage.
 */
export class barbarian{
  static RAGE = "rage";
  static RECKLESS = "reckless-attack";
  static DANGER_SENSE = "danger-sense";
  static INCAPACITATED = ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned", "dead"];

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.preUseActivity", (activity, usage) => this.onPreUse(activity, usage));
    Hooks.on("dnd5e.postUseActivity", (activity, usage) => this.onUse(activity, usage));
    Hooks.on("dnd5e.preRollAttackV2", config => this.onPreRollAttack(config));
    Hooks.on("dnd5e.rollAttackV2", (rolls, { subject } = {}) => this.onAttack(subject, rolls?.[0]));
    Hooks.on("dnd5e.preRollDamageV2", config => this.rageDamage(config));
    Hooks.on("dnd5e.preRollSavingThrowV2", config => this.dangerSense(config));
    Hooks.on("createChatMessage", message => this.onCard(message));
    Hooks.on("combatTurnChange", (combat, prior, current) => this.onTurnEnd(combat, prior, current));
    Hooks.on("createActiveEffect", effect => this.onStatus(effect));
    Hooks.on("updateActiveEffect", effect => this.onStatus(effect));
    Hooks.on("updateItem", (item, changes) => this.onArmor(item, foundry.utils.getProperty(changes ?? {}, "system.equipped")));
    Hooks.on("createItem", item => this.onArmor(item, item.system?.equipped));
    Hooks.on("deleteCombat", combat => this.onCombatEnd(combat));
  }

  static idOf(item){
    return item?.identifier ?? item?.system?.identifier ?? "";
  }

  /* ---------- Rage ---------- */

  /* An effect from the Rage item : dnd5e's own (on the item) or a copy applied to the creature */
  static isRageEffect(effect){
    if(effect?.getFlag?.(module.id, "rage")) return true;
    const item = (effect?.parent?.documentName === "Item") ? effect.parent
      : (effect?.origin ? fromUuidSync(effect.origin, { strict : false }) : null);
    return (item?.documentName === "Item") && (this.idOf(item) === this.RAGE);
  }

  /* The creature's active Rage effects (none : not raging) */
  static rageEffects(actor){
    return [...(actor?.appliedEffects ?? [])].filter(e => this.isRageEffect(e));
  }

  static isRaging(actor){
    return this.enabled() && (this.rageEffects(actor).length > 0);
  }

  /* Now, for "kept going this turn" : the combat and round */
  static now(){
    const combat = game.combat;
    return combat?.started ? { combat : combat.id, round : combat.round } : null;
  }

  /* Is it this creature's turn ? */
  static isTurnOf(actor){
    const current = game.combat?.combatant;
    return !!current && ((current.actor?.uuid === actor?.uuid) || (current.actorId === actor?.id));
  }

  /* The token's own actor (an unlinked token's), for anything it does */
  static actorFor(activity){
    return activity.getUsageToken?.()?.actor ?? tokenOf(activity.actor)?.actor ?? activity.actor;
  }

  /* Before a use : extending a Rage spends nothing; spells can't be cast while raging */
  static onPreUse(activity, usage){
    if(!this.enabled()) return;
    const actor = this.actorFor(activity);
    if((activity.item?.type === "spell") && this.isRaging(actor)){
      if(!limits.allow(module.format("classes.barbarian.noSpells", { name : actor.name }), { who : actor.name, what : activity.item.name })) return false;
    }
    if((this.idOf(activity.item) === this.RAGE) && this.isRaging(actor)){
      usage.consume = false;
      usage[module.id] = { ...(usage[module.id] ?? {}), rageExtend : true };
    }
    /* "if you aren't wearing Heavy armor" */
    else if((this.idOf(activity.item) === this.RAGE) && this.inHeavyArmor(actor)){
      if(!limits.allow(module.format("classes.barbarian.noRageArmor", { name : actor.name }), { who : actor.name, what : activity.item.name })) return false;
    }
  }

  static async onUse(activity, usage){
    if(!this.enabled() || !activity?.actor?.isOwner) return;
    const id = this.idOf(activity.item);
    try {
      if(id === this.RAGE){
        if(usage?.[module.id]?.rageExtend) return await this.keep(this.actorFor(activity), "bonus");
        return await this.startRage(activity);
      }
      if(id === this.RECKLESS) return await this.reckless(activity);
    } catch(error){
      log.error(error);
      ui.notifications.warn(error.message);
    }
  }

  /* Rage on : the item's effect switched on (or applied to the creature), Concentration ended */
  static async startRage(activity){
    const actor = this.actorFor(activity);
    const item = activity.item;
    const kept = this.now();
    if(!this.rageEffects(actor).length){
      const id = activity.effects?.[0]?._id;
      const effect = (id && item.effects.get(id)) ?? item.effects.find(e => e.transfer) ?? item.effects.contents?.[0];
      if(!effect) return ui.notifications.warn(module.format("classes.barbarian.noEffect", { item : item.name }));
      /* Its 10 minutes count from now (v14 : start.time / round / turn) */
      const start = { time : game.time.worldTime };
      if(game.combat?.started) Object.assign(start, { combat : game.combat.id, round : game.combat.round, turn : game.combat.turn ?? 0 });
      if(effect.transfer && (item.parent === actor)) await effect.update({ disabled : false, start, [`flags.${module.id}.rage`] : { kept } });
      else {
        const data = foundry.utils.mergeObject(effect.toObject(), { disabled : false, transfer : false, origin : item.uuid,
          start, flags : { [module.id] : { rage : { kept } } } });
        delete data._id;
        await actor.createEmbeddedDocuments("ActiveEffect", [data]);
      }
    }
    else await this.keep(actor, "start");
    /* No Concentration while raging */
    if(actor.concentration?.effects?.size) await actor.endConcentration?.();
    log.debug("Rage", actor.name);
  }

  /* Rage kept going this turn (an attack, a forced save, the bonus action) */
  static async keep(actor, why){
    const kept = this.now();
    if(!kept) return;
    for(const effect of this.rageEffects(actor)){
      if(!effect.isOwner) continue;
      const prior = effect.getFlag(module.id, "rage")?.kept;
      if(prior && (prior.combat === kept.combat) && (prior.round === kept.round)) continue;
      await effect.setFlag(module.id, "rage", { kept });
    }
    if(why === "bonus") ui.notifications.info(module.format("classes.barbarian.extended", { name : actor.name }));
    log.debug("Rage kept going", actor.name, why);
  }

  /* An attack roll against an enemy, on your own turn */
  static async onAttack(activity, roll){
    const actor = activity?.actor;
    if(!this.isRaging(actor) || !this.isTurnOf(actor)) return;
    const uuid = roll?.options?.[module.id]?.target;
    const target = uuid ? fromUuidSync(uuid, { strict : false })?.object : ((game.user.targets.size === 1) ? game.user.targets.first() : null);
    const me = tokenOf(actor);
    if(target && me && ((target.document.disposition * me.document.disposition) > 0)) return;   // an ally
    await this.keep(actor, "attack");
  }

  /* A card that makes an enemy save, posted by the raging creature on its turn (Grapple, Shove, a save activity) */
  static async onCard(message){
    if(!this.enabled() || (message.author?.id !== game.user.id)) return;
    const activity = message.getAssociatedActivity?.();
    if((activity?.type !== "save") || originOf(message)) return;
    const actor = activity.actor;
    if(!this.isRaging(actor) || !this.isTurnOf(actor)) return;
    const me = tokenOf(actor);
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    const enemy = (message.system?.targets ?? []).some(d => {
      const t = TargetsField.resolve(d).token;
      return t && me && ((t.document.disposition * me.document.disposition) <= 0) && (t !== me);
    });
    if(enemy) await this.keep(actor, "save");
  }

  /* End of the Barbarian's turn : no attack, forced save or extension since its last turn, the Rage ends */
  static async onTurnEnd(combat, prior, current){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    if((prior?.round === current?.round) && (prior?.turn === current?.turn)) return;   // a re-sorted order
    const actor = combat.combatants.get(prior?.combatantId)?.actor;
    const effects = this.rageEffects(actor);
    if(!effects.length) return;
    const kept = effects.map(e => e.getFlag(module.id, "rage")?.kept).find(k => k?.combat === combat.id);
    /* Raging before this combat began : its first turn in it counts as the start */
    if(!kept){
      for(const e of effects) await e.setFlag(module.id, "rage", { kept : { combat : combat.id, round : prior.round } });
      return;
    }
    if(kept.round < prior.round) await this.endRage(actor, module.i18n("classes.barbarian.notKept"));
  }

  /* The combat is over : its Barbarians' Rages end */
  static async onCombatEnd(combat){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    for(const combatant of combat?.combatants ?? []){
      const actor = combatant.actor;
      if(actor && this.rageEffects(actor).length) await this.endRage(actor, module.i18n("classes.barbarian.combatEnded"));
    }
  }

  /* Incapacitated : the Rage ends */
  static async onStatus(effect){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    const actor = (effect?.parent?.documentName === "Actor") ? effect.parent : effect?.parent?.actor;
    if(!actor || !this.INCAPACITATED.some(s => actor.statuses?.has(s)) || !this.rageEffects(actor).length) return;
    await this.endRage(actor, module.i18n("classes.barbarian.incapacitated"));
  }

  /* Heavy armor on : the Rage ends */
  static async onArmor(item, equipped){
    if(!this.enabled() || !game.users.activeGM?.isSelf || !equipped) return;
    if((item?.type !== "equipment") || (item.system?.type?.value !== "heavy")) return;
    const actor = item.actor;
    if(this.rageEffects(actor).length) await this.endRage(actor, module.i18n("classes.barbarian.heavyArmor"));
  }

  static async endRage(actor, reason){
    const effects = this.rageEffects(actor);
    if(!effects.length || this.#ending.has(actor.uuid)) return;
    this.#ending.add(actor.uuid);
    try { await this.#endRage(actor, effects, reason); }
    finally { this.#ending.delete(actor.uuid); }
  }

  static #ending = new Set();

  static async #endRage(actor, effects, reason){
    for(const effect of effects){
      if(effect.parent?.documentName === "Item") await effect.update({ disabled : true, [`flags.${module.id}.rage`] : globalThis._del ?? new foundry.data.operators.ForcedDeletion() });
      else await effect.delete();
    }
    await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor }),
      content : `<p><i class="fa-solid fa-face-angry" inert></i> ${module.format("classes.barbarian.ends", { name : foundry.utils.escapeHTML(actor.name), reason })}</p>`,
    });
    log.debug("Rage ends", actor.name, reason);
  }

  /* Rage damage : only attacks using Strength. dnd5e adds it to every melee weapon attack (DEX finesse too) and to no
     ranged one (STR thrown) : take it off / put it on in the damage formula */
  static rageDamage(config){
    const activity = config?.subject;
    if((activity?.type !== "attack") || (activity.item?.type !== "weapon")) return;
    const actor = activity.actor;
    if(!this.isRaging(actor)) return;
    const change = this.rageEffects(actor).flatMap(e => [...(e.system?.changes ?? e.changes ?? [])])
      .find(c => ["system.bonuses.mwak.damage", "system.rolls.damage.mwak.bonus"].includes(c.key));
    const bonus = String(change?.value ?? "").replace(/^\s*\+\s*/, "").trim();
    if(!bonus) return;
    const ability = config.ability ?? config.rolls?.[0]?.options?.ability ?? activity.ability;
    const action = String(activity.getActionType?.(config.attackMode) ?? "");
    const roll = config.rolls?.[0];
    if(!roll) return;
    if(action.startsWith("m") && (ability !== "str")) roll.parts = this.withoutBonus(roll.parts ?? [], bonus);
    else if(action.startsWith("r") && (ability === "str")) roll.parts = [...(roll.parts ?? []), bonus];
  }

  /* The parts without Rage's bonus : dnd5e adds the melee damage bonus as one part (Rage's, maybe with others) */
  static withoutBonus(parts, bonus){
    const flat = s => String(s).replace(/\s+/g, "");
    const target = flat(bonus).replace(/^\+/, "");
    for(let i = 0; i < parts.length; i++){
      const part = flat(parts[i]);
      if(!part.includes(target)) continue;
      const rest = part.replace(`+${target}`, "").replace(target, "").replace(/^\+/, "");
      const copy = [...parts];
      if(rest) copy[i] = rest; else copy.splice(i, 1);
      return copy;
    }
    return [...parts, `-(${bonus})`];   // not found : cancel it instead
  }

  /* Wearing heavy armor */
  static inHeavyArmor(actor){
    return !!actor?.items?.some?.(i => (i.type === "equipment") && i.system?.equipped && (i.system?.type?.value === "heavy"));
  }

  /* ---------- Danger Sense ---------- */

  /* Incapacitated : no DEX save advantage from it (when it's the only advantage) */
  static dangerSense(config){
    if(!this.enabled() || (config?.ability !== "dex")) return;
    const actor = config.subject;
    if(!this.INCAPACITATED.some(s => actor?.statuses?.has(s)) || !findItem(actor, this.DANGER_SENSE)) return;
    const sources = [...(actor.appliedEffects ?? [])].filter(e => [...(e.system?.changes ?? e.changes ?? [])]
      .some(c => (c.key === "system.abilities.dex.save.roll.mode") && (Number(c.value) > 0)));
    const onlyDangerSense = sources.length && sources.every(e => /danger sense/i.test(e.name) || (this.idOf(e.parent) === this.DANGER_SENSE));
    if(!onlyDangerSense) return;
    for(const roll of config.rolls ?? []) if(roll.options) roll.options.advantage = false;
    config.advantage = false;
    log.debug("Danger Sense : no advantage while Incapacitated", actor.name);
  }

  /* ---------- Reckless Attack ---------- */

  static RECKLESS_IMG = "icons/skills/melee/blade-tips-triple-bent-white.webp";

  static async reckless(activity){
    const actor = this.actorFor(activity);
    if(game.combat?.started && !this.isTurnOf(actor) && !limits.allow(module.format("classes.barbarian.recklessTurn", { name : actor.name }), { who : actor.name, what : activity.item.name })) return;
    if(this.isReckless(actor)) return;
    await addTimedEffect(actor, {
      name : module.i18n("classes.barbarian.reckless"), img : this.RECKLESS_IMG,
      flags : { [module.id] : { reckless : true } },
    }, { until : "turnStart" });
  }

  static isReckless(actor){
    return [...(actor?.appliedEffects ?? actor?.effects ?? [])].some(e => e.getFlag?.(module.id, "reckless"));
  }

  /* Your STR attacks : advantage. Attacks against you : advantage */
  static onPreRollAttack(config){
    if(!this.enabled()) return;
    const roll = config.rolls?.[0];
    const attacker = config.subject?.actor;
    if(!roll || !attacker) return;
    roll.options ??= {};
    const ability = config.ability ?? config.subject?.ability;
    if(this.isReckless(attacker) && (ability === "str")) giveMode(roll, "advantage", module.i18n("reasons.reckless"));
    const target = conditions.targetOf(config);
    if(target?.actor && this.isReckless(target.actor)) giveMode(roll, "advantage", module.i18n("reasons.targetReckless"));
  }
}
