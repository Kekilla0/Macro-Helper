import { patch } from '../patch.js';
import { logger } from '../log.js';
const log = logger.for(import.meta.url);

/**
 * The weapon-uses lego : rules that change the ability a weapon attacks with, or its damage die, said once (Martial
 * Arts, Pact of the Blade). Done as dnd5e prepares the weapon, so the sheet, the card and the rolls all show it; each
 * preparation starts again from the weapon's own die and abilities, so a rule that stops applying (armor put on, the
 * pact ended) leaves nothing behind.
 *
 *   weaponUses.add("martialArts", {
 *     applies : item => boolean,         does it apply to this weapon now
 *     abilities : item => ["str", "dex"], abilities beside the weapon's own (dnd5e attacks with the highest)
 *     die : item => 8,                    the faces of a die its damage uses instead of its own, when that's bigger
 *   })
 *
 * Several rules on one weapon : every ability they add, and the biggest die. An attack whose ability is fixed ("none",
 * spellcasting) keeps it. dnd5e remembers the ability of the last attack made : a weapon a rule applies to rolls with
 * the best one again.
 */
export class weaponUses{
  static #rules = [];
  static #original = new WeakMap();
  static #added = new WeakMap();

  /**
   * @param {string} id
   * @param {{ applies : Function, abilities? : Function, die? : Function }} rule
   */
  static add(id, rule){
    if(!id || this.#rules.some(r => r.id === id)) return;
    this.#rules.push({ ...rule, id });
  }

  /* At init (not setup : Foundry prepares the world's actors before setup) */
  static register(){
    if(game.system.id !== "dnd5e") return;
    patch.wrap("CONFIG.Item.dataModels.weapon.prototype.prepareFinalData", function(wrapped, ...args){
      try { weaponUses.prepare(this); } catch(error){ log.error(error); }
      return wrapped(...args);
    });
    patch.wrap("CONFIG.DND5E.activityTypes.attack.documentClass.prototype.rollAttack", function(wrapped, config = {}, ...rest){
      if((config.ability === undefined) && weaponUses.rulesFor(this.item).length) config = { ...config, ability : this.ability };
      return wrapped(config, ...rest);
    });
  }

  /**
   * The rules that apply to this weapon now.
   * @param {Item} item
   * @returns {object[]}
   */
  static rulesFor(item){
    if(item?.type !== "weapon" || !item.actor) return [];
    return this.#rules.filter(rule => {
      try { return !!rule.applies(item); }
      catch(error){ log.debug(rule.id, error); return false; }
    });
  }

  /**
   * On a weapon's data as dnd5e prepares it : back to its own die and abilities, then what the rules give it.
   * @param {object} system   the weapon's system data
   */
  static prepare(system){
    const item = system?.parent;
    const base = system?.damage?.base;
    if(!item || !base) return;
    /* Prepared again without being rebuilt : start from the weapon's own */
    const original = this.#original.get(system);
    if(!original) this.#original.set(system, { number : base.number, denomination : base.denomination, formula : base.custom?.formula, bonus : base.bonus });
    else {
      base.number = original.number;
      base.denomination = original.denomination;
      if(base.custom) base.custom.formula = original.formula;
      base.bonus = original.bonus;
    }
    const attacks = (system.activities?.contents ?? [...(system.activities ?? [])]).filter(a => (a.type === "attack") && a.attack?.abilities);
    for(const activity of attacks) for(const ability of this.#added.get(activity) ?? []) activity.attack.abilities.delete(ability);

    const rules = this.rulesFor(item);
    if(!rules.length) return;
    const faces = Math.max(0, ...rules.map(r => Number(r.die?.(item)) || 0));
    if(faces) this.#die(base, faces);
    const abilities = [...new Set(rules.flatMap(r => r.abilities?.(item) ?? []))];
    for(const activity of attacks){
      if(["none", "spellcasting"].includes(activity.attack.ability)) continue;
      const add = abilities.filter(a => !activity.attack.abilities.has(a));
      for(const ability of add) activity.attack.abilities.add(ability);
      this.#added.set(activity, add);
    }
  }

  /* The damage die raised to these faces, when its own is smaller */
  static #die(base, faces){
    if(base.custom?.enabled){
      const formula = String(base.custom.formula ?? "");
      const own = /(\d*)d(\d+)/i.exec(formula);
      if(!own) base.custom.formula = (/^\s*\d*\s*$/.test(formula)) ? `1d${faces}` : formula.replace(/^\s*\d+\b/, `1d${faces}`);
      else if(Number(own[2]) < faces) base.custom.formula = formula.replace(own[0], `1d${faces}`);
    }
    else if((Number(base.denomination) || 0) < faces){
      /* dnd5e's own Unarmed Strike has no die : its flat 1 is in the bonus ("1 + @mod"), and the die replaces it */
      if(!(Number(base.denomination) > 0) && (typeof base.bonus === "string")) base.bonus = base.bonus.replace(/^\s*\d+(?![\dd.])\s*(\+\s*)?/i, "");
      base.number = 1;
      base.denomination = faces;
    }
  }
}
