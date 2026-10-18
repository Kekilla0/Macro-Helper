import { module } from '../module.js';
import { rollModes } from './roll-modes.js';
import { giveMode } from '../roll-item/reasons.js';
import { settings } from '../settings.js';
import { limits } from './limits.js';
import { logger } from '../log.js';
import { distanceBetween } from '../helpers/tokens.js';
import { getSize, rollSave, setStatus, addTimedEffect, usedThisTurn, markUsedThisTurn } from '../helpers/actors.js';
import { pickAttack, isRangedAttack } from '../helpers/items.js';
import { rollItem } from '../roll-item/roll-item.js';
const log = logger.for(import.meta.url);

/**
 * Weapon masteries (2024 rules) on Roll Item attack cards. dnd5e only names the mastery on its card; these do it.
 * dnd5e decides which mastery an attack uses (the weapon's, for actors who have mastered that kind of weapon, or one of
 * their bonus masteries), and puts it on the attack roll : options.mastery. Everything here keys off that.
 *
 *   Graze   miss  : damage equal to the attack's ability modifier, the weapon's damage type. Rolled with the attack,
 *                   shown with its own APPLY tray when the attack misses (or when there's no target to judge by).
 *   Topple  hit   : button, the target makes a CON save (DC 8 + ability mod + proficiency), Prone on a failure.
 *   Push    hit   : button, the target (Large or smaller) is pushed 10 ft straight away, stopping at walls.
 *   Sap     hit   : button, the target has Disadvantage on its next attack roll before the start of your next turn.
 *   Slow    hit   : button, the target's Speed drops 10 ft until the start of your next turn (doesn't stack).
 *   Vex     hit   : button, you have Advantage on your next attack roll against it before the end of your next turn.
 *   Cleave  hit   : button, once per turn : pick a second creature within 5 ft of the first and in your reach, attack it,
 *                   its damage without your ability modifier (unless that's negative).
 *   Nick          : the Light property's extra attack is part of the Attack action instead of a Bonus Action, once a
 *                   turn (masteries.nick : the Action Tracker asks), nothing to roll.
 *
 * Topple, Push, Sap, Slow and Vex change the target : outcomes, so only the GM sees and clicks those : a button on each
 * hit target's row (its token on the left, the mastery on the right, Topple's save result beside it), greyed out once
 * used on that target. Sap, Slow and Vex aren't optional : applying the hit's damage to that target applies them first
 * (before the damage lands), and greys the button too. Cleave is another attack : its roller's, a card button.
 */
export class masteries{
  static ACTIONS = ["topple", "push", "sap", "slow", "vex", "cleave"];

