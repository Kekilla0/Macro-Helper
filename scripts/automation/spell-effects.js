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
import { tokenOf, canSee } from '../helpers/tokens.js';
import { getAppliedConditions } from '../helpers/items.js';
import { pickTargets } from '../helpers/targets.js';
import { getRange, addLight, removeLight } from '../helpers/tokens.js';
import { rollItem } from '../roll-item/roll-item.js';
import { patch } from '../patch.js';
const log = logger.for(import.meta.url);

/**
 * Spell effects that do something (System Automation → Spells switch). A building block : an effect carries a rule
 * (flags["macro-helper"].rule), given by its spell (RULES, as it lands, whoever applies it) or by a choice (CHOICES).
 *
 * Rules :
 *   nextAttack : "disadvantage"   its next attack roll has it, then the effect ends (Vicious Mockery)
 *   attacksMode : "disadvantage"  its attack rolls have it while the effect lasts (Heat Metal's armor)
 *   noHealing : true              it can't regain Hit Points (temporary ones still come) (Chill Touch)
 *   attackersMinus : "1d4"        attack rolls against it subtract that (Blade Ward)
 *   noInvisible : true            being Invisible gives it nothing (Starry Wisp)
 *   reduceDamage : { type, dice, oncePerTurn }   damage of that type it takes is reduced by the dice (Resistance)
 *   nextAttackAgainst : "advantage"  the next attack roll against it has it, then the effect ends (Guiding Bolt)
 *   attackersMode : "advantage"   attack rolls against it have it, from an attacker who can see it (Faerie Fire)
 *   attackersOfTypes : { types, mode, resist }   attacks by those creature types against it have it; with resist, their
 *                                 Charmed / Frightened : an automatic success on the save, advantage when it already is
 *                                 (Protection from Evil and Good)
 *   onlyAgainstOrigin : "disadvantage"   its attacks on anyone but the caster have it (Compelled Duel)
 *   noReactions : true            it can't take Reactions (Rule Limits) (Arms of Hadar)
 *   acOnlyAgainst : "melee"       the effect's AC bonus counts only against melee (or "ranged") attacks (Defensive
 *                                 Duelist's Parry)
 *   sanctuary : true              targeted by an attack or a damaging spell : the attacker makes a WIS save (the
 *                                 caster's spell DC) first; failed, it targets again (the same creature : nothing
 *                                 happens). It ends when this creature attacks or casts a spell (Sanctuary)
 *
 * Choices : a spell whose effects are options (Guidance : a skill, Resistance : a damage type) asks which when cast,
 * and the card's rows apply only that one (Resistance's 1d4 isn't rolled on the card : it comes with the damage).
 *
 * Buffs : a spell's utility or healing activity with effects for others (Bless, Shield of Faith, Longstrider, Heroism)
 * gets Roll Item's card, a row per target with its Apply (the creature's owner or the GM; no save). Nothing is put on
 * automatically. Self-only ones are Roll Item's (selfEffects); saves and attacks apply theirs from their rows and trays.
 * Whatever lands from a Concentration spell ends with it.
 */
export class spellEffects{
  /* The rule a spell's effect carries, by the spell's identifier */
  static RULES = {
    "vicious-mockery" : { nextAttack : "disadvantage" },
    "chill-touch" : { noHealing : true },
    "blade-ward" : { attackersMinus : "1d4" },
    "starry-wisp" : { noInvisible : true, glow : { dim : 10, color : "#cfe3ff" } },
    "guiding-bolt" : { nextAttackAgainst : "advantage" },
    "faerie-fire" : { attackersMode : "advantage", noInvisible : true, glow : { dim : 10, color : "#d9b3ff" } },
    "shining-smite" : { attackersMode : "advantage", noInvisible : true, glow : { dim : 5, color : "#fff1b3" } },
    "protection-from-evil-and-good" : { attackersOfTypes : { types : ["aberration", "celestial", "elemental", "fey", "fiend", "undead"], mode : "disadvantage", resist : ["charmed", "frightened"] } },
    "compelled-duel" : { onlyAgainstOrigin : "disadvantage" },
    "arms-of-hadar" : { noReactions : true },
    "shocking-grasp" : { noReactions : true },
    "sanctuary" : { sanctuary : true },
  };
  /* Spells whose effects are a choice : the question, and the rule the chosen one carries */
  static CHOICES = {
    "guidance" : { prompt : "spellEffects.choice.skill" },
    "resistance" : { prompt : "spellEffects.choice.damageType", rule : effect => ({ reduceDamage : { type : spellEffects.damageTypeOf(effect), dice : "1d4", oncePerTurn : true } }) },
    "enlarge-reduce" : { prompt : "spellEffects.choice.enlargeReduce" },
  };

