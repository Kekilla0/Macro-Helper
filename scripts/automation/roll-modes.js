import { rollOptionModes } from '../roll-item/roll-options.js';
import { logger } from '../log.js';
import { attackOf } from '../roll-item/damage.js';
import { giveMode } from '../roll-item/reasons.js';
import { effectsFrom } from '../helpers/actors.js';
import { conditions } from './conditions.js';
const log = logger.for(import.meta.url);

/**
 * Advantage and disadvantage on attacks, in one place. Features add a rule; each looks at dnd5e's attack config
 * (subject, rolls[0], attackMode, the module's target) and gives a mode with its reason (giveMode). Rules only read :
 * anything an attack uses up is spent after the roll (dnd5e.rollAttackV2).
 *
 * The same rules run for the roll (dnd5e.preRollAttackV2) and for the pick map's colours before it (predictMode), so
 * the map always shows what the roll will do. They run in ORDER (a rule not in it runs last).
 */
export class rollModes{
  static ORDER = [
    "conditions",  // conditions.js : the attacker's and target's conditions, sight, Dodging; reasons given with the roll
    "masteries",   // Sap, Vex
    "heavy",       // weapon handling : Heavy for a Small creature (or one too weak)
    "flanking",    // Homebrew : flanking
    "packTactics", // Creature traits : Pack Tactics
    "help",        // Default Actions : Help's Assist Attack
    "reckless",    // Barbarian : Reckless Attack
    "protection",  // Fighting Styles : Protection
    "innate",      // Sorcerer : Innate Sorcery (Sorcerer spell attacks)
  ];

  static #rules = [];

  /**
   * @param {string} name   its place in ORDER
   * @param {(config : object) => void} fn
   */
  static add(name, fn){
    if(this.#rules.some(r => r.name === name)) return;
    const rank = n => { const i = this.ORDER.indexOf(n.split(":")[0]); return (i < 0) ? Infinity : i; };
    this.#rules.push({ name, fn });
    this.#rules.sort((a, b) => rank(a.name) - rank(b.name));
  }

  /* Every rule on this config (a rule that throws is logged and skipped) */
  static apply(config){
    for(const rule of this.#rules){
      try { rule.fn(config); }
      catch(error){ log.error("Attack mode rule", rule.name, error); }
    }
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    /* item.roll()'s own advantage / disadvantage / bonus / critical range (card macros) */
    this.add("macro", config => rollOptionModes(config));
    Hooks.on("dnd5e.preRollAttackV2", config => this.apply(config));
  }
}

/**
 * Advantage or disadvantage from an effect : on attack rolls *by* the creature that has it, or *against* it. Reckless
 * Attack; a monster's "while enraged, attacks against it have advantage"; Steady Aim.
 *
 *   rollModeFrom(effect => effect.getFlag("macro-helper", "reckless"), {
 *     by      : { mode : "advantage", when : attack => attack.ability === "str", reason : "Reckless" },
 *     against : { mode : "advantage", reason : "target Reckless" },
 *   });
 *
 * match : the item (identifier, or several) whose effects give it, or a check (effect) => boolean.
 * by / against : { mode : "advantage" | "disadvantage", when(attack, target), reason } : `attack` is the damage lego's
 *         attackOf (actor, item, weapon, melee, ranged, ability...), `target` the target's token (or null). `reason` may
 *         be a function (attack, target) => string (translated when the roll is made).
 * options : enabled() (the rule's setting), id (added again with the same id, it replaces the old one; default : the
 *         match). Runs at the "reckless" place in rollModes.ORDER unless `order` names another.
 */
const fromRules = new Map();
export function rollModeFrom(match, { by = null, against = null, enabled = null, id = null, order = "reckless" } = {}){
  const key = id ?? [match].flat().map(String).join(",");
  const added = fromRules.has(key);
  fromRules.set(key, { match, by, against, enabled });
  if(added) return;
  rollModes.add(`${order}:${key}`, config => {
    const rule = fromRules.get(key);
    if(rule.enabled && !rule.enabled()) return;
    const roll = config.rolls?.[0];
    const attack = attackOf(config);
    if(!roll || !attack.actor) return;
    const target = conditions.targetOf(config);
    const give = (side, actor) => {
      if(!side || !actor || !effectsFrom(actor, rule.match).length) return;
      if(side.when && !side.when(attack, target)) return;
      const reason = (typeof side.reason === "function") ? side.reason(attack, target) : side.reason;
      giveMode(roll, side.mode ?? "advantage", reason ?? "");
    };
    give(rule.by, attack.actor);
    give(rule.against, target?.actor);
  });
}
