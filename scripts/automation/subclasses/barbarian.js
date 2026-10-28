import { module } from '../../module.js';
import { logger } from '../../log.js';
import { idOf, chooseOption, originItem } from '../../helpers/utils.js';
import { tempHP, itemOf } from '../../helpers/actors.js';
import { tokenOf, distanceBetween } from '../../helpers/tokens.js';
import { isAlly, isEnemy } from '../../helpers/targets.js';
import { giveMode } from '../../roll-item/reasons.js';
import { onHit } from '../../roll-item/hit-bonus.js';
import { rollModes } from '../roll-modes.js';
import { conditions } from '../conditions.js';
import { actions } from '../actions.js';
import { barbarian } from '../classes/barbarian.js';
import { subclasses } from './common.js';
const log = logger.for(import.meta.url);

/**
 * Barbarian subclasses, level 3 (Subclasses setting), over the Rage of classes/barbarian.js. Animal Speaker's rituals
 * and Warrior of the Gods' pool are the items' own data.
 *
 *   Berserker  Frenzy               raging and Reckless, on its own turn : a Frenzy button on its first hit with a
 *                                   Strength attack : Rage Damage d6s, the weapon's type, once a turn.
 *   Wild Heart Rage of the Wilds    each Rage starts with a choice (or the item's Bear / Eagle / Wolf activity, raging) :
 *                                   Bear : Resistance to every damage type but Force, Necrotic, Psychic and Radiant;
 *                                   Eagle : Dash and Disengage now, and again with the Eagle activity (its Bonus Action);
 *                                   Wolf : its allies have Advantage on attack rolls against its enemies within 5 ft
 *                                   of it. Until the Rage ends.
 *   World Tree Vitality of the Tree Vitality Surge : temporary Hit Points equal to its Barbarian level when the Rage
 *                                   starts. Life-Giving Force : at the start of each of its turns raging, a card offers
 *                                   the item's Life-Giving Force (another creature within 10 ft).
 *   Zealot     Divine Fury          raging, on its own turn : its first hit with a weapon or an Unarmed Strike gets
 *                                   Divine Fury buttons (Necrotic or Radiant) : 1d6 + half its Barbarian level.
 */
export class barbarianPaths{
  static FRENZY = "frenzy";
  static WILDS = "rage-of-the-wilds";
  static VITALITY = "vitality-of-the-tree";
  static DIVINE_FURY = "divine-fury";
  static BEAR_RESIST = ["acid", "bludgeoning", "cold", "fire", "lightning", "piercing", "poison", "slashing", "thunder"];

  static enabled(){
    return subclasses.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    const raging = actor => barbarian.isRaging(actor);
    const rageDice = hit => Number(hit.actor.system?.scale?.barbarian?.["rage-damage"]?.value) || 2;
    onHit({ id : this.FRENZY, feature : this.FRENZY, icon : "fa-face-angry", enabled : () => this.enabled(), ownTurn : true, once : "turn",
      when : hit => raging(hit.actor) && barbarian.isReckless(hit.actor) && (hit.ability === "str") && (hit.weapon || hit.unarmed),
      formula : hit => `${rageDice(hit)}d6` });
    onHit({ id : this.DIVINE_FURY, feature : this.DIVINE_FURY, icon : "fa-sun", enabled : () => this.enabled(), ownTurn : true, once : "turn",
      when : hit => raging(hit.actor) && (hit.weapon || hit.unarmed),
      formula : hit => `1d6 + ${Math.floor((Number(hit.actor.classes?.barbarian?.system?.levels) || 0) / 2)}`,
      types : () => ["necrotic", "radiant"] });
    Hooks.on(`${module.id}.rageStart`, (actor, activity) => this.onRage(actor));
    Hooks.on(`${module.id}.rageEnd`, actor => this.onRageEnd(actor));
    /* A Rage that ran out or was taken off (not through endRage) */
    Hooks.on("deleteActiveEffect", effect => this.rageGone(effect));
    Hooks.on("updateActiveEffect", (effect, changes) => { if(changes?.disabled === true) this.rageGone(effect); });
    Hooks.on("dnd5e.postUseActivity", activity => this.onWildsActivity(activity));
    rollModes.add("wolf", config => this.wolf(config));
    Hooks.on(`${module.id}.turnStart`, (combat, combatant) => this.lifeGivingForce(combatant?.actor));
  }

  /* ---------- Rage starts / ends ---------- */

  static async onRage(actor){
    if(!this.enabled() || !actor?.isOwner) return;
    try {
      const vitality = itemOf(actor, this.VITALITY);
      if(vitality) await tempHP(actor, Number(actor.classes?.barbarian?.system?.levels) || 0, vitality);
      const wilds = itemOf(actor, this.WILDS);
      if(wilds){
        const choice = await chooseOption({ title : wilds.name, icon : "fa-solid fa-paw", prompt : module.i18n("subclasses.barbarian.wildsPrompt"),
          options : ["bear", "eagle", "wolf"].map(value => ({ value, label : module.i18n(`subclasses.barbarian.${value}`) })) });
        if(choice) await this.chooseWilds(actor, wilds, choice);
      }
    }
    catch(error){ log.error(error); }
  }

