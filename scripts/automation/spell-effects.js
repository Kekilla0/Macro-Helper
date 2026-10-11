import { module } from '../module.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { gm } from '../gm.js';
import { spells } from './spells.js';
import { rollModes } from './roll-modes.js';
import { idOf, originItem, chooseOption } from '../helpers/utils.js';
import { giveMode } from '../roll-item/reasons.js';
import { usedThisTurn, markUsedThisTurn } from '../helpers/actors.js';
import { limits } from './limits.js';
const log = logger.for(import.meta.url);

/**
 * Spell effects that do something (System Automation → Spells switch). A building block : an effect carries a rule
 * (flags["macro-helper"].rule), given by its spell (RULES, as it lands, whoever applies it) or by a choice (CHOICES).
 *
 * Rules :
 *   nextAttack : "disadvantage"   its next attack roll has it, then the effect ends (Vicious Mockery)
 *   noHealing : true              it can't regain Hit Points (temporary ones still come) (Chill Touch)
 *   attackersMinus : "1d4"        attack rolls against it subtract that (Blade Ward)
 *   noInvisible : true            being Invisible gives it nothing (Starry Wisp)
 *   reduceDamage : { type, dice, oncePerTurn }   damage of that type it takes is reduced by the dice (Resistance)
 *   nextAttackAgainst : "advantage"  the next attack roll against it has it, then the effect ends (Guiding Bolt)
 *   attackersMode : "advantage"   attack rolls against it have it (Faerie Fire)
 *   attackersOfTypes : { types, mode }   attacks by those creature types against it have it (Protection from Evil and Good)
 *   onlyAgainstOrigin : "disadvantage"   its attacks on anyone but the caster have it (Compelled Duel)
 *   noReactions : true            it can't take Reactions (Rule Limits) (Arms of Hadar)
 *
 * Choices : a spell whose effects are options (Guidance : a skill, Resistance : a damage type) asks which when cast,
 * then puts that one on its target (yours : at once; anyone else's : the GM's button), tied to the Concentration.
 */
export class spellEffects{
  /* The rule a spell's effect carries, by the spell's identifier */
  static RULES = {
    "vicious-mockery" : { nextAttack : "disadvantage" },
    "chill-touch" : { noHealing : true },
    "blade-ward" : { attackersMinus : "1d4" },
    "starry-wisp" : { noInvisible : true },
    "guiding-bolt" : { nextAttackAgainst : "advantage" },
    "faerie-fire" : { attackersMode : "advantage", noInvisible : true },
    "protection-from-evil-and-good" : { attackersOfTypes : { types : ["aberration", "celestial", "elemental", "fey", "fiend", "undead"], mode : "disadvantage" } },
    "compelled-duel" : { onlyAgainstOrigin : "disadvantage" },
    "arms-of-hadar" : { noReactions : true },
  };
  /* Spells whose effects are a choice : the question, and the rule the chosen one carries */
  static CHOICES = {
    "guidance" : { prompt : "spellEffects.choice.skill" },
    "resistance" : { prompt : "spellEffects.choice.damageType", rule : effect => ({ reduceDamage : { type : spellEffects.damageTypeOf(effect), dice : "1d4", oncePerTurn : true } }) },
  };

