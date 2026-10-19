import { module } from '../../module.js';
import { logger } from '../../log.js';
import { idOf } from '../../helpers/utils.js';
import { spendUses } from '../../helpers/items.js';
import { giveMode } from '../../roll-item/reasons.js';
import { addDie, rerolls } from '../../roll-item/rerolls.js';
import { rollModes } from '../roll-modes.js';
import { conditions } from '../conditions.js';
import { itemFixes } from '../item-fixes.js';
import { subclasses } from './common.js';
const log = logger.for(import.meta.url);

/**
 * Rogue subclasses, level 3 (Subclasses setting). The Arcane Trickster's spells and Mage Hand, the Assassin's kits and
 * Initiative advantage, Fast Hands' activities and Psychic Whispers are the items' data. The Psychic Blade is
 * Plutonium's weapon item.
 *
 *   Assassin  Assassinate          the first round of a combat : Advantage on attack rolls against a creature that hasn't
 *                                  taken its turn yet, and its Sneak Attack adds the Rogue level.
 *   Soulknife Psi-Bolstered Knack  a failed check with a proficient skill or tool : a button rolls a Psionic Energy Die
 *                                  onto it. The die is spent when that makes it a success (an unknown DC : spent).
 *   Thief     Second-Story Work    a Climb Speed equal to its Speed (Plutonium's item has no effect : one is added).
 */
export class rogueArchetypes{
  static ASSASSINATE = "assassinate";
  static KNACK = "psi-bolstered-knack";
  static PSIONIC = "psionic-power";
  static SECOND_STORY = "second-story-work";

  static enabled(){
    return subclasses.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    rollModes.add("assassinate", config => this.surprising(config));
    Hooks.on(`${module.id}.sneakAttack`, (actor, message, parts) => { if(this.firstRound(actor)) parts.push(String(Number(actor.classes?.rogue?.system?.levels) || 1)); });
    Hooks.on(`${module.id}.rerollButtons`, (message, buttons, { actor, roll }) => this.knackButtons(message, buttons, actor, roll));
    itemFixes.add({ name : "Second-Story Work", where : "owned", plan : item => this.climberFix(item) });
  }

  /* ---------- Assassin ---------- */

  /* An Assassin, in the first round of its combat */
  static firstRound(actor){
    const combat = game.combat;
    return this.enabled() && !!subclasses.has(actor, this.ASSASSINATE) && !!combat?.started && (combat.round === 1);
  }

  /* Against a creature that hasn't taken its turn this round */
  static surprising(config){
    const actor = config.subject?.actor;
    const target = conditions.targetOf(config);
    if(!target?.actor || !this.firstRound(actor)) return;
    const combat = game.combat;
    const index = combat.turns.findIndex(c => (c.tokenId === target.id) || (c.actor === target.actor));
    if((index > combat.turn) && config.rolls?.[0]) giveMode(config.rolls[0], "advantage", subclasses.has(actor, this.ASSASSINATE).name);
  }

  /* ---------- Soulknife ---------- */

  static psionicOf(actor){
    return subclasses.has(actor, this.PSIONIC);
  }

  static dieOf(actor){
    const scale = actor?.system?.scale?.soulknife?.die ?? actor?.system?.scale?.soulknife?.["energy-die"];
    return scale?.faces ? `1d${scale.faces}` : (scale?.formula ? String(scale.formula).replace(/^\d+d/, "1d") : "1d6");
  }

  static proficient(actor, message){
    const skill = message.system?.skill, tool = message.system?.tool;
    if(skill) return Number(actor.system?.skills?.[skill]?.value ?? actor.system?.skills?.[skill]?.proficient) >= 1;
    if(tool) return Number(actor.system?.tools?.[tool]?.value ?? actor.system?.tools?.[tool]?.prof?.multiplier) >= 1;
    return false;
  }

  static knackButtons(message, buttons, actor, roll){
    if(!this.enabled() || (message?.type !== "check") || !actor?.isOwner || message.getFlag?.(module.id, "knack") || !subclasses.has(actor, this.KNACK)) return;
    const target = roll?.options?.target;
    if(Number.isFinite(target) && (roll.total >= target)) return;
    if(!this.proficient(actor, message) || !(Number(this.psionicOf(actor)?.system?.uses?.value) > 0)) return;
    buttons.push({ id : "knack", icon : "fa-brain", label : subclasses.has(actor, this.KNACK).name, run : async () => {
      if(message.getFlag(module.id, "knack") || !message.isOwner) return;
      const { updated, extra } = await addDie(message.rolls[0], this.dieOf(actor));
      await rerolls.replace(message, updated, [extra]);
      await message.setFlag(module.id, "knack", true);
      const goal = updated.options?.target;
      if(!Number.isFinite(goal) || (updated.total >= goal)) await spendUses(this.psionicOf(actor), 1);
      log.debug("Psi-Bolstered Knack", actor.name, updated.total);
    } });
  }

  /* ---------- Thief ---------- */

  static climberFix(item){
    if(!this.enabled() || (idOf(item) !== this.SECOND_STORY) || !item.actor || item.effects.size) return null;
    return { create : { effects : [{ _id : foundry.utils.randomID(), name : item.name, img : item.img, transfer : true,
      changes : [{ key : "system.attributes.movement.speeds.climb", type : "override", mode : 5, value : "@attributes.movement.walk" }] }] } };
  }
}