  static ICONS = {
    graze : "fa-droplet", topple : "fa-person-falling", push : "fa-hand", sap : "fa-face-dizzy",
    slow : "fa-hourglass-half", vex : "fa-crosshairs", cleave : "fa-axe", nick : "fa-khanda",
  };

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("rollItemMasteries");
  }

  /* Nick : this attack's weapon gives its wielder the Nick mastery (dnd5e's masteryOptions : mastered, or a bonus one) */
  static nick(activity){
    if(!this.enabled()) return false;
    return !!activity?.item?.system?.masteryOptions?.some?.(o => o.value === "nick");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    rollModes.add("masteries", config => this.onPreRollAttack(config));
    Hooks.on("dnd5e.rollAttackV2", rolls => this.onRollAttack(rolls));
    Hooks.on("dnd5e.preRollDamageV2", config => this.onPreRollDamage(config));
    /* Roll Item's attack cards : each attack's mastery section, and its button */
    foundry.applications.handlebars.loadTemplates({ [`${module.id}.mastery`] : `${module.path}/templates/mastery.hbs` });
    Hooks.on(`${module.id}.cardSections`, (message, sections, { ray } = {}) => { const section = this.cardSection(message, ray ?? null); if(section) sections.push(section); });
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray, event, button } = {}) => { if(id === "mastery") this.clicked(message, ray ?? null, event, button); });
    /* Every other push (Repelling Blast, a card macro's push part) : the same Homebrew collision as Push, else "blocked" */
    Hooks.on(`${module.id}.pushed`, (target, moved, feet, item, { name } = {}) => this.afterPush(target, moved, feet, item, name));
    Hooks.on(`${module.id}.beforeApplyDamage`, (message, actor, waits) => waits.push(this.beforeDamage(message, actor)));
    /* The outcome masteries : on each hit target's row */
    Hooks.on(`${module.id}.rowButtons`, (message, uuid, buttons, context = {}) => this.rowButtons(message, uuid, buttons, context));
    Hooks.on(`${module.id}.cardMoves`, (message, uuid, moves, context = {}) => this.pushMove(message, uuid, moves, context));
    Hooks.on(`${module.id}.rowButton`, (message, uuid, id, { button } = {}) => {
      if(!String(id).startsWith("mastery|")) return;
      const key = String(id).slice(8);
      this.clickedRow(message, (key === "single") ? null : Number(key), uuid, button);
    });
    /* Graze : its damage rolled with every attack, shown when the attack misses */
    rollItem.addRolls(async (activity, attack, damage) => {
      const rolls = await this.grazeRolls(activity, attack, damage);
      for(const roll of rolls) roll.options[module.id] = { part : "graze", onMiss : true };
      return rolls;
    });
  }

  /* ---------- Card ---------- */

  /* Has this attack's mastery been used from its card (on that target; a card from before the rows : on all) */
  static used(message, ray, uuid = null){
    const flag = message?.getFlag?.(module.id, `mastery.${this.rayKey(ray)}`);
    if((flag === true) || !uuid) return flag === true;
    return !!flag?.[this.uuidKey(uuid)];
  }

  static uuidKey(uuid){
    return String(uuid).replaceAll(".", "-");
  }

  /* A hit target's row : the outcome mastery's button (the GM's), its save result once rolled */
  static rowButtons(message, uuid, buttons, { result, ray = null } = {}){
    if(!this.enabled() || !game.user.isGM || !result?.hit) return;
    const key = message?.system?.masteryOf?.(ray);
    if(!this.ACTIONS.includes(key) || ["cleave", "push"].includes(key)) return;
    if(!message.system.hitTargets(ray).some(t => (t.document ?? t).uuid === uuid)) return;
    const done = message.getFlag(module.id, `mastery.${this.rayKey(ray)}`)?.[this.uuidKey(uuid)];
    const prone = (key === "topple") ? CONFIG.statusEffects.find(s => s.id === "prone") : null;
    buttons.push({
      id : `mastery|${this.rayKey(ray)}`,
      label : (key === "topple") ? module.format("rollItem.mastery.row.topple", { dc : this.toppleDC(message.getAssociatedActor(), message.system.attackOf(ray)?.options?.ability) })
        : this.buttonLabel(key, message.getAssociatedActor(), message.system.attackOf(ray)),
      tooltip : this.buttonLabel(key, message.getAssociatedActor(), message.system.attackOf(ray)),
      img : prone?.img ?? null,
      icon : this.ICONS[key] ?? "fa-star",
      disabled : this.used(message, ray, uuid),
      result : (typeof done === "object") ? done : null,
    });
  }

  /* Push : a hit target's move at the bottom of the card (the GM's), Large or smaller unless Rule Limits allows it */
  static pushMove(message, uuid, moves, { result, ray = null } = {}){
    if(!this.enabled() || !result?.hit || (message?.system?.masteryOf?.(ray) !== "push")) return;
    const target = fromUuidSync(uuid, { strict : false });
    if(!target?.actor) return;
    const attacker = message.getAssociatedActor();
    moves.push({ id : "masteryPush", feet : 10, name : this.label("push"), done : this.used(message, ray, uuid),
      allow : () => {
        if((getSize(target.actor)?.value ?? 2) <= 3) return true;
        const notes = [];
        const ok = limits.allow(module.format("rollItem.mastery.tooBig", { name : target.name }), { notes, who : attacker?.name, what : `Push ${target.name}` });
        for(const note of notes) ui.notifications.info(note);
        return ok;
      },
      after : () => message.setFlag(module.id, `mastery.${this.rayKey(ray)}`, { ...(message.getFlag(module.id, `mastery.${this.rayKey(ray)}`) ?? {}), [this.uuidKey(uuid)] : true }) });
  }

  static async clickedRow(message, ray, uuid, button){
    if(button) button.disabled = true;
    try {
      const notes = await this.apply(message, ray, uuid);
      for(const note of notes ?? []) ui.notifications.info(note);
    }
    catch(error){
      console.error("Macro Helper | mastery", error);
      ui.notifications.warn(error.message);
    }
  }

  /**
   * The mastery section of a Roll Item attack card for one attack : Graze's damage on a miss, or the button for a hit.
   * @param {ChatMessage} message
   * @param {number|null} ray
   * @returns {object|null}  { partial, context, applies }
   */
  static cardSection(message, ray){
    const card = message?.system;
    const key = card?.masteryOf?.(ray);
    if(!key || !this.enabled()) return null;
    const attack = card.attackOf(ray);
    const { targets, hits } = card.targetHits(ray);
    const missed = targets.length > hits.length;

    const grazeRolls = card.addedRollsOf(ray, "graze");
    const graze = (grazeRolls.length && (missed || !targets.length))
      ? { ...card.damageContextOf(grazeRolls), showTray : card.canApply, onMiss : !targets.length }
      : null;

    /* Cleave is another attack : its roller's. The rest change the target (Prone, moved, an effect) : outcomes the
       GM decides on, so only the GM sees those buttons. Cleave's own extra attack can't Cleave again. */
    const isCleave = !!attack?.options?.[module.id]?.tags?.noMod;
    /* The others are buttons on each hit target's row (rowButtons) */
    const canUse = (key === "cleave") && message.isOwner && !isCleave;
    const action = (canUse && hits.length) ? {
      label : this.buttonLabel(key, message.getAssociatedActor(), attack),
      used : this.used(message, ray),
    } : null;
    if(!graze && !action) return null;

    return {
      partial : `${module.id}.mastery`,
      applies : !!graze,
      context : {
        key, graze, action,
        label : this.label(key),
        icon : this.ICONS[key] ?? "fa-star",
        ray : Number.isInteger(ray) ? ray : "",
        hasRay : Number.isInteger(ray),
      },
    };
  }

  /* The card's mastery button : data-ray is the attack on a multi card, empty for a single attack */
  static async clicked(message, ray, event, button){
    if(button) button.disabled = true;
    try { await this.use(message, ray, event); }
    catch(error){
      console.error("Macro Helper | mastery", error);
      ui.notifications.warn(error.message);
    }
    finally { if(button) button.disabled = this.used(message, ray); }
  }

  static label(key){
    const config = CONFIG.DND5E.weaponMasteries?.[key];
    return config?.label ? game.i18n.localize(config.label) : (key ?? "");
  }

  /* Topple's DC : 8 + the attack's ability modifier + proficiency */
  static toppleDC(actor, ability){
    const mod = actor?.system.abilities?.[ability]?.mod ?? 0;
    return 8 + mod + (actor?.system.attributes?.prof ?? 0);
  }

  /* What the card's button says */
  static buttonLabel(key, actor, attack){
    if(key === "topple"){
      const ability = CONFIG.DND5E.abilities.con?.abbreviation ?? "CON";
      return module.format("rollItem.mastery.button.topple", { dc : this.toppleDC(actor, attack?.options?.ability), ability : ability.toUpperCase() });
    }
    return module.i18n(`rollItem.mastery.button.${key}`);
  }

  /**
   * Graze's damage for one attack : a flat roll of the attack's ability modifier, typed like the weapon's damage.
   * Rolled whatever the attack does, the card only shows it on a miss.
   * @param {Activity} activity
   * @param {D20Roll} attack
   * @param {DamageRoll[]} [damage]   the attack's damage, for its type
   * @returns {Promise<DamageRoll[]>}  untagged, empty without Graze or with a modifier of 0 or less
   */
  static async grazeRolls(activity, attack, damage = []){
    if(!this.enabled() || (attack?.options?.mastery !== "graze")) return [];
    const ability = attack.options.ability ?? activity.ability;
    const mod = activity.actor?.system.abilities?.[ability]?.mod ?? 0;
    if(mod <= 0) return [];

    const base = damage.find(r => r.options?.type);
    const type = base?.options.type ?? activity.item?.system.damage?.base?.types?.first?.();
    const roll = new CONFIG.Dice.DamageRoll(String(mod), {}, { type, properties : [...(base?.options.properties ?? [])] });
    await roll.evaluate();
    return [roll];
  }

  /* ---------- Using a mastery from the card ---------- */

  /**
   * The card's mastery button. Cleave is made by its roller (you pick and roll); the rest are the GM's to apply.
   * @param {ChatMessage} message
   * @param {number|null} ray   which attack on a multi-attack card, null for a single attack
   */
  static async use(message, ray, event){
    const key = message.system.masteryOf(ray);
    if(key === "cleave") return this.cleave(message, ray, event);
    if(!game.user.isGM) return;
    const notes = await this.apply(message, ray);
    for(const note of notes ?? []) ui.notifications.info(note);
  }

  /* Sap, Slow and Vex : no choice in them, so applying a hit's damage applies them first (the button greys, as if used) */
  static AUTO = ["sap", "slow", "vex"];

  static async beforeDamage(message, actor){
    const system = message?.system;
    if(!this.enabled() || !system?.masteryOf || !actor) return;
    const rays = system.rays?.length ? system.rays.map((_, i) => i) : [null];
    for(const ray of rays){
      const key = system.masteryOf(ray);
      if(!this.AUTO.includes(key)) continue;
      const attacker = message.getAssociatedActor();
      if(!(game.user.isGM || (actor.isOwner && ((key !== "vex") || attacker?.isOwner)))) continue;
      for(const token of system.hitTargets(ray).filter(t => t.actor?.uuid === actor.uuid)){
        const uuid = (token.document ?? token).uuid;
        if(this.used(message, ray, uuid)) continue;
        try { await this.apply(message, ray, uuid); }
        catch(error){ log.error(error); }
      }
    }
  }

  /**
   * Apply an outcome mastery (GM) : only to targets the card says were hit, once per target.
   * @param {string|null} [only]   one target's token uuid, else every hit target it hasn't been used on
   * @returns {Promise<string[]>}  notes to show (too big to push, blocked...)
   */
  static async apply(message, ray = null, only = null){
    const system = message?.system;
    if(!system?.masteryOf) throw new Error("Not a Roll Item attack card.");

    const key = system.masteryOf(ray);
    if(!this.ACTIONS.includes(key) || (key === "cleave")) throw new Error(`No mastery to use : ${key}`);
    if(this.used(message, ray)) return [module.i18n("rollItem.mastery.used")];

    const hit = system.hitTargets(ray);
    if(!hit.length) return [module.i18n("rollItem.mastery.noHit")];
    const targets = hit.filter(t => !only || ((t.document ?? t).uuid === only)).filter(t => !this.used(message, ray, (t.document ?? t).uuid));
    if(!targets.length) return [module.i18n(only && hit.some(t => (t.document ?? t).uuid === only) ? "rollItem.mastery.used" : "rollItem.mastery.noHit")];
    const done = { ...(message.getFlag(module.id, `mastery.${this.rayKey(ray)}`) ?? {}) };

    const attacker = message.getAssociatedActor();
    const attack = system.attackOf(ray);
    const item = message.getAssociatedItem?.() ?? null;
    const notes = [];

    for(const target of targets){
      const actor = target.actor;
      if(!actor) continue;
      const doneKey = this.uuidKey((target.document ?? target).uuid);
      done[doneKey] = true;
      switch(key){
        case "topple" : {
          const result = await rollSave(actor, "con", this.toppleDC(attacker, attack?.options?.ability));
          if(result) done[doneKey] = { total : result.total, success : result.success };
          if(result && !result.success) await setStatus(actor, "prone", true);
          break;
        }
        case "sap" :
          await this.#replace(actor, "sap", attacker);
          await addTimedEffect(actor, this.#effect("sap", item, attacker), { of : attacker, until : "turnStart" });
          break;
        case "slow" : {
          /* Doesn't stack : a new Slow replaces the old one, whoever's it was */
          await this.#replace(actor, "slow");
          const changes = this.#slowChanges(actor);
          if(!changes.length) break;
          await addTimedEffect(actor, this.#effect("slow", item, attacker, { system : { changes } }), { of : attacker, until : "turnStart" });
          break;
        }
        case "vex" :
          await addTimedEffect(attacker, this.#effect("vex", item, attacker, {
            name : `${this.label("vex")}: ${target.name}`,
            flags : { [module.id] : { target : target.document.uuid, targetActor : actor.uuid } },
          }), { of : attacker, until : "turnEnd" });
          break;
      }
    }

    await message.setFlag(module.id, `mastery.${this.rayKey(ray)}`, done);
    log.debug("Mastery", key, "from", message.id, "on", targets.map(t => t.name));
    return notes;
  }

  static async afterPush(target, moved, feet, item = null, name = null){
    if(!target?.actor || (moved >= feet)) return;
    if(settings.value("homebrewPush")) return this.pushCollision(target, moved, feet, item, name);
    if(!moved) ui.notifications.info(module.format("rollItem.mastery.blocked", { name : target.name }));
  }

  /**
   * Homebrew (Homebrew settings) : a push cut short by something solid.
   *   the full distance        -> nothing more
   *   part of it (5 of 10 ft)  -> Prone
   *   not at all               -> Prone, and 1d6 bludgeoning (rolled in chat, applied)
   */
  static async pushCollision(target, moved, feet, item, name = null){
    if(moved >= feet) return;
    const actor = target.actor;
    await setStatus(actor, "prone", true);
    if(moved > 0) return;

    const roll = await new CONFIG.Dice.DamageRoll("1d6", {}, { type : "bludgeoning" }).evaluate();
    await roll.toMessage({
      speaker : ChatMessage.implementation.getSpeaker({ actor, token : target.document }),
      flavor : (item?.name ?? name) ? module.format("rollItem.mastery.slammed", { name : target.name, item : item?.name ?? name }) : module.format("rollItem.mastery.slammedPlain", { name : target.name }),
    });
    await actor.applyDamage([{ value : roll.total, type : "bludgeoning" }], { isDelta : true });
  }

  static rayKey(ray){
    return Number.isInteger(ray) ? String(ray) : "single";
  }

  /* An effect from a mastery, flagged so the attack hooks and the next use can find it */
  static #effect(key, item, attacker, extra = {}){
    return foundry.utils.mergeObject({
      name : this.label(key),
      img : item?.img ?? "icons/svg/sword.svg",
      origin : item?.uuid ?? attacker?.uuid,
      description : module.i18n(`rollItem.mastery.effect.${key}`),
      flags : { [module.id] : { mastery : key, source : attacker?.uuid ?? null } },
    }, extra, { inplace : false });
  }

  /* Remove this mastery's effects from an actor (only the given attacker's, when given) */
  static async #replace(actor, key, attacker){
    const old = actor.effects.filter(e => (e.getFlag(module.id, "mastery") === key)
      && (!attacker || (e.getFlag(module.id, "source") === attacker.uuid)));
    if(old.length) await actor.deleteEmbeddedDocuments("ActiveEffect", old.map(e => e.id));
  }

  /* -10 ft to every speed it has */
  static #slowChanges(actor){
    const movement = actor.system.attributes?.movement ?? {};
    return Object.keys(CONFIG.DND5E.movementTypes ?? { walk : {} })
      .filter(type => Number(movement[type]) > 0)
      .map(type => ({ key : `system.attributes.movement.${type}`, type : "add", value : "-10" }));
  }

  /* ---------- Cleave ---------- */

  static async cleave(message, ray, event){
    const system = message.system;
    if(this.used(message, ray)) return ui.notifications.info(module.i18n("rollItem.mastery.used"));
    const activity = message.getAssociatedActivity({ scaled : true });
    const item = activity?.item;
    const attacker = message.getAssociatedActor();
    const [first] = system.hitTargets(ray);
    if(!item || !attacker || !first) return ui.notifications.warn(module.i18n("rollItem.mastery.noHit"));
    if(isRangedAttack(item, first) && !limits.allow(module.i18n("rollItem.mastery.cleaveMelee"), { who : attacker.name, what : `Cleave (${item.name})` })) return;

    /* Once per turn, in combat */
    if(usedThisTurn(attacker, "cleave") && !limits.allow(module.i18n("rollItem.mastery.cleaveOnce"), { who : attacker.name, what : `Cleave (${item.name})` })) return;

    const picked = await pickAttack(item, {
      activity, count : 1, long : false, clearTargets : true, used : true,
      filter : t => (t !== first) && (distanceBetween(t, first) <= canvas.scene.grid.distance),
    });
    if(!picked) return;

    const { attack, targets, attackMode, disadvantage } = picked;
    const result = await rollItem.roll(item, { activity : attack.id, count : 1, targets, attackMode, disadvantage, event, tags : { noMod : true } });
    if(!result) return;
    await markUsedThisTurn(attacker, "cleave");
    await message.setFlag(module.id, `mastery.${this.rayKey(ray)}`, true);
  }

  /* ---------- Roll hooks : Sap, Vex, Cleave ---------- */

  /* The token an attack is aimed at : Roll Item says, else your one target */
  static #targetOf(config){
    const given = config?.[module.id]?.target;
    if(given) return given;
    return (game.user.targets.size === 1) ? game.user.targets.first().document.uuid : null;
  }

  /* Sapped : disadvantage on its next attack. Vexed by you : advantage on your next attack against it. Both used up. */
  static onPreRollAttack(config){
    if(!this.enabled()) return;
    const actor = config.subject?.actor;
    const roll = config.rolls?.[0];
    if(!actor || !roll) return;
    roll.options ??= {};

    const target = this.#targetOf(config);
    const targetActor = target ? fromUuidSync(target, { strict : false })?.actor?.uuid : null;
    const used = [];
    for(const effect of actor.effects){
      const flags = effect.getFlag(module.id, "mastery") ? effect.flags[module.id] : null;
      if(!flags) continue;
      if(flags.mastery === "sap"){
        giveMode(roll, "disadvantage", module.i18n("reasons.sap"));
        used.push(effect.uuid);
      }
      else if((flags.mastery === "vex") && target && ((flags.target === target) || (flags.targetActor === targetActor))){
        giveMode(roll, "advantage", module.i18n("reasons.vex"));
        used.push(effect.uuid);
      }
    }
    if(used.length) roll.options[module.id] = { ...(roll.options[module.id] ?? {}), consume : used };
  }

  static async onRollAttack(rolls){
    for(const uuid of rolls?.[0]?.options?.[module.id]?.consume ?? []){
      const effect = await fromUuid(uuid);
      if(effect?.isOwner) await effect.delete();
    }
  }

  /* Cleave's second attack : no ability modifier on its damage, unless it's negative */
  static onPreRollDamage(config){
    if(!config?.[module.id]?.tags?.noMod) return;
    for(const roll of config.rolls ?? []){
      if(roll.data && (Number(roll.data.mod) > 0)) roll.data.mod = 0;
    }
  }
}