  static enabled(){
    return spells.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("preCreateActiveEffect", effect => this.giveRule(effect));
    /* Any effect from a spell its caster concentrates on (a save card's row, dnd5e's tray) : ends with that Concentration */
    Hooks.on("preCreateActiveEffect", effect => this.tieToConcentration(effect));
    /* Effects that shed light (Starry Wisp, Faerie Fire) : on the creature's tokens while they last (the active GM) */
    Hooks.on("createActiveEffect", effect => { this.glow(effect, true); this.revealInvisible(effect, true); });
    Hooks.on("deleteActiveEffect", effect => { this.glow(effect, false); this.revealInvisible(effect, false); });
    Hooks.on("updateActiveEffect", (effect, changes) => { if("disabled" in (changes ?? {})) this.glow(effect, !effect.disabled); });
    rollModes.add("spellEffects", config => this.attackRules(config));
    Hooks.on(`${module.id}.targetAC`, (activity, attack, target, actor) => this.acOnlyAgainst(activity, attack, target, actor));
    /* The roll exists (not rolled yet) once dnd5e has built it : the penalty to attackers goes in then */
    Hooks.on("dnd5e.postAttackRollConfiguration", (rolls, config) => this.attackPenalty(rolls, config));
    Hooks.on("dnd5e.rollAttackV2", rolls => this.spendOnAttack(rolls));
    Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options) => this.blockHealing(actor, amount, updates, options));
    Hooks.on("dnd5e.calculateDamage", (actor, damages, options) => this.reduceDamage(actor, damages, options));
    /* Damage really being applied (not a tray's or a row's preview of it) : rules that roll or spend act only then */
    Hooks.once("setup", () => patch.wrap("CONFIG.Actor.documentClass.prototype.applyDamage", function(wrapped, damages, options = {}, ...rest){
      return wrapped(damages, { ...options, [module.id] : { ...(options?.[module.id] ?? {}), applying : true } }, ...rest);
    }));
    uses.onActivity("spellChoice", (activity, ctx, next) => this.choiceStep(activity, ctx, next));
    /* Resistance's 1d4 : rolled when the damage comes, not on the card */
    Hooks.on(`${module.id}.rollFormula`, activity => !(this.enabled() && this.CHOICES[idOf(activity?.item)])) ;
    gm.handle("spellEffect", data => this.applyAsGM(data));
    gm.handle("spellEffectEnd", data => this.endAsGM(data));
    Hooks.on("dnd5e.preRollSavingThrowV2", (config, dialog, message) => this.protectedSave(config, message));
    Hooks.on(`${module.id}.saveOutcome`, (save, outcome) => {
      const auto = save?.getFlag?.(module.id, "autoSuccess");
      if(auto && outcome){ outcome.success = true; outcome.auto = auto; }
    });
    uses.onActivity("noReactions", (activity, ctx, next) => this.reactionStep(activity, ctx, next));
    rollItem.addTargetCheck((activity, tokens) => this.sanctuaryCheck(activity, tokens));
    Hooks.on("dnd5e.postUseActivity", activity => this.sanctuaryEnds(activity));
  }

  /* ---------- The rules ---------- */

  static giveRule(effect){
    if(!this.enabled() || (effect?.parent?.documentName !== "Actor") || effect.getFlag?.(module.id, "rule")) return;
    const id = idOf(originItem(effect));
    /* A choice spell's effect : its rule from the effect (Resistance : the damage type in its name) */
    const rule = this.RULES[id] ?? this.CHOICES[id]?.rule?.(effect);
    if(rule) effect.updateSource({ [`flags.${module.id}.rule`] : rule });
  }

  /* Dim Light round the creature while the effect lasts (each effect its own light, the token's own back after) */
  static async glow(effect, on){
    const glow = effect?.getFlag?.(module.id, "rule")?.glow;
    const actor = effect?.parent;
    if(!glow || (actor?.documentName !== "Actor") || !game.users.activeGM?.isSelf) return;
    const tokens = actor.isToken ? [actor.token] : actor.getActiveTokens(false, true);
    const key = `glow-${effect.id}`;
    for(const token of tokens){
      if(on) await addLight(token, { dim : glow.dim ?? 10, bright : glow.bright ?? 0, color : glow.color ?? null, alpha : 0.35 }, { key }).catch(error => log.debug(error));
      else await removeLight(token, { key }).catch(error => log.debug(error));
    }
  }

  static tieToConcentration(effect){
    if(!this.enabled() || (effect?.parent?.documentName !== "Actor") || effect.getFlag?.("dnd5e", "dependentOn")) return;
    if(effect.statuses?.has?.(CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating") || effect.getFlag?.(module.id, "casting")) return;
    const spell = originItem(effect);
    if((spell?.type !== "spell") || !spell.system?.duration?.concentration) return;
    const concentration = spell.actor?.effects?.find?.(e => e.statuses?.has?.(CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating") && (e.getFlag("dnd5e", "item")?.id === spell.id));
    if(concentration) effect.updateSource({ "flags.dnd5e.dependentOn" : concentration.uuid });
  }

  /* Can't benefit from Invisible (Faerie Fire, Starry Wisp) : its Invisible effects are switched off while this lasts (an
     Invisibility spell isn't ended, it just does nothing), and back on after; the token shows again (the active GM) */
  static async revealInvisible(effect, on){
    const actor = effect?.parent;
    if(!effect?.getFlag?.(module.id, "rule")?.noInvisible || (actor?.documentName !== "Actor") || !game.users.activeGM?.isSelf) return;
    if(on){
      /* A GM-hidden token (hiding, unseen) is shown : it's outlined in light now (hidden again when it ends) */
      const tokens = actor.isToken ? [actor.token] : actor.getActiveTokens(false, true).map(t => t.document ?? t);
      const unhid = tokens.filter(t => t?.hidden);
      for(const token of unhid) await token.update({ hidden : false }).catch(error => log.debug(error));
      if(unhid.length) await effect.setFlag(module.id, "unhid", unhid.map(t => t.uuid)).catch(() => {});
      const invisible = actor.effects.filter(e => (e !== effect) && !e.disabled && e.statuses?.has?.("invisible"));
      if(!invisible.length) return;
      await actor.updateEmbeddedDocuments("ActiveEffect", invisible.map(e => ({ _id : e.id, disabled : true }))).catch(error => log.debug(error));
      await effect.setFlag(module.id, "revealed", invisible.map(e => e.id)).catch(() => {});
    }
    else {
      /* Another such effect still on it : it stays shown */
      if(this.withRule(actor, "noInvisible").some(e => e.id !== effect.id)) return;
      for(const uuid of effect.getFlag(module.id, "unhid") ?? []){
        const token = fromUuidSync(uuid, { strict : false });
        if(token && !token.hidden) await token.update({ hidden : true }).catch(error => log.debug(error));
      }
      const ids = (effect.getFlag(module.id, "revealed") ?? []).filter(id => actor.effects.has(id));
      if(ids.length) await actor.updateEmbeddedDocuments("ActiveEffect", ids.map(id => ({ _id : id, disabled : false }))).catch(error => log.debug(error));
    }
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
    /* Read whatever put the rule there (a spell, a feat's or a maneuver's effect) : no setting of its own */
    const actor = config.subject?.actor;
    const roll = config.rolls?.[0];
    if(!actor || !roll) return;
    roll.options ??= {};
    const used = [];
    for(const effect of this.withRule(actor, "nextAttack")){
      giveMode(roll, effect.getFlag(module.id, "rule").nextAttack, module.format("spellEffects.reason", { effect : effect.name }));
      used.push(effect.uuid);
    }
    for(const effect of this.withRule(actor, "attacksMode")){
      giveMode(roll, effect.getFlag(module.id, "rule").attacksMode, module.format("spellEffects.reason", { effect : effect.name }));
    }
    const target = this.targetOf(config);
    const theirs = target?.actor;
    for(const effect of this.withRule(theirs, "nextAttackAgainst")){
      giveMode(roll, effect.getFlag(module.id, "rule").nextAttackAgainst, module.format("spellEffects.reasonTarget", { effect : effect.name }));
      used.push(effect.uuid);
    }
    /* Only from an attacker who can see it (magical darkness, a Blinded attacker : no) */
    const seen = !!target && (!tokenOf(actor) || canSee(tokenOf(actor), target));
    for(const effect of this.withRule(theirs, "attackersMode")){
      if(seen) giveMode(roll, effect.getFlag(module.id, "rule").attackersMode, module.format("spellEffects.reasonTarget", { effect : effect.name }));
    }
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

  /* An AC bonus only against one kind of attack : taken off the card's AC for the other kind */
  static acOnlyAgainst(activity, attack, target, actor){
    if(!Number.isFinite(target?.ac)) return;
    let action = "";
    try { action = String(activity?.getActionType?.(attack?.options?.attackMode) ?? ""); } catch {}
    const kind = action.startsWith("m") ? "melee" : action.startsWith("r") ? "ranged" : "";
    for(const effect of this.withRule(actor, "acOnlyAgainst")){
      if(effect.getFlag(module.id, "rule").acOnlyAgainst === kind) continue;
      const bonus = [...(effect.system?.changes ?? effect.changes ?? [])].filter(c => c.key === "system.attributes.ac.bonus")
        .reduce((sum, c) => sum + (Number(dnd5e.utils.simplifyBonus(c.value, actor.getRollData())) || 0), 0);
      target.ac -= bonus;
    }
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

  /* A save against a creature type it's protected from, putting a condition on it (Protection from Evil and Good) :
     an automatic success (marked, still rolled), or advantage when it already has that condition */
  static protectedSave(config, message){
    const actor = config?.subject;
    const effects = this.withRule(actor, "attackersOfTypes").filter(e => e.getFlag(module.id, "rule").attackersOfTypes?.resist?.length);
    if(!effects.length || !this.enabled()) return;
    const card = game.messages.get(message?.data?.system?.origin);
    const source = card?.getAssociatedActor?.();
    if(!card || !source) return;
    const type = source.system?.details?.type?.value ?? "";
    const applied = getAppliedConditions(card);
    for(const effect of effects){
      const { types = [], resist = [] } = effect.getFlag(module.id, "rule").attackersOfTypes;
      const against = resist.filter(c => applied.has(c));
      if(!types.includes(type) || !against.length) continue;
      if(against.some(c => actor.statuses?.has(c))){ config.advantage = true; log.debug("Save advantage", actor.name, effect.name); }
      else { foundry.utils.setProperty(message, `data.flags.${module.id}.autoSuccess`, effect.name); log.debug("Automatic save success", actor.name, effect.name); }
      return;
    }
  }

  /* ---------- Sanctuary ---------- */

  /* An attack roll, or a spell that deals damage */
  static harmful(activity){
    if(activity?.type === "attack") return true;
    const damaging = (activity?.type === "save") || (activity?.type === "damage");
    return damaging && (activity.item?.type === "spell") && !!(activity.damage?.parts?.length);
  }

  /* Its targets : a warded one makes the attacker save first; failed, a new target (or nothing) */
  static async sanctuaryCheck(activity, tokens){
    if(!this.enabled() || !this.harmful(activity)) return tokens;
    const attacker = activity.actor;
    const out = [];
    for(const token of tokens){
      const ward = this.withRule(token.actor, "sanctuary")[0];
      if(!ward || (token.actor === attacker)){ out.push(token); continue; }
      const caster = originItem(ward)?.actor;
      const dc = Number(caster?.system?.attributes?.spell?.dc) || 13;
      /* Its header says why : Sanctuary, who's warded */
      const flavor = module.format("spellEffects.sanctuarySave", { name : attacker.name, target : token.name, ability : game.i18n.localize(CONFIG.DND5E.abilities.wis?.label ?? "Wisdom"), spell : originItem(ward)?.name ?? ward.name });
      const rolled = await attacker.rollSavingThrow({ ability : "wis", target : dc }, { configure : false }, { data : { flavor } });
      const roll = Array.isArray(rolled) ? rolled[0] : rolled;
      if(roll && (roll.total >= dc)){ out.push(token); continue; }
      ui.notifications.info(module.format("spellEffects.sanctuaryFailed", { name : attacker.name, target : token.name }));
      /* Target again : a different creature goes on; the same one, or none : the attack or spell is lost */
      const [other] = await pickTargets(activity.item, { count : 1, range : getRange(activity) || Infinity, disposition : "any", includeSelf : false, useTargets : false });
      if(other && (other !== token)) out.push(other);
      else ui.notifications.info(module.format("spellEffects.sanctuaryLost", { name : attacker.name, target : token.name }));
    }
    return out;
  }

  /* The warded creature attacks or casts a spell : its Sanctuary ends */
  static async sanctuaryEnds(activity){
    const actor = activity?.actor;
    if(!this.enabled() || !actor?.isOwner || !((activity.type === "attack") || (activity.item?.type === "spell"))) return;
    const wards = this.withRule(actor, "sanctuary");
    if(wards.length) await actor.deleteEmbeddedDocuments("ActiveEffect", wards.map(e => e.id),
      { [module.id] : { reason : module.format("spellEffects.sanctuaryEnded", { name : actor.name, what : activity.item?.name ?? "" }) } }).catch(() => {});
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

  /* Out of combat there are no turns : once a minute of game time (one hit, unless the GM moves the clock) */
  static usedLately(effect){
    if(game.combat?.started) return false;
    const at = effect.getFlag(module.id, "usedAt");
    return Number.isFinite(at) && ((game.time.worldTime - at) < 60);
  }

  /* Damage of a type it's protected from : less by the dice (once a turn in combat, once a minute out of it) */
  static reduceDamage(actor, damages, options){
    /* A preview (dnd5e's tray, a row's number) : no roll, nothing spent */
    if(!Array.isArray(damages) || !this.enabled() || !options?.[module.id]?.applying) return;
    for(const effect of this.withRule(actor, "reduceDamage")){
      const { type, dice = "1d4", oncePerTurn } = effect.getFlag(module.id, "rule").reduceDamage ?? {};
      const hit = damages.find(d => (d.type === type) && (Number(d.value) > 0));
      if(!hit) continue;
      const key = `reduce-${effect.id}`;
      if(oncePerTurn && (usedThisTurn(actor, key) || this.usedLately(effect))) continue;
      /* Rolled here (damage is worked out synchronously) : NdM dice, the same random source as Foundry's */
      const [, n = "1", faces = "4"] = /(\d*)d(\d+)/i.exec(dice) ?? [];
      const results = Array.from({ length : Number(n) || 1 }, () => Math.ceil((1 - CONFIG.Dice.randomUniform()) * Number(faces)) || 1);
      const total = results.reduce((sum, r) => sum + r, 0);
      /* Off that damage, and off the total dnd5e has already added up */
      const off = Math.min(total, Number(hit.value));
      hit.value = Number(hit.value) - off;
      if(Number.isFinite(damages.amount)) damages.amount = Math.max(0, damages.amount - off);
      if(oncePerTurn){
        markUsedThisTurn(actor, key).catch(() => {});
        if(!game.combat?.started && effect.isOwner) effect.setFlag(module.id, "usedAt", game.time.worldTime).catch(() => {});
      }
      /* Shown as a roll like any other (its dice in the dropdown), what it took off as its flavor */
      const typeLabel = game.i18n.localize(CONFIG.DND5E.damageTypes?.[type]?.label ?? type);
      const roll = Roll.fromData({ class : "Roll", formula : `${Number(n) || 1}d${faces}`, evaluated : true, total, options : {},
        terms : [{ class : "Die", number : Number(n) || 1, faces : Number(faces), modifiers : [], evaluated : true, options : { flavor : typeLabel },
          results : results.map(result => ({ result, active : true })) }] });
      ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }), rolls : [roll],
        flavor : module.format("spellEffects.reduced", { name : actor.name, effect : effect.name, n : total, dice, type : typeLabel }) }).catch(() => {});
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
    /* The card's rows apply only this one */
    uses.flag(ctx, { spellChoice : id, note : module.format("spellEffects.chosen", { effect : options.find(e => e.id === id)?.name ?? "" }) });
    return next();
  }

  static async applyAsGM({ actor : uuid, data } = {}){
    const actor = fromUuidSync(uuid, { strict : false });
    if(!actor || !data) return false;
    await actor.createEmbeddedDocuments("ActiveEffect", Array.isArray(data) ? data : [data]);
    return true;
  }
}
