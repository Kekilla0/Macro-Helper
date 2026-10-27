import { module } from '../module.js';
import { rollModes } from './roll-modes.js';
import { giveMode } from '../roll-item/reasons.js';
import { settings } from '../settings.js';
import { limits } from './limits.js';
import { logger } from '../log.js';
import { distanceBetween } from '../helpers/tokens.js';
import { getSize, addTimedEffect, usedThisTurn, markUsedThisTurn } from '../helpers/actors.js';
import { giveCondition, cardBuilder } from '../roll-item/card-builder.js';
import { pickAttack, isRangedAttack } from '../helpers/items.js';
import { onDamage } from '../roll-item/damage.js';
import { onMiss } from '../roll-item/miss-damage.js';
import { addRow } from '../roll-item/card-rows.js';
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
 * Built from the legos : Graze is onMiss; Topple, Sap, Slow and Vex are addRow (the GM's button on each hit target's
 * row, Topple's save result beside it, greyed once used on that target; Sap, Slow and Vex aren't optional, so applying
 * the hit's damage to that target applies them first); Push is a card move (the GM's); Cleave is another attack : its
 * roller's, a card button.
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
    onDamage((attack, damage) => this.onDamage(attack, damage));
    /* Roll Item's attack cards : each attack's mastery section, and its button */
    foundry.applications.handlebars.loadTemplates({ [`${module.id}.mastery`] : `${module.path}/templates/mastery.hbs` });
    Hooks.on(`${module.id}.cardSections`, (message, sections, { ray } = {}) => { const section = this.cardSection(message, ray ?? null); if(section) sections.push(section); });
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray, event, button } = {}) => { if(id === "mastery") this.clicked(message, ray ?? null, event, button); });
    /* Every other push (Repelling Blast, a card macro's push part) : the same Homebrew collision as Push, else "blocked" */
    Hooks.on(`${module.id}.pushed`, (target, moved, feet, item, { name } = {}) => this.afterPush(target, moved, feet, item, name));
    Hooks.on(`${module.id}.cardMoves`, (message, uuid, moves, context = {}) => this.pushMove(message, uuid, moves, context));
    /* Graze : the ability modifier as damage on a miss */
    onMiss({ id : "graze", enabled : () => this.enabled(), when : miss => miss.mastery === "graze", formula : miss => (miss.mod > 0) ? String(miss.mod) : null,
      label : () => this.label("graze"), icon : this.ICONS.graze });
    /* The outcome masteries : the GM's button on each hit target's row */
    const row = (key, extra = {}) => addRow({ id : `mastery-${key}`, enabled : () => this.enabled(), when : r => r.mastery === key,
      label : r => this.buttonLabel(key, r.actor, r.roll), icon : this.ICONS[key], run : r => this.apply(key, r), ...extra });
    row("topple", { label : r => module.format("rollItem.mastery.row.topple", { dc : this.toppleDC(r.actor, r.ability) }),
      tooltip : r => this.buttonLabel("topple", r.actor, r.roll), img : () => CONFIG.statusEffects.find(s => s.id === "prone")?.img ?? null,
      conditions : ["prone"] });
    row("sap", { withDamage : true });
    row("slow", { withDamage : true });
    row("vex", { withDamage : true, mayRun : r => r.actor?.isOwner });
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

  /**
   * The mastery section of a Roll Item attack card for one attack : Cleave's button for a hit (Graze is onMiss's).
   * @param {ChatMessage} message
   * @param {number|null} ray
   * @returns {object|null}  { partial, context, applies }
   */
  static cardSection(message, ray){
    const card = message?.system;
    const key = card?.masteryOf?.(ray);
    if(!key || !this.enabled()) return null;
    const attack = card.attackOf(ray);
    const { hits } = card.targetHits(ray);

    /* Cleave is another attack : its roller's (its own extra attack can't Cleave again). The rest are row buttons. */
    const isCleave = !!attack?.options?.[module.id]?.tags?.noMod;
    const canUse = (key === "cleave") && message.isOwner && !isCleave;
    const action = (canUse && hits.length) ? {
      label : this.buttonLabel(key, message.getAssociatedActor(), attack),
      used : this.used(message, ray),
    } : null;
    if(!action) return null;

    return {
      partial : `${module.id}.mastery`,
      applies : false,
      context : {
        key, action,
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

  /* ---------- Using a mastery from the card ---------- */

  /* The card's mastery button : Cleave (the rest are row buttons) */
  static async use(message, ray, event){
    if(message.system.masteryOf(ray) === "cleave") return this.cleave(message, ray, event);
  }

  /**
   * An outcome mastery on one hit creature (its row's button, or with the hit's damage) : Topple, Sap, Slow, Vex.
   * @param {string} key
   * @param {object} row   the row lego's facts : actor (the attacker), target, item, ability, message
   * @returns {Promise<object|void>}  Topple's save
   */
  static async apply(key, row){
    const attacker = row.actor;
    const target = row.target;
    const actor = target?.actor;
    const item = row.item ?? null;
    if(!actor) return;
    switch(key){
      case "topple" : {
        const { save } = await giveCondition(target, "prone", { save : "con", dc : this.toppleDC(attacker, row.ability),
          from : item, by : row.message.getAssociatedToken?.() ?? attacker });
        return save ?? undefined;
      }
      case "sap" :
        await this.#replace(actor, "sap", attacker);
        await addTimedEffect(actor, this.#effect("sap", item, attacker), { of : attacker, until : "turnStart" });
        return;
      case "slow" : {
        /* Doesn't stack : a new Slow replaces the old one, whoever's it was */
        await this.#replace(actor, "slow");
        const changes = this.#slowChanges(actor);
        if(changes.length) await addTimedEffect(actor, this.#effect("slow", item, attacker, { system : { changes } }), { of : attacker, until : "turnStart" });
        return;
      }
      case "vex" :
        await addTimedEffect(attacker, this.#effect("vex", item, attacker, {
          name : `${this.label("vex")}: ${target.name}`,
          flags : { [module.id] : { target : target.document.uuid, targetActor : actor.uuid } },
        }), { of : attacker, until : "turnEnd" });
        return;
    }
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
    /* The push itself was allowed (its own creature, or the GM's button) : what it hits follows from it */
    await giveCondition(target, "prone", { from : item, confirmed : true });
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

    const { attack } = picked;
    const card = await cardBuilder.roll(item, { use : false, attack, picked, count : 1, event, tags : { noMod : true } });
    if(!card) return;
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
  /* Cleave's extra attack : no positive ability modifier */
  static onDamage(attack, damage){
    if(attack.tags?.noMod) damage.noModifier();
  }
}
