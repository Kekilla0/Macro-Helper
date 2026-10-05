import { module } from '../module.js';
import { rollModes } from './roll-modes.js';
import { giveMode } from './reasons.js';
import { settings } from '../settings.js';
import { limits } from '../rules/limits.js';
import { logger } from '../log.js';
import { tokenOf, distanceBetween, pushAway } from '../helpers/tokens.js';
import { getSize, rollSave, setStatus, addTimedEffect, usedThisTurn, markUsedThisTurn } from '../helpers/actors.js';
import { pickAttack, isRangedAttack } from '../helpers/items.js';
import { rollItem } from './roll-item.js';
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
 *   Nick          : changes when the Light extra attack happens, nothing to roll.
 *
 * Buttons only work on targets the card knows hit, once per attack. Topple, Push, Sap, Slow and Vex change the target :
 * outcomes, so only the GM sees and clicks those (nothing happens on its own). Cleave is another attack : its roller's.
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

  static register(){
    if(game.system.id !== "dnd5e") return;
    rollModes.add("masteries", config => this.onPreRollAttack(config));
    Hooks.on("dnd5e.rollAttackV2", rolls => this.onRollAttack(rolls));
    Hooks.on("dnd5e.preRollDamageV2", config => this.onPreRollDamage(config));
  }

  /* ---------- Card ---------- */

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

  /**
   * Apply an outcome mastery (GM) : only to targets the card says were hit, once per attack.
   * @returns {Promise<string[]>}  notes to show (too big to push, blocked...)
   */
  static async apply(message, ray = null){
    const system = message?.system;
    if(!system?.masteryOf) throw new Error("Not a Roll Item attack card.");

    const key = system.masteryOf(ray);
    if(!this.ACTIONS.includes(key) || (key === "cleave")) throw new Error(`No mastery to use : ${key}`);
    if(system.masteryUsed(ray)) return [module.i18n("rollItem.mastery.used")];

    const targets = system.hitTargets(ray);
    if(!targets.length) return [module.i18n("rollItem.mastery.noHit")];

    const attacker = message.getAssociatedActor();
    const attackerToken = tokenOf(message.getAssociatedToken?.() ?? attacker);
    const attack = system.attackOf(ray);
    const item = message.getAssociatedItem?.() ?? null;
    const notes = [];

    for(const target of targets){
      const actor = target.actor;
      if(!actor) continue;
      switch(key){
        case "topple" : {
          const result = await rollSave(actor, "con", this.toppleDC(attacker, attack?.options?.ability));
          if(result && !result.success) await setStatus(actor, "prone", true);
          break;
        }
        case "push" : {
          if(((getSize(actor)?.value ?? 2) > 3) && !limits.allow(module.format("rollItem.mastery.tooBig", { name : target.name }), { notes, who : attacker?.name, what : `Push ${target.name}` })) break;
          const moved = await pushAway(target, attackerToken, 10);
          if(settings.value("homebrewPush")) await this.pushCollision(target, moved, 10, item);
          else if(!moved) notes.push(module.format("rollItem.mastery.blocked", { name : target.name }));
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

    await message.setFlag(module.id, `mastery.${this.rayKey(ray)}`, true);
    log.debug("Mastery", key, "from", message.id, "on", targets.map(t => t.name));
    return notes;
  }

  /**
   * Homebrew (Homebrew settings) : a push cut short by something solid.
   *   the full distance        -> nothing more
   *   part of it (5 of 10 ft)  -> Prone
   *   not at all               -> Prone, and 1d6 bludgeoning (rolled in chat, applied)
   */
  static async pushCollision(target, moved, feet, item){
    if(moved >= feet) return;
    const actor = target.actor;
    await setStatus(actor, "prone", true);
    if(moved > 0) return;

    const roll = await new CONFIG.Dice.DamageRoll("1d6", {}, { type : "bludgeoning" }).evaluate();
    await roll.toMessage({
      speaker : ChatMessage.implementation.getSpeaker({ actor, token : target.document }),
      flavor : module.format("rollItem.mastery.slammed", { name : target.name, item : item?.name ?? "" }),
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
    if(system.masteryUsed(ray)) return ui.notifications.info(module.i18n("rollItem.mastery.used"));
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
    const result = await rollItem.roll(item, { activity : attack.id, count : 1, targets, attackMode, disadvantage, event, cleave : true });
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
    if(!config?.[module.id]?.noMod) return;
    for(const roll of config.rolls ?? []){
      if(roll.data && (Number(roll.data.mod) > 0)) roll.data.mod = 0;
    }
  }
}
