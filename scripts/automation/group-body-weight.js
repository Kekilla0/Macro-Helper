import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { idOf } from '../helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * Group Travel : Weight by Species (homebrew switch homebrewSpeciesWeight). A member with no GM-typed or sheet Weight
 * gets its species' weight from the 2014 PHB Height and Weight table (Volo's for Aasimar, Goliath, Orc) : base weight
 * + height roll x weight roll. Rolled once on the GM's client and kept (flag speciesWeight { value, formula, species }),
 * rolled again only when the species item changes. A species not in the table keeps the size estimate.
 */
export class groupBodyWeight{
  /* First match wins (half-elf before elf, drow before elf) : the species', its name's or its features' identifiers */
  static TABLE = [
    { match : ["half-elf"], base : 110, height : "2d8", weight : "2d4" },
    { match : ["half-orc"], base : 140, height : "2d10", weight : "2d6" },
    { match : ["drow"], base : 75, height : "2d6", weight : "1d6" },
    { match : ["wood-elf"], base : 100, height : "2d10", weight : "1d4" },
    { match : ["elf"], base : 90, height : "2d10", weight : "1d4" },
    { match : ["mountain-dwarf", "dwarf-mountain"], base : 130, height : "2d4", weight : "2d6" },
    { match : ["dwarf"], base : 115, height : "2d4", weight : "2d6" },
    { match : ["halfling"], base : 35, height : "2d4", weight : "1" },
    { match : ["gnome"], base : 35, height : "2d4", weight : "1" },
    { match : ["dragonborn"], base : 175, height : "2d8", weight : "2d6" },
    { match : ["tiefling"], base : 110, height : "2d8", weight : "2d4" },
    { match : ["aasimar"], base : 110, height : "2d10", weight : "2d4" },
    { match : ["goliath"], base : 200, height : "2d10", weight : "2d6" },
    { match : ["orc"], base : 175, height : "2d8", weight : "2d6" },
    { match : ["human"], base : 110, height : "2d10", weight : "2d4" },
  ];

  static #rolling = new Set();

  static on(){
    return !!settings.value("homebrewSpeciesWeight");
  }

  static speciesOf(actor){
    return actor?.items?.find?.(i => i.type === "race") ?? null;
  }

  /* The species' row : its identifier, its name, or a feature it granted (a lineage) */
  static rowOf(actor, species){
    const granted = actor.items.filter(i => (i.type === "feat") && String(i.getFlag("dnd5e", "advancementOrigin") ?? "").startsWith(`${species.id}.`));
    const ids = [idOf(species), species.name.slugify({ strict : true }), ...granted.map(i => idOf(i))].filter(Boolean);
    const has = (id, m) => new RegExp(`(^|-)${m}(-|$)`).test(id);
    return this.TABLE.find(row => row.match.some(m => ids.some(id => has(id, m)))) ?? null;
  }

  static formulaOf(row){
    return (row.weight === "1") ? `${row.base} + ${row.height}` : `${row.base} + (${row.height}) * (${row.weight})`;
  }

  /* "110 + 2d10 × 2d4" */
  static shown(formula){
    return `${formula ?? ""}`.replace(/[()]/g, "").replace("*", "×");
  }

  /* { value (lb), formula (shown) } : the kept roll; null while there's none (one is asked for on the GM's client) */
  static weightOf(actor){
    if(!this.on() || !actor?.system?.isCreature) return null;
    const species = this.speciesOf(actor);
    const row = species && this.rowOf(actor, species);
    if(!row) return null;
    const kept = actor.getFlag(module.id, "speciesWeight");
    if((kept?.species === species.id) && (kept.value > 0)) return { value : kept.value, formula : this.shown(kept.formula) };
    if(game.ready && game.users.activeGM?.isSelf) this.roll(actor, species, row);
    return null;
  }

  static roll(actor, species, row){
    if(this.#rolling.has(actor.uuid)) return;
    this.#rolling.add(actor.uuid);
    setTimeout(async () => {
      try {
        const formula = this.formulaOf(row);
        const roll = await new Roll(formula).evaluate();
        await actor.setFlag(module.id, "speciesWeight", { value : roll.total, formula, species : species.id });
      } catch(err) { log.error("Weight by Species :", err); }
      finally { this.#rolling.delete(actor.uuid); }
    }, 0);
  }
}
