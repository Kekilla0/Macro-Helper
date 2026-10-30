import { module } from '../module.js';
import { rollModes } from './roll-modes.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { patch } from '../patch.js';
import { spellEffects } from './spell-effects.js';
import { tokenOf, distanceBetween, canSee, isIncapacitated } from '../helpers/tokens.js';
import { clearLastDamage, isKilledOutright, setStatus } from '../helpers/actors.js';
import { giveMode, noteReason, conditionName, logReasons } from '../roll-item/reasons.js';
import { idOf, originItem } from '../helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * Condition rules dnd5e doesn't apply, on its own rolls (sheet, chat cards, Roll Item, pickAndAttack alike).
 *
 * Conditions on Attack Rolls : dnd5e 6 puts Poisoned (and, with 2014 rules, Exhaustion 3) in
 * CONFIG.DND5E.conditionEffects.attackDisadvantage, and Heavily Encumbered in physicalAttackDisadvantage, yet only
 * ability checks and saves read those lists. This adds the disadvantage to attack rolls.
 *
 * Condition & Downed Rules :
 *   attacks against a Blinded, Paralyzed, Petrified, Restrained, Stunned or Unconscious creature have advantage;
 *   against a Prone one, advantage within 5 ft and disadvantage beyond; against an Invisible one, disadvantage.
 *   An attacker who is Blinded, Prone or Restrained has disadvantage; one who is Invisible, advantage.
 *   A hit on a Paralyzed or Unconscious creature from within 5 ft is a critical hit (autoCrit, used for the damage).
 *   A character at 0 HP who takes damage fails a death save (two on a crit, once per card); a hit of at least its HP
 *   max, or massive damage while still up, is three failures. Three failures : Dead.
 *
 * Applied damage : each creature remembers the last damage it took and the card that dealt it (getLastDamage), until a
 * reaction uses it (clearLastDamage) or it rests, and what a card last applied to it (shown on the card's row).
 *
 * Every attack's advantage / disadvantage reasons are logged once rolled (roll-item/reasons.js).
 *
 * Toggling a condition off (token HUD, sheet) also removes the effects that carry only that condition (Shove's or
 * Thunderous Smite's "Prone"), not just dnd5e's own : otherwise the toggle adds a second one.
 *
 * Ends when (endsWhen) : the effects a rule names end when their creature is Incapacitated (Divine Sense, Starry Form,
 * Wrath of the Sea, Elemental Attunement, Rage), takes damage (Turned), equips Heavy armor or its combat ends (Rage), or
 * when the creature they came from is Incapacitated (Turned) : one on the creature is removed, an item's own is switched
 * off (the active GM), unless the rule ends them its own way.
 */
export class conditions{
  static register(){
    if(game.system.id !== "dnd5e") return;
    rollModes.add("conditions", config => this.onPreRollAttack(config));
    /* An effect from an item or spell whose conditions the creature is immune to (a Skeleton and Poisoned) : not put on */
    Hooks.on("preCreateActiveEffect", (effect, data, options, userId) => this.immuneEffect(effect, userId));
    /* Roll Item's cards : an automatic failure fails whatever is rolled, and no roll is needed for one */
    Hooks.on(`${module.id}.saveOutcome`, (message, outcome) => this.markAutoFail(message, outcome));
    Hooks.on(`${module.id}.autoFail`, (actor, ability, found) => { const name = this.autoFailOf(actor, ability); if(name) found.push(name); });
    Hooks.on(`${module.id}.rerollable`, message => !message?.getFlag?.(module.id, "autoFail"));
    /* A hit on a Paralyzed / Unconscious target from within 5 ft : Roll Item's damage is a crit */
    Hooks.on(`${module.id}.preDamage`, (activity, config, attack) => { if(this.autoCrit(activity, attack)) config.isCritical = true; });
    /* An effect on a creature named like a condition but without its status : the status added (its token icon, the rules) */
    Hooks.on("preCreateActiveEffect", effect => { this.statusFromName(effect); this.conditionIcon(effect); this.showOnToken(effect); });
    /* A token shows an icon for every condition it has : an effect giving more than its picture shows (Engulfed's
       Restrained, a grapple's Blinded) draws those conditions' icons beside it */
    Hooks.once("setup", () => patch.wrap("CONFIG.Token.objectClass.prototype._drawEffects", async function(wrapped, ...args){
      const result = await wrapped(...args);
      await conditions.drawConditionIcons(this);
      return result;
    }));
    patch.wrap("CONFIG.Actor.documentClass.prototype.toggleStatusEffect", async function(wrapped, statusId, options = {}){
      return conditions.toggleOff(this, statusId, options, wrapped);
    });
    Hooks.on("dnd5e.rollAttackV2", (rolls, { subject } = {}) => logReasons(subject, rolls?.[0]));
    Hooks.on("dnd5e.applyDamage", (actor, amount, options) => this.onApplyDamage(actor, amount, options));
    Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options) => this.onPreApplyDamage(actor, amount, updates, options));
    Hooks.on("dnd5e.preRollSavingThrowV2", (config, dialog, message) => this.onPreRollSave(config, message));
    Hooks.on("dnd5e.preRollDeathSaveV2", config => this.onPreRollDeathSave(config));
    /* A third success : Stable (dnd5e only resets the counts) */
    Hooks.on("dnd5e.rollDeathSaveV2", (rolls, details) => { if(details?.outcome === "stable") this.#stable.add(details.subject?.uuid); });
    Hooks.on("dnd5e.postRollDeathSave", (rolls, { subject } = {}) => this.onDeathSaved(subject));
    Hooks.on("updateActor", (actor, changes) => this.onHPChange(actor, changes));
    /* A rest is well past any reaction to a hit : forget it */
    Hooks.on("dnd5e.restCompleted", actor => clearLastDamage(actor));
    for(const hook of ["createActiveEffect", "updateActiveEffect"]) Hooks.on(hook, effect => this.onStatusEnds(effect));
    /* Damage : where it was applied (its owner's client), not only the GM's */
    Hooks.on("dnd5e.applyDamage", (actor, amount) => { if((amount > 0) && actor?.isOwner) this.endsOn(actor, "damaged", null, { here : true }); });
    Hooks.on("updateItem", (item, changes) => { if(foundry.utils.getProperty(changes ?? {}, "system.equipped")) this.onArmorEnds(item); });
    Hooks.on("createItem", item => { if(item.system?.equipped) this.onArmorEnds(item); });
    /* Its own attack roll or spell : on the client that made it */
    Hooks.on("dnd5e.rollAttackV2", (rolls, { subject } = {}) => { const actor = subject?.actor; if(actor?.isOwner) this.endsOn(actor, "attacks", null, { here : true }); });
    Hooks.on("dnd5e.postUseActivity", activity => { const actor = activity?.actor; if((activity?.item?.type === "spell") && actor?.isOwner) this.endsOn(actor, "casts", null, { here : true }); });
    Hooks.on("deleteCombat", combat => { for(const c of combat?.combatants ?? []) if(c.actor) this.endsOn(c.actor, "combatEnd"); });
    Hooks.on("updateActor", (actor, changes) => this.onSourceZeroHP(actor, changes));
    Hooks.on("updateToken", (tokenDoc, changes) => this.onApart(tokenDoc, changes));
    Hooks.on("createActiveEffect", effect => this.onRecast(effect));
  }

  /* ---------- Ends when ---------- */

  static #endsWhen = [];

  /**
   * The effect-lifetime lego : what a rule's effects end on, said once.
   *   conditions.endsWhen("rage", { incapacitated : true, heavyArmor : true, combatEnd : true, end })
   *   match          an item identifier (the effects that item puts on a creature, or its own switched-on effect), or
   *                  effect => boolean
   *   incapacitated  the creature with it has the Incapacitated condition (or one that brings it)
   *   damaged        it takes damage
   *   heavyArmor     it equips Heavy armor
   *   combatEnd      a combat it's in ends
   *   sourceDown     the creature it came from (its origin item's owner) is Incapacitated (Turned, when the Cleric drops)
   *   attacks        the creature with it makes an attack roll (just after it : the roll still had it; Invisibility)
   *   casts          it casts a spell (Invisibility)
   *   sourceZeroHP   the creature it came from drops to 0 Hit Points (Warding Bond)
   *   apart          feet : it and the creature it came from are farther apart than that (their tokens on the scene)
   *   recast         the same item's effect is put on its creature again, or on the creature it came from : the old one
   *                  ends (Warding Bond, "cast again on either of the connected creatures")
   *   end            (actor, effects, why) instead of the default : an item's own effect switched off, any other deleted
   * why : "incapacitated", "damaged", "heavyArmor", "combatEnd", "sourceDown", "attacks", "casts", "sourceZeroHP", "apart"
   * or "recast". The active GM's client ends them.
   * @param {string|Function} match
   * @param {object} rule
   */
  static endsWhen(match, rule = {}){
    this.#endsWhen.push({ ...rule, match });
  }

  /* The effects these items put on a creature (by identifier) end when it's Incapacitated */
  static endOnIncapacitated(...ids){
    for(const id of ids) this.endsWhen(id, { incapacitated : true });
  }

  /* The item an effect comes from : the item it's on, or its origin's */
  static #itemOf(effect){
    return (effect?.parent?.documentName === "Item") ? effect.parent : originItem(effect);
  }

  static #matches(rule, effect){
    if(typeof rule.match === "function") return !!rule.match(effect);
    return idOf(this.#itemOf(effect)) === rule.match;
  }

  /* An actor's live effects that end on this */
  static #endingOn(actor, why){
    const rules = this.#endsWhen.filter(r => r[why]);
    const found = new Map();
    for(const e of [...(actor?.allApplicableEffects?.() ?? actor?.effects ?? [])]){
      if(e.disabled) continue;
      const rule = rules.find(r => this.#matches(r, e));
      if(rule) found.set(e, rule);
      /* An effect made to end so (Starry Form's) */
      else if((why === "incapacitated") && e.getFlag?.(module.id, "endsOnIncapacitated")) found.set(e, {});
    }
    return found;
  }

  static #ending = new Set();

  /**
   * End the effects on this creature that end on `why` (the active GM).
   * @param {Actor} actor
   * @param {string} why
   * @param {Map} [found]  effect -> rule, when already known
   * @param {object} [options]
   * @param {boolean} [options.here]  on this client (its owner's), not the active GM's
   */
  static async endsOn(actor, why, found = null, { here = false } = {}){
    if(!actor || (!here && !game.users.activeGM?.isSelf)) return;
    found ??= this.#endingOn(actor, why);
    if(!found.size) return;
    /* One rule's effects together (its own end gets them all at once) */
    const byRule = new Map();
    for(const [effect, rule] of found){
      if(this.#ending.has(effect.uuid)) continue;
      if(!byRule.has(rule)) byRule.set(rule, []);
      byRule.get(rule).push(effect);
    }
    for(const [rule, effects] of byRule){
      for(const e of effects) this.#ending.add(e.uuid);
      try {
        if(rule.end) await rule.end(actor, effects, why);
        else for(const e of effects){
          if(e.parent?.documentName === "Item") await e.update({ disabled : true });
          else await e.delete();
        }
        log.debug("Ends :", why, actor.name, effects.map(e => e.name));
      }
      catch(error){ log.debug("Already gone", error); }
      finally { for(const e of effects) this.#ending.delete(e.uuid); }
    }
  }

  static #busy = Promise.resolve();

  /* A status landed : Incapacitated ends its own effects, and those that came from it (sourceDown). Several status
     changes arrive together (Unconscious brings Incapacitated) : one at a time */
  static onStatusEnds(effect){
    const run = this.#busy.then(() => this.#statusEnds(effect));
    this.#busy = run.catch(() => {});
    return run;
  }

  static async #statusEnds(effect){
    if(!game.users.activeGM?.isSelf) return;
    const actor = (effect?.parent?.documentName === "Actor") ? effect.parent : effect?.parent?.actor;
    if(!isIncapacitated(actor)) return;
    await this.endsOn(actor, "incapacitated");
    await this.#fromSource(actor, "sourceDown");
  }

  /* The effects on other creatures that came from this one and end on `why` : effect -> rule, by creature */
  static #othersFrom(actor, why, filter = () => true){
    const out = new Map();
    if(!this.#endsWhen.some(r => r[why])) return out;
    const mine = item => item?.actor && ((item.actor.uuid === actor.uuid) || (item.actor.id === actor.id));
    const others = [...game.actors, ...(canvas.tokens?.placeables ?? []).filter(t => t.actor && !t.document.actorLink).map(t => t.actor)];
    for(const other of new Set(others)){
      if(other === actor) continue;
      const found = new Map([...this.#endingOn(other, why)].filter(([e, rule]) => mine(this.#itemOf(e)) && filter(e, rule, other)));
      if(found.size) out.set(other, found);
    }
    return out;
  }

  static async #fromSource(actor, why, filter){
    for(const [other, found] of this.#othersFrom(actor, why, filter)) await this.endsOn(other, why, found);
  }

  /* Dropped to 0 Hit Points : what came from it and ends so (the active GM) */
  static onSourceZeroHP(actor, changes){
    if(!game.users.activeGM?.isSelf || !foundry.utils.hasProperty(changes ?? {}, "system.attributes.hp.value")) return;
    if(Number(actor?.system?.attributes?.hp?.value) > 0) return;
    return this.#fromSource(actor, "sourceZeroHP");
  }

  /* Too far apart : a token moved, its effects from others and others' from it measured (the active GM) */
  static async onApart(tokenDoc, changes){
    if(!game.users.activeGM?.isSelf || !["x", "y", "elevation"].some(k => k in (changes ?? {}))) return;
    const actor = tokenDoc?.actor;
    if(!actor || !this.#endsWhen.some(r => r.apart)) return;
    const far = (a, b, feet) => {
      const ta = (a === actor) ? (tokenDoc.object ?? tokenDoc) : tokenOf(a);
      const tb = (b === actor) ? (tokenDoc.object ?? tokenDoc) : tokenOf(b);
      if(!ta || !tb) return false;
      if((ta.document ?? ta).parent !== (tb.document ?? tb).parent) return true;
      return distanceBetween(ta, tb) > Number(feet);
    };
    const own = new Map([...this.#endingOn(actor, "apart")].filter(([e, rule]) => {
      const source = this.#itemOf(e)?.actor;
      return source && (source !== actor) && far(actor, source, rule.apart);
    }));
    if(own.size) await this.endsOn(actor, "apart", own);
    await this.#fromSource(actor, "apart", (e, rule, other) => far(actor, other, rule.apart));
  }

  /* The same item's effect again on a creature it linked : the old links end, this creature's own and those it made */
  static async onRecast(effect){
    if(!game.users.activeGM?.isSelf || (effect?.parent?.documentName !== "Actor")) return;
    const rule = this.#endsWhen.find(r => r.recast && this.#matches(r, effect));
    if(!rule) return;
    const actor = effect.parent;
    const same = e => (e !== effect) && (e.id !== effect.id) && this.#matches(rule, e);
    const own = new Map([...this.#endingOn(actor, "recast")].filter(([e]) => same(e)));
    if(own.size) await this.endsOn(actor, "recast", own);
    await this.#fromSource(actor, "recast", e => same(e));
  }

  /* Heavy armor put on */
  static onArmorEnds(item){
    if((item?.type !== "equipment") || (item.system?.type?.value !== "heavy") || !item.actor) return;
    return this.endsOn(item.actor, "heavyArmor");
  }

  /* An effect named like a condition, put on a creature (Shove's "Prone", Thunderous Smite's) : the condition itself
     (the rules), and the condition's own icon on the token instead of its item's picture (a fist, a spell) */
  static statusFromName(effect){
    if(effect?.parent?.documentName !== "Actor") return;
    const name = String(effect.name ?? "").trim().toLowerCase();
    const status = name && CONFIG.statusEffects.find(s => game.i18n.localize(s.name ?? "").toLowerCase() === name);
    if(!status) return;
    const change = {};
    if(!effect.statuses?.has?.(status.id)) change.statuses = [...(effect.statuses ?? []), status.id];
    if(status.img && (effect.img !== status.img)) change.img = status.img;
    if(Object.keys(change).length) effect.updateSource(change);
  }

  /* An effect that gives one of the rules' conditions shows dnd5e's icon for it, whatever it's named (Wrathful Smite's
     Frightened, Hold Person's Paralyzed); several conditions, a pseudo one (Burning, Diseased) or none (Rage) : its own.
     dnd5e's own status effects (Exhaustion's levels) and effects that keep their picture (Engulfed, Attached) aren't touched. */
  static conditionIcon(effect){
    if((effect?.parent?.documentName !== "Actor") || effect.transfer || effect.getFlag?.(module.id, "ownImg")) return;
    const types = CONFIG.DND5E?.conditionTypes ?? {};
    const found = this.conditionsOf(effect);
    if(found.length !== 1) return;
    const status = CONFIG.statusEffects.find(s => s.id === found[0]);
    if(status?._id && (effect.id === status._id || effect._id === status._id)) return;
    const img = status?.img ?? types[found[0]].img;
    if(img && (effect.img !== img)) effect.updateSource({ img });
  }

  /* The rules' conditions an effect gives, without those another of them already brings (Paralyzed's Incapacitated) */
  static conditionsOf(effect){
    const types = CONFIG.DND5E?.conditionTypes ?? {};
    const ids = [...(effect?.statuses ?? [])].filter(id => types[id] && !types[id].pseudo);
    const implied = new Set(ids.flatMap(id => [...(CONFIG.statusEffects.find(s => s.id === id)?.statuses ?? []), ...(types[id].statuses ?? [])]));
    return ids.filter(id => !implied.has(id));
  }

  /* The icons Foundry left out : each condition whose icon no shown effect already has, one per condition */
  static async drawConditionIcons(token){
    const SHOW = CONST.ACTIVE_EFFECT_SHOW_ICON;
    const shown = token.actor?.appliedEffects?.filter(e => (e.showIcon === SHOW.ALWAYS) || ((e.showIcon === SHOW.CONDITIONAL) && e.isTemporary)) ?? [];
    if(!shown.length || !token.effects) return;
    const have = new Set(shown.map(e => e.img));
    const extra = [];
    for(const effect of shown){
      for(const id of this.conditionsOf(effect)){
        const img = CONFIG.statusEffects.find(s => s.id === id)?.img ?? CONFIG.DND5E.conditionTypes[id]?.img;
        if(img && !have.has(img)){ have.add(img); extra.push(img); }
      }
    }
    if(!extra.length) return;
    const start = token.effects.children.length;
    const icons = await Promise.all(extra.map(img => token._drawEffect(img, null)));
    icons.forEach((icon, i) => { if(icon) icon.zIndex = start + i; });
    token.effects.sortChildren();
    token.renderFlags.set({ refreshEffects : true });
  }

  /* Off (or a toggle while it's on) : the effects carrying only this condition go too, then dnd5e's own if it has one */
  static async toggleOff(actor, statusId, options, wrapped){
    if(options?.active === true) return wrapped(statusId, options);
    const own = CONFIG.statusEffects[statusId]?._id;
    const others = actor.effects.filter(e => (e.id !== own) && (e.statuses?.size === 1) && e.statuses.has(statusId));
    if(!others.length) return wrapped(statusId, options);
    await actor.deleteEmbeddedDocuments("ActiveEffect", others.map(e => e.id));
    if(own && actor.effects.has(own)) await wrapped(statusId, { ...options, active : false });
    return false;
  }

  /* An effect put on a creature shows on its token, even without a duration (Foundry otherwise hides those); one
     without a picture gets its item's, else a plain one. Effects a creature's own items carry aren't touched */
  static showOnToken(effect){
    if((effect?.parent?.documentName !== "Actor") || effect.transfer) return;
    const SHOW = CONST.ACTIVE_EFFECT_SHOW_ICON;
    const change = {};
    if(SHOW && (effect.showIcon === SHOW.CONDITIONAL)) change.showIcon = SHOW.ALWAYS;
    if(!effect.img){
      const origin = effect.origin ? fromUuidSync(effect.origin, { strict : false }) : null;
      change.img = origin?.img ?? "icons/svg/aura.svg";
    }
    if(Object.keys(change).length) effect.updateSource(change);
  }

  static onPreRollAttack(config){
    const actor = config.subject?.actor;
    const roll = config.rolls?.[0];
    if(!actor || !roll) return;
    roll.options ??= {};

    /* Reasons given with the roll (Roll Item : chosen, keys, long range...) */
    for(const { mode, reason } of config[module.id]?.reasons ?? []) noteReason(roll, mode, reason);
    /* Who it's aimed at, on the roll already (the reasons log runs before Roll Item stamps it : each ray its own) */
    const target = config[module.id]?.target;
    if(target) roll.options[module.id] = { ...(roll.options[module.id] ?? {}), target };

    if(settings.value("conditionAttacks") && this.hasAttackDisadvantage(actor, config.ability)){
      giveMode(roll, "disadvantage", module.format("reasons.attackerIs", { condition : this.disadvantageConditions(actor).join(", ") || module.i18n("reasons.conditions") }));
    }

    if(settings.value("downedRules")) this.applyConditionRules(config, roll);
  }

  /**
   * Does a condition give this actor disadvantage on its attack rolls ?
   * @param {Actor} actor
   * @param {string} [ability]  the attack's ability, for conditions that only hit Strength / Dexterity attacks
   * @returns {boolean}
   */
  static hasAttackDisadvantage(actor, ability){
    if(typeof actor?.hasConditionEffect !== "function") return false;
    if(actor.hasConditionEffect("attackDisadvantage")) return true;
    const physical = CONFIG.DND5E.abilities[ability]?.type === "physical";
    return physical && actor.hasConditionEffect("physicalAttackDisadvantage");
  }

  /* The token an attack is aimed at : Roll Item says, else your one target */
  static targetOf(config){
    const given = config?.[module.id]?.target;
    if(given) return fromUuidSync(given, { strict : false })?.object ?? null;
    return (game.user.targets.size === 1) ? game.user.targets.first() : null;
  }


  /* ---------- Conditions on attacks, auto-crits, death saves ---------- */

  static AGAINST_ADVANTAGE = ["blinded", "paralyzed", "petrified", "restrained", "stunned", "unconscious"];
  static ATTACKER_DISADVANTAGE = ["blinded", "prone", "restrained"];
  static AUTO_CRIT = ["paralyzed", "unconscious"];

  /* Within 5 ft (one grid unit) of each other */
  static within5(a, b){
    return !!a && !!b && (distanceBetween(a, b) <= (canvas.scene?.grid.distance ?? 5));
  }

  static applyConditionRules(config, roll){
    const activity = config.subject;
    const attacker = tokenOf(activity?.actor);
    const mine = activity?.actor?.statuses ?? new Set();
    const is = id => module.format("reasons.attackerIs", { condition : conditionName(id) });
    const their = id => module.format("reasons.targetIs", { condition : conditionName(id) });
    for(const id of this.ATTACKER_DISADVANTAGE.filter(s => mine.has(s))) giveMode(roll, "disadvantage", is(id));
    /* Invisible, unless an effect takes that away (Starry Wisp) */
    if(mine.has("invisible") && !spellEffects.has(activity?.actor, "noInvisible")) giveMode(roll, "advantage", is("invisible"));

    const target = this.targetOf(config);
    const theirs = target?.actor?.statuses;
    if(!theirs) return;
    for(const id of this.AGAINST_ADVANTAGE.filter(s => theirs.has(s))) giveMode(roll, "advantage", their(id));
    if(theirs.has("prone")){
      if(this.within5(attacker, target)) giveMode(roll, "advantage", module.i18n("reasons.proneNear"));
      else giveMode(roll, "disadvantage", module.i18n("reasons.proneFar"));
    }
    if(theirs.has("invisible") && !spellEffects.has(target.actor, "noInvisible")) giveMode(roll, "disadvantage", their("invisible"));
    /* Sight, worked out once for this roll */
    const sees = attacker ? { target : canSee(attacker, target), attacker : canSee(target, attacker) } : { target : true, attacker : true };
    log.debug("Sight", attacker?.name, "sees", target.name, sees.target, "|", target.name, "sees", attacker?.name, sees.attacker);
    /* Dodging : only against an attacker it can see */
    if(theirs.has("dodging") && sees.attacker) giveMode(roll, "disadvantage", their("dodging"));
    this.applySight(attacker, target, mine, theirs, roll, sees);
  }

  /**
   * Sight (Vision Rules) : attacking a creature you can't see has disadvantage; attacking one that can't see you has
   * advantage. Blinded and Invisible already say so above; this adds darkness, walls and no darkvision.
   */
  static applySight(attacker, target, mine, theirs, roll, sees){
    if(!attacker || !target) return;
    sees ??= { target : canSee(attacker, target), attacker : canSee(target, attacker) };
    const explained = s => mine.has("blinded") || theirs.has(s);
    if(!sees.target && !explained("invisible")) giveMode(roll, "disadvantage", module.i18n("reasons.cantSeeTarget"));
    if(!sees.attacker && !theirs.has("blinded") && !theirs.has("unconscious") && !mine.has("invisible")) giveMode(roll, "advantage", module.i18n("reasons.unseenAttacker"));
  }

  /* ---------- Saves : automatic failures, outcomes ---------- */

  static AUTO_FAIL = ["paralyzed", "petrified", "stunned", "unconscious"];

  /**
   * Does a creature automatically fail this save ? STR and DEX saves while Paralyzed, Petrified, Stunned or Unconscious.
   * @param {Actor} actor
   * @param {string} ability
   * @returns {string|null}  the condition's name
   */
  static autoFailOf(actor, ability){
    if(!settings.value("downedRules") || !["str", "dex"].includes(ability)) return null;
    const id = this.AUTO_FAIL.find(s => actor?.statuses?.has(s));
    return id ? conditionName(id) : null;
  }

  /* An automatic failure is still rolled (so it's logged and linked to its card), and marked : it fails whatever the d20 */
  static onPreRollSave(config, message){
    const name = this.autoFailOf(config.subject, config.ability);
    if(!name || !message) return;
    foundry.utils.setProperty(message, `data.flags.${module.id}.autoFail`, name);
    log.debug("Automatic save failure", config.subject?.name, config.ability, name);
  }

  /**
   * How a save message turned out, for everything reading it (card rows, Grapple / Shove, dnd5e's damage tray).
   * @param {ChatMessage} message   a dnd5e save message
   * @returns {{ total : number, success : boolean, auto : string|null }|null}  null when it has no d20 roll
   */
  static saveOutcome(message){
    const [roll] = message?.rolls ?? [];
    if(!(roll instanceof CONFIG.Dice.D20Roll)) return null;
    return this.markAutoFail(message, { total : roll.total, success : !!(roll.isSuccess || message.system?.forceSuccess), auto : null });
  }

  /* An automatic failure marked on the save (onPreRollSave) : a failure, named */
  static markAutoFail(message, outcome){
    const auto = message?.getFlag?.(module.id, "autoFail") ?? null;
    if(auto && outcome){ outcome.auto = auto; outcome.success = false; }
    return outcome;
  }

  static immuneEffect(effect, userId){
    const actor = effect?.parent;
    if((actor?.documentName !== "Actor") || !effect.origin) return;
    const statuses = [...(effect.statuses ?? [])];
    const immunities = actor.system?.traits?.ci?.value;
    if(!statuses.length || !immunities || !statuses.every(s => immunities.has?.(s))) return;
    if(userId === game.user.id) ui.notifications.info(module.format("conditions.immuneEffect", { name : actor.name, effect : effect.name }));
    return false;
  }

  /* ---------- Stable ---------- */

  /* A Stable creature makes no death saves */
  static onPreRollDeathSave(config){
    const actor = config.subject;
    if(!actor?.statuses?.has("stable")) return;
    ui.notifications.info(module.format("actions.stabilize.noSave", { name : actor.name }));
    return false;
  }

  static #stable = new Set();

  /* Three death save successes : the creature is Stable */
  static async onDeathSaved(actor){
    if(!this.#stable.delete(actor?.uuid) || !actor.isOwner || actor.statuses?.has("stable")) return;
    if(Number(actor.system?.attributes?.hp?.value) > 0) return;
    await setStatus(actor, "stable", true);
  }

  /* Stable ends when it regains HP or takes damage */
  static async onHPChange(actor, changes){
    if(!actor?.isOwner || !actor.statuses?.has("stable")) return;
    const hp = foundry.utils.getProperty(changes ?? {}, "system.attributes.hp.value");
    if(hp === undefined) return;
    /* One client does it : the active GM, or the owner when no GM is on */
    if(!(game.users.activeGM ? game.users.activeGM.isSelf : true)) return;
    await actor.toggleStatusEffect("stable", { active : false });
  }

  /* The attacker's conditions dnd5e says give attacks disadvantage (Poisoned, Frightened, Exhaustion...) */
  static disadvantageConditions(actor){
    const effects = CONFIG.DND5E?.conditionEffects ?? {};
    const ids = new Set([...(effects.attackDisadvantage ?? []), ...(effects.physicalAttackDisadvantage ?? [])]);
    return [...(actor?.statuses ?? [])].filter(s => ids.has(s)).map(s => conditionName(s));
  }

  /**
   * The attacker's own conditions that give every attack disadvantage (whoever it's aimed at), for the pick map.
   * None when it's Invisible too (advantage cancels it out).
   * @param {Actor} actor
   * @param {string} [ability]
   * @returns {string[]}  condition names
   */
  static attackerDisadvantages(actor, ability){
    if(game.system.id !== "dnd5e" || !actor) return [];
    const statuses = actor.statuses ?? new Set();
    const downed = settings.value("downedRules");
    if(downed && statuses.has("invisible")) return [];
    const names = downed ? this.ATTACKER_DISADVANTAGE.filter(s => statuses.has(s)).map(s => conditionName(s)) : [];
    if(settings.value("conditionAttacks") && this.hasAttackDisadvantage(actor, ability)){
      names.push(...(this.disadvantageConditions(actor).length ? this.disadvantageConditions(actor) : [module.i18n("reasons.conditions")]));
    }
    return [...new Set(names)];
  }

  /**
   * Is this hit a critical hit because of its target : Paralyzed or Unconscious, the attacker within 5 ft ?
   * The target is the token the attack was aimed at (Roll Item notes it on the roll).
   * @param {Activity} activity
   * @param {D20Roll} attack
   * @returns {boolean}
   */
  static autoCrit(activity, attack){
    if(!settings.value("downedRules") || !attack || attack.isCritical || attack.isFumble) return false;
    const uuid = attack.options?.[module.id]?.target;
    const target = uuid ? fromUuidSync(uuid, { strict : false })?.object : null;
    if(!target?.actor || !this.AUTO_CRIT.some(s => target.actor.statuses?.has(s))) return false;
    const ac = attack.options?.target;
    if(Number.isFinite(ac) && (attack.total < ac)) return false;
    return this.within5(tokenOf(activity?.actor), target);
  }

  /* Did the card that dealt this damage roll it as a crit ? */
  static wasCritical(origin){
    return !!origin?.rolls?.some?.(r => r?.options?.isCritical);
  }

  /* Death saves : damage to a character at 0 HP is a failure (two on a crit); its HP max in one hit, or massive damage
     while still up, is three. Changes dnd5e's pending update, nothing awaited. */
  static onPreApplyDamage(actor, amount, updates, options = {}){
    /* Temporary HP given (Armor of Agathys) : dnd5e reports it as 0 damage, onApplyDamage records it from here */
    const temp = Number(updates?.["system.attributes.hp.temp"]) - (Number(actor?.system?.attributes?.hp?.temp) || 0);
    if(!amount && (temp > 0) && options) options[`${module.id}TempGiven`] = temp;
    if(!settings.value("downedRules") || (actor?.type !== "character") || !(amount > 0) || !updates) return;
    const hp = actor.system.attributes?.hp ?? {};
    const death = actor.system.attributes?.death ?? {};
    const max = Number(hp.max) || 0;
    const key = "system.attributes.death.failure";
    if((Number(hp.value) || 0) <= 0){
      if(actor.statuses?.has("stable") && actor.isOwner) actor.toggleStatusEffect("stable", { active : false });
      if(!(max > 0)) return;
      const hurt = amount - (Number(hp.temp) || 0);
      if(hurt <= 0) return;
      /* One hit, one failure : more damage from the same card (its other parts, a rider) doesn't add more */
      const last = actor.getFlag?.(module.id, "lastDamage");
      if(options.origin?.id && (last?.message === options.origin.id)) return;
      updates[key] = (hurt >= max) ? 3 : Math.min(3, (Number(death.failure) || 0) + (this.wasCritical(options.origin) ? 2 : 1));
      log.debug("Death save failures", actor.name, updates[key]);
    }
    else if(isKilledOutright(actor, amount)){
      updates[key] = 3;
      log.debug("Massive damage", actor.name);
    }
  }

  /* Remember the last damage a creature took and the card it came from (Stone's Endurance...); what was applied from
     a card (damage or healing) shows on its row; a third death save failure means Dead */
  static async onApplyDamage(actor, amount, options = {}){
    /* Temporary HP shows on its row as healing does (+5) */
    if(!amount && options[`${module.id}TempGiven`]) amount = -options[`${module.id}TempGiven`];
    if(!amount || !actor?.isOwner) return;
    const message = options.origin?.id ?? null;
    const update = {};
    if(amount > 0) update[`flags.${module.id}.lastDamage`] = { amount, message, at : Date.now() };
    /* By card and part ("rows", "hits", dnd5e's "tray") : shown on the card, and applied only once. A hit's box dealt
       several parts at once (parts) : the amount on the first, the others marked 0 */
    if(message){
      const own = options[module.id] ?? {};
      const parts = own.parts?.length ? own.parts : [own.part ?? "tray"];
      parts.forEach((part, i) => update[`flags.${module.id}.applied.${message}.${part}`] = i ? 0 : amount);
      /* Only the last cards are kept */
      const cards = Object.keys(actor.getFlag?.(module.id, "applied") ?? {}).filter(id => id !== message);
      for(const old of cards.slice(0, Math.max(0, cards.length - (this.APPLIED_KEPT - 1)))){
        update[`flags.${module.id}.applied.${old}`] = globalThis._del ?? new foundry.data.operators.ForcedDeletion();
      }
    }
    if(Object.keys(update).length) await actor.update(update);
    await this.markDead(actor);
  }

  /* How many cards' applied amounts a creature remembers */
  static APPLIED_KEPT = 30;

  /* Three death save failures : Dead (dnd5e only does it in combat, with its downed setting on "all creatures") */
  static async markDead(actor){
    if(!settings.value("downedRules") || (actor?.type !== "character") || !actor.isOwner) return;
    if((Number(actor.system.attributes?.death?.failure) || 0) < 3 || actor.statuses?.has("dead")) return;
    await actor.toggleStatusEffect("dead", { active : true, overlay : true });
    log.debug("Dead", actor.name);
  }
}