  static enabled(){
    return spells.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("preCreateActiveEffect", effect => this.giveRule(effect));
    rollModes.add("spellEffects", config => this.attackRules(config));
    /* The roll exists (not rolled yet) once dnd5e has built it : the penalty to attackers goes in then */
    Hooks.on("dnd5e.postAttackRollConfiguration", (rolls, config) => this.attackPenalty(rolls, config));
    Hooks.on("dnd5e.rollAttackV2", rolls => this.spendOnAttack(rolls));
    Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options) => this.blockHealing(actor, amount, updates, options));
    Hooks.on("dnd5e.calculateDamage", (actor, damages, options) => this.reduceDamage(actor, damages, options));
    uses.onActivity("spellChoice", (activity, ctx, next) => this.choiceStep(activity, ctx, next));
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.applyChoice(activity, usage, results));
    gm.handle("spellEffect", data => this.applyAsGM(data));
    gm.handle("spellEffectEnd", data => this.endAsGM(data));
    uses.onActivity("noReactions", (activity, ctx, next) => this.reactionStep(activity, ctx, next));
  }

  /* ---------- The rules ---------- */

  static giveRule(effect){
    if(!this.enabled() || (effect?.parent?.documentName !== "Actor") || effect.getFlag?.(module.id, "rule")) return;
    const rule = this.RULES[idOf(originItem(effect))];
    if(rule) effect.updateSource({ [`flags.${module.id}.rule`] : rule });
  }

  /* An actor's effects carrying a rule (active ones) */
  static withRule(actor, key){
    if(!actor?.effects) return [];
    return actor.effects.filter(e => !e.disabled && !e.isSuppressed && (e.getFlag(module.id, "rule")?.[key] !== undefined));
  }

  static has(actor, key){
    return this.enabled() && (this.withRule(actor, key).length > 0);
  }

  static targetOf(config){
    const given = config?.[module.id]?.target;
    if(given) return fromUuidSync(given, { strict : false })?.object ?? null;
    return (game.user.targets.size === 1) ? game.user.targets.first() : null;
  }

  /* Attack rolls : the attacker's next-attack rule (spent after the roll), the target's penalty to attackers */
  static attackRules(config){
    if(!this.enabled()) return;
    const actor = config.subject?.actor;
    const roll = config.rolls?.[0];
    if(!actor || !roll) return;
    roll.options ??= {};
    const used = [];
    for(const effect of this.withRule(actor, "nextAttack")){
      giveMode(roll, effect.getFlag(module.id, "rule").nextAttack, module.format("spellEffects.reason", { effect : effect.name }));
      used.push(effect.uuid);
    }
    const target = this.targetOf(config);
    const theirs = target?.actor;
    for(const effect of this.withRule(theirs, "nextAttackAgainst")){
      giveMode(roll, effect.getFlag(module.id, "rule").nextAttackAgainst, module.format("spellEffects.reasonTarget", { effect : effect.name }));
      used.push(effect.uuid);
    }
    for(const effect of this.withRule(theirs, "attackersMode")) giveMode(roll, effect.getFlag(module.id, "rule").attackersMode, module.format("spellEffects.reasonTarget", { effect : effect.name }));
    const type = actor.system?.details?.type?.value ?? actor.system?.details?.race ?? "";
    for(const effect of this.withRule(theirs, "attackersOfTypes")){
      const { types = [], mode = "disadvantage" } = effect.getFlag(module.id, "rule").attackersOfTypes ?? {};
      if(types.includes(type)) giveMode(roll, mode, module.format("spellEffects.reasonTarget", { effect : effect.name }));
    }
    for(const effect of this.withRule(actor, "onlyAgainstOrigin")){
      const origin = originItem(effect)?.actor;
      if(origin && theirs && (theirs !== origin) && (theirs.id !== origin.id)) giveMode(roll, effect.getFlag(module.id, "rule").onlyAgainstOrigin, module.format("spellEffects.reason", { effect : effect.name }));
    }
    if(used.length) roll.options[module.id] = { ...(roll.options[module.id] ?? {}), spellConsume : used };
  }

  /* Attack rolls against it subtract the dice (Blade Ward) : terms added to the built roll, before it's rolled */
  static attackPenalty(rolls, process){
    const roll = rolls?.[0];
    if(!this.enabled() || !roll?.terms || !process) return;
    const target = this.targetOf(process);
    for(const effect of this.withRule(target?.actor, "attackersMinus")){
      const dice = effect.getFlag(module.id, "rule").attackersMinus;
      if(roll.formula.includes(`- ${dice}`)) continue;
      const extra = Roll.parse(`0 - ${dice}`, roll.data ?? {}).slice(1);
      roll.terms.push(...extra);
      roll.resetFormula();
      log.debug(module.format("spellEffects.minus", { effect : effect.name, dice }));
    }
  }

  static async spendOnAttack(rolls){
    for(const uuid of rolls?.[0]?.options?.[module.id]?.spellConsume ?? []){
      const effect = await fromUuid(uuid);
      if(!effect) continue;
      /* Someone else's creature (Guiding Bolt's mark on the target) : the GM ends it */
      if(effect.isOwner) await effect.delete().catch(error => log.debug(error));
      else await gm.run("spellEffectEnd", { uuid }).catch(error => log.debug(error));
    }
  }

  static async endAsGM({ uuid } = {}){
    const effect = uuid ? await fromUuid(uuid) : null;
    if(effect) await effect.delete().catch(() => {});
    return !!effect;
  }

  /* A Reaction while it can't take one (Arms of Hadar) : Rule Limits */
  static async reactionStep(activity, ctx, next){
    if(!this.enabled() || (activity?.activation?.type !== "reaction")) return next();
    const effect = this.withRule(activity.actor, "noReactions")[0];
    if(effect && !limits.allow(module.format("spellEffects.noReactions", { name : activity.actor.name, effect : effect.name }), { who : activity.actor.name, what : activity.item?.name })) return;
    return next();
  }

  /* Healing that would raise its Hit Points : none (temporary Hit Points aren't Hit Points) */
  static blockHealing(actor, amount, updates, options){
    if(!(Number(amount) < 0) || !this.has(actor, "noHealing")) return;
    const now = Number(actor.system?.attributes?.hp?.value) || 0;
    const next = foundry.utils.getProperty(updates ?? {}, "system.attributes.hp.value");
    if((next === undefined) || !(Number(next) > now)) return;
    foundry.utils.setProperty(updates, "system.attributes.hp.value", now);
    ui.notifications.info(module.format("spellEffects.noHealing", { name : actor.name, effect : this.withRule(actor, "noHealing")[0]?.name ?? "" }));
  }

  /* Damage of a type it's protected from : less by the dice (once a turn in combat) */
  static reduceDamage(actor, damages, options){
    if(!Array.isArray(damages) || !this.enabled()) return;
    for(const effect of this.withRule(actor, "reduceDamage")){
      const { type, dice = "1d4", oncePerTurn } = effect.getFlag(module.id, "rule").reduceDamage ?? {};
      const hit = damages.find(d => (d.type === type) && (Number(d.value) > 0));
      if(!hit) continue;
      const key = `reduce-${effect.id}`;
      if(oncePerTurn && usedThisTurn(actor, key)) continue;
      /* Rolled here (damage is worked out synchronously) : NdM dice, the same random source as Foundry's */
      const [, n = "1", faces = "4"] = /(\d*)d(\d+)/i.exec(dice) ?? [];
      let total = 0;
      for(let i = 0; i < (Number(n) || 1); i++) total += Math.ceil((1 - CONFIG.Dice.randomUniform()) * Number(faces)) || 1;
      /* Off that damage, and off the total dnd5e has already added up */
      const off = Math.min(total, Number(hit.value));
      hit.value = Number(hit.value) - off;
      if(Number.isFinite(damages.amount)) damages.amount = Math.max(0, damages.amount - off);
      if(oncePerTurn) markUsedThisTurn(actor, key).catch(() => {});
      ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }),
        content : `<p>${module.format("spellEffects.reduced", { name : actor.name, effect : effect.name, n : total, dice, type : CONFIG.DND5E.damageTypes?.[type]?.label ?? type })}</p>` }).catch(() => {});
    }
  }

  /* ---------- Choices ---------- */

  static damageTypeOf(effect){
    const name = String(effect?.name ?? "").toLowerCase();
    return Object.entries(CONFIG.DND5E.damageTypes ?? {}).find(([key, t]) => name.includes(game.i18n.localize(t.label ?? key).toLowerCase()))?.[0] ?? null;
  }

  /* The item's effects that are options (not on the caster's sheet, not enchantments) */
  static options(item){
    return (item?.effects?.contents ?? []).filter(e => !e.transfer && (e.type !== "enchantment"));
  }

  static async choiceStep(activity, ctx, next){
    const choice = this.enabled() ? this.CHOICES[idOf(activity?.item)] : null;
    const options = choice ? this.options(activity.item) : [];
    if(options.length < 2) return next();
    const id = await chooseOption({ title : activity.item.name, icon : "fa-solid fa-list-check", prompt : module.i18n(choice.prompt),
      options : options.map(e => ({ value : e.id, label : e.name })) });
    if(!id) return;
    uses.mark(ctx, { spellChoice : id });
    uses.flag(ctx, { note : module.format("spellEffects.chosen", { effect : options.find(e => e.id === id)?.name ?? "" }) });
    return next();
  }

  /* Cast : the chosen effect on each target (none targeted : the caster), tied to the spell's Concentration */
  static async applyChoice(activity, usage, results){
    const id = usage?.[module.id]?.spellChoice;
    if(!id || !results || !activity?.actor?.isOwner) return;
    const item = activity.item, caster = activity.actor;
    const effect = item.effects.get(id);
    if(!effect) return;
    const concentration = caster.effects.find(e => e.statuses?.has?.("concentrating") && (e.getFlag("dnd5e", "item")?.id === item.id));
    const data = effect.toObject();
    delete data._id;
    Object.assign(data, { transfer : false, disabled : false, origin : item.uuid });
    const duration = activity.duration?.getEffectData?.();
    if(duration) data.duration = duration;
    foundry.utils.setProperty(data, "flags.dnd5e.dependentOn", concentration?.uuid ?? null);
    const rule = this.CHOICES[idOf(item)]?.rule?.(effect);
    if(rule) foundry.utils.setProperty(data, `flags.${module.id}.rule`, rule);
    const targets = [...(game.user.targets ?? [])].map(t => t.actor).filter(Boolean);
    for(const actor of (targets.length ? targets : [caster])){
      if(actor.isOwner && !game.user.isGM) await actor.createEmbeddedDocuments("ActiveEffect", [data]);
      else await gm.ask("spellEffect", { actor : actor.uuid, data }, { actor : caster,
        text : module.format("spellEffects.ask", { name : caster.name, effect : effect.name, target : actor.name }),
        label : module.format("spellEffects.askButton", { effect : effect.name, target : actor.name }) });
    }
  }

  static async applyAsGM({ actor : uuid, data } = {}){
    const actor = fromUuidSync(uuid, { strict : false });
    if(!actor || !data) return false;
    await actor.createEmbeddedDocuments("ActiveEffect", [data]);
    return true;
  }
}
