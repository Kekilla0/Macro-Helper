import { module } from '../../module.js';
import { rollModeFrom } from '../roll-modes.js';
import { settings } from '../../settings.js';
import { limits } from '../limits.js';
import { logger } from '../../log.js';
import { tokenOf, isIncapacitated } from '../../helpers/tokens.js';
import { findItem, giveEffect, itemEffectOn, itemEffectOff } from '../../helpers/actors.js';
import { originOf, idOf } from '../../helpers/utils.js';
import { conditions } from '../conditions.js';
import { bonusOnlyWhen } from '../bonus-only-when.js';
import { cantUseWhile, freeUseWhile, isFreeUse, userOf } from '../use-rules.js';
import { itemFixes } from '../item-fixes.js';
import { patch } from '../../patch.js';
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
 *   Primal Knowledge (level 3) : while raging, an Acrobatics, Intimidation, Perception, Stealth or Survival check uses
 *                    Strength when that's better (dnd5e's roll, its dialog says so). Plutonium's always-on bonus (the
 *                    difference, raging or not) is switched off.
 * Hooks for the subclasses : "macro-helper.rageStart" (actor, activity) once a Rage begins, "macro-helper.rageEnd"
 * (actor) once it ends.
 */
export class barbarian{
  static RAGE = "rage";
  static RECKLESS = "reckless-attack";
  static DANGER_SENSE = "danger-sense";
  static PRIMAL_KNOWLEDGE = "primal-knowledge";
  static PRIMAL_SKILLS = ["acr", "itm", "prc", "ste", "sur"];
  static ENDS = { incapacitated : "classes.barbarian.incapacitated", heavyArmor : "classes.barbarian.heavyArmor", combatEnd : "classes.barbarian.combatEnded" };

  static enabled = settings.on("classRules");

  static register(){
    if(game.system.id !== "dnd5e") return;
    /* Rage's and Reckless Attack's effects are put on here, not by Roll Item */
    Hooks.on(`${module.id}.selfEffects`, activity => !(this.enabled() && [this.RAGE, this.RECKLESS].includes(idOf(activity?.item))));
    /* Using Rage again while raging extends it, no use spent; no spells while raging; no Rage in Heavy armor */
    freeUseWhile("rageExtend", { enabled : () => this.enabled(), uses : item => idOf(item) === this.RAGE, while : actor => this.isRaging(actor) });
    cantUseWhile("rageSpells", { enabled : () => this.enabled(), uses : item => item.type === "spell", while : actor => this.isRaging(actor),
      reason : actor => module.format("classes.barbarian.noSpells", { name : actor.name }) });
    cantUseWhile("rageArmor", { enabled : () => this.enabled(), uses : item => idOf(item) === this.RAGE, while : actor => this.inHeavyArmor(actor),
      reason : actor => module.format("classes.barbarian.noRageArmor", { name : actor.name }) });
    Hooks.on("dnd5e.postUseActivity", (activity, usage) => this.onUse(activity, usage));
    /* Reckless : advantage on its Strength attacks, and on attacks against it */
    rollModeFrom(effect => effect.getFlag?.(module.id, "reckless"), {
      by : { mode : "advantage", when : attack => attack.ability === "str", reason : () => module.i18n("reasons.reckless") },
      against : { mode : "advantage", reason : () => module.i18n("reasons.targetReckless") },
      enabled : () => this.enabled(), id : "reckless" });
    Hooks.on("dnd5e.rollAttackV2", (rolls, { subject } = {}) => this.onAttack(subject, rolls?.[0]));
    /* Rage's damage bonus is for attacks made with Strength (a thrown weapon too, 2024), never another ability : dnd5e
       adds it to every melee weapon attack */
    bonusOnlyWhen(effect => this.isRageEffect(effect), ["system.bonuses.mwak.damage", "system.rolls.damage.mwak.bonus"],
      attack => attack.weapon && (attack.ability === "str"), { enabled : () => this.enabled(), id : "rageDamage" });
    /* Danger Sense : its DEX save advantage switched off while Incapacitated */
    bonusOnlyWhen(this.DANGER_SENSE, "system.abilities.dex.save.roll.mode", actor => !isIncapacitated(actor),
      { enabled : () => this.enabled(), id : "dangerSense" });
    Hooks.on("createChatMessage", message => this.onCard(message));
    Hooks.on("combatTurnChange", (combat, prior, current) => this.onTurnEnd(combat, prior, current));
    /* Ends early : Incapacitated, Heavy armor on, the combat over */
    conditions.endsWhen(effect => this.enabled() && this.isRageEffect(effect), { incapacitated : true, heavyArmor : true, combatEnd : true,
      end : (actor, effects, why) => this.endRage(actor, module.i18n(this.ENDS[why])) });
    /* Primal Knowledge : Plutonium's bonus is on whether raging or not */
    itemFixes.add({ name : "Primal Knowledge", where : "owned", plan : item => this.primalFix(item) });
    const self = this;
    patch.wrap("CONFIG.Actor.documentClass.prototype.rollSkill", function(wrapped, config = {}, ...rest){
      try { config = self.primalKnowledge(this, config); } catch(error){ log.error(error); }
      return wrapped(config, ...rest);
    });
  }


