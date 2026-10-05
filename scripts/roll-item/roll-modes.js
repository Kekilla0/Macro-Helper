import { logger } from '../log.js';
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
    "help",        // Default Actions : Help's Assist Attack
    "reckless",    // Barbarian : Reckless Attack
    "protection",  // Fighting Styles : Protection
  ];

  static #rules = [];

  /**
   * @param {string} name   its place in ORDER
   * @param {(config : object) => void} fn
   */
  static add(name, fn){
    if(this.#rules.some(r => r.name === name)) return;
    const rank = n => { const i = this.ORDER.indexOf(n); return (i < 0) ? Infinity : i; };
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
    Hooks.on("dnd5e.preRollAttackV2", config => this.apply(config));
  }
}