  static rageGone(effect){
    if(!game.users.activeGM?.isSelf || !barbarian.isRageEffect(effect)) return;
    const actor = (effect.parent?.documentName === "Actor") ? effect.parent : effect.parent?.actor;
    if(actor && !barbarian.rageEffects(actor).length) this.onRageEnd(actor);
  }

  static async onRageEnd(actor){
    if(!actor?.isOwner) return;
    const bound = actor.effects.filter(e => e.getFlag(module.id, "rageBound")).map(e => e.id);
    if(bound.length) await actor.deleteEmbeddedDocuments("ActiveEffect", bound);
    if(actor.getFlag(module.id, "wilds")) await actor.unsetFlag(module.id, "wilds");
  }

  /* ---------- Rage of the Wilds ---------- */

  static wildsOf(actor){
    return barbarian.isRaging(actor) ? (actor.getFlag(module.id, "wilds") ?? null) : null;
  }

  static async chooseWilds(actor, item, choice){
    if(this.wildsOf(actor) === choice){
      if(choice === "eagle") await this.eagle(actor);
      return;
    }
    /* Another animal's power (its activity, raging) : the one before ends */
    const before = actor.effects.filter(e => e.getFlag(module.id, "rageBound") && (originItem(e) === item)).map(e => e.id);
    if(before.length) await actor.deleteEmbeddedDocuments("ActiveEffect", before);
    await actor.setFlag(module.id, "wilds", choice);
    if(choice === "bear"){
      await actor.createEmbeddedDocuments("ActiveEffect", [{ name : module.i18n("subclasses.barbarian.bearEffect"), img : item.img, origin : item.uuid,
        changes : this.BEAR_RESIST.map(type => ({ key : "system.traits.dr.value", type : "add", mode : 2, value : type })),
        flags : { [module.id] : { rageBound : true } } }]);
    }
    else if(choice === "eagle") await this.eagle(actor);
    else await actor.createEmbeddedDocuments("ActiveEffect", [{ name : module.i18n("subclasses.barbarian.wolfEffect"), img : item.img, origin : item.uuid,
      flags : { [module.id] : { rageBound : true } } }]);
    log.debug("Rage of the Wilds", actor.name, choice);
  }

  /* Dash and Disengage (the Default Actions' marks) */
  static async eagle(actor){
    await actions.mark(actor, "dash", "actions.dash.mark", "icons/skills/movement/feet-winged-boots-glowing-yellow.webp");
    await actions.mark(actor, "disengage", "actions.disengage.mark", "icons/skills/movement/arrow-upward-yellow.webp");
  }

  /* The item's own Bear / Eagle / Wolf activity, used while raging */
  static async onWildsActivity(activity){
    if(!this.enabled() || (idOf(activity?.item) !== this.WILDS) || !activity.actor?.isOwner) return;
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    if(!barbarian.isRaging(actor)) return ui.notifications.warn(module.format("subclasses.barbarian.notRaging", { name : actor.name }));
    const name = String(activity.name ?? "").toLowerCase();
    const choice = ["bear", "eagle", "wolf"].find(c => name.includes(c));
    if(choice) await this.chooseWilds(actor, activity.item, choice);
  }

  /* Wolf : an ally's attack against an enemy of the Barbarian within 5 ft of it */
  static wolf(config){
    if(!this.enabled()) return;
    const attacker = tokenOf(config.subject?.actor);
    const target = conditions.targetOf(config);
    if(!attacker || !target) return;
    const wolf = canvas.tokens?.placeables?.find(t => t.actor && (t !== attacker) && (this.wildsOf(t.actor) === "wolf")
      && isAlly(attacker, t) && isEnemy(target, t) && (distanceBetween(t, target) <= 5));
    if(wolf && config.rolls?.[0]) giveMode(config.rolls[0], "advantage", module.format("subclasses.barbarian.wolfReason", { name : wolf.name }));
  }

  /* ---------- Vitality of the Tree : Life-Giving Force ---------- */

  static async lifeGivingForce(actor){
    if(!this.enabled() || !game.users.activeGM?.isSelf || !barbarian.isRaging(actor)) return;
    const item = itemOf(actor, this.VITALITY);
    const activity = [...(item?.system?.activities ?? [])].find(a => /life-giving/i.test(a.name ?? ""));
    if(!activity) return;
    await subclasses.offer(actor, { item, activity : activity.id, label : activity.name,
      text : module.format("subclasses.barbarian.lifeGiving", { name : actor.name }) });
  }
}