  /* ---------- Rage ---------- */

  /* An effect from the Rage item : dnd5e's own (on the item) or a copy applied to the creature */
  static isRageEffect(effect){
    if(effect?.getFlag?.(module.id, "rage")) return true;
    const item = (effect?.parent?.documentName === "Item") ? effect.parent
      : (effect?.origin ? fromUuidSync(effect.origin, { strict : false }) : null);
    return (item?.documentName === "Item") && (idOf(item) === this.RAGE);
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
    return userOf(activity);
  }

  static async onUse(activity, usage){
    if(!this.enabled() || !activity?.actor?.isOwner) return;
    const id = idOf(activity.item);
    try {
      if(id === this.RAGE){
        if(isFreeUse(usage, "rageExtend")) return await this.keep(this.actorFor(activity), "bonus");
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
      /* The item's effect on, its 10 minutes from now */
      const effect = await itemEffectOn(item, { on : actor, activity, data : { flags : { [module.id] : { rage : { kept } } } } });
      if(!effect) return ui.notifications.warn(module.format("classes.barbarian.noEffect", { item : item.name }));
    }
    else return await this.keep(actor, "start");
    /* No Concentration while raging */
    if(actor.concentration?.effects?.size) await actor.endConcentration?.();
    log.debug("Rage", actor.name);
    Hooks.callAll(`${module.id}.rageStart`, actor, activity);
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

  static async endRage(actor, reason){
    const effects = this.rageEffects(actor);
    if(!effects.length || this.#ending.has(actor.uuid)) return;
    this.#ending.add(actor.uuid);
    try { await this.#endRage(actor, effects, reason); }
    finally { this.#ending.delete(actor.uuid); }
  }

  static #ending = new Set();

  static async #endRage(actor, effects, reason){
    await itemEffectOff(actor, e => effects.includes(e), { data : { [`flags.${module.id}.rage`] : new foundry.data.operators.ForcedDeletion() } });
    await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor }),
      content : `<p><i class="fa-solid fa-face-angry" inert></i> ${module.format("classes.barbarian.ends", { name : foundry.utils.escapeHTML(actor.name), reason })}</p>`,
    });
    log.debug("Rage ends", actor.name, reason);
    Hooks.callAll(`${module.id}.rageEnd`, actor);
  }

  /* Wearing heavy armor */
  static inHeavyArmor(actor){
    return !!actor?.items?.some?.(i => (i.type === "equipment") && i.system?.equipped && (i.system?.type?.value === "heavy"));
  }

  /* ---------- Primal Knowledge ---------- */

  /* Plutonium's effect adds STR's lead over the skill's ability always : switched off (the rule only works raging) */
  static primalFix(item){
    if((idOf(item) !== this.PRIMAL_KNOWLEDGE) || !item.actor) return null;
    const updateEffects = [...(item.effects ?? [])].filter(e => !e.disabled && [...(e.changes ?? e.system?.changes ?? [])]
      .some(c => /^system\.skills\.\w+\.bonuses\.check$/.test(c.key) && /abilities\.str\.mod/.test(String(c.value)))).map(e => ({ _id : e.id, disabled : true }));
    return updateEffects.length ? { updateEffects } : null;
  }

  /* Raging, one of its skills : rolled with Strength when that's the better ability */
  static primalKnowledge(actor, config){
    if(!this.enabled() || config?.ability || !this.PRIMAL_SKILLS.includes(config?.skill)) return config;
    if(!findItem(actor, this.PRIMAL_KNOWLEDGE) || !this.isRaging(actor)) return config;
    const own = actor.system?.skills?.[config.skill]?.ability;
    const mod = key => Number(actor.system?.abilities?.[key]?.mod) || 0;
    if(!own || (mod("str") <= mod(own))) return config;
    log.debug("Primal Knowledge : STR", actor.name, config.skill);
    return { ...config, ability : "str" };
  }

  /* ---------- Reckless Attack ---------- */

  static RECKLESS_IMG = "icons/skills/melee/blade-tips-triple-bent-white.webp";

  static async reckless(activity){
    const actor = this.actorFor(activity);
    if(game.combat?.started && !this.isTurnOf(actor) && !limits.allow(module.format("classes.barbarian.recklessTurn", { name : actor.name }), { who : actor.name, what : activity.item.name })) return;
    if(this.isReckless(actor)) return;
    await giveEffect(actor, {
      name : module.i18n("classes.barbarian.reckless"), img : this.RECKLESS_IMG,
      flags : { [module.id] : { reckless : true } },
    }, { until : "turnStart" });
  }

  static isReckless(actor){
    return [...(actor?.appliedEffects ?? actor?.effects ?? [])].some(e => e.getFlag?.(module.id, "reckless"));
  }

}
