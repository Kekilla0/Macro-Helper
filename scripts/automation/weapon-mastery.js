import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { chooseSet } from '../helpers/creatures.js';
import { restChoices } from './rest-choices.js';
import { limits } from './limits.js';
const log = logger.for(import.meta.url);

/**
 * Weapon Mastery (Classes setting) : which kinds of weapon a character has mastered, kept where dnd5e keeps them (the
 * sheet's Weapon Proficiencies → Mastery). Plutonium never asks, so it's chosen here, from Rest Choices (after a Long
 * Rest, or any time from the sheet's header button).
 *
 *   How many  : the class's mastery count (Fighter 3 / 4 / 5 / 6, Barbarian 2 / 3 / 4, Paladin, Ranger, Rogue 2); a
 *               multiclass character uses the highest.
 *   Which     : what the classes allow : Fighter, Paladin, Ranger any Simple or Martial; Barbarian melee ones; Rogue
 *               Finesse or Light ones.
 *   Changing  : adding up to the count is free any time; replacing one needs a Long Rest (one swap). The GM : freely.
 *               A change made on the sheet that the rules don't allow follows Rule Limits.
 */
export class weaponMastery{
  /* Class identifier : which weapons, and the count by class level (the class's own "mastery" scale wins) */
  static CLASSES = {
    fighter : { pool : "any", table : { 1 : 3, 4 : 4, 10 : 5, 16 : 6 } },
    barbarian : { pool : "melee", table : { 1 : 2, 4 : 3, 10 : 4 } },
    paladin : { pool : "any", table : { 1 : 2 } },
    ranger : { pool : "any", table : { 1 : 2 } },
    rogue : { pool : "finesseLight", table : { 1 : 2 } },
  };

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("preUpdateActor", (actor, changes, options) => this.onSheetChange(actor, changes, options));
    restChoices.add({
      id : "weaponMastery", label : "restChoices.weaponMastery", rest : "long",
      applies : actor => this.enabled() && (this.limitOf(actor) > 0),
      grant : actor => actor.setFlag(module.id, "masterySwaps", 1),
      summary : actor => module.format("weaponMastery.summary", { known : this.knownOf(actor).length, max : this.limitOf(actor),
        swaps : Number(actor.getFlag(module.id, "masterySwaps")) || 0 }),
      open : actor => this.choose(actor),
    });
  }

  /* The character's classes that give Weapon Mastery, with their levels */
  static classesOf(actor){
    return Object.entries(actor?.classes ?? {}).filter(([id]) => this.CLASSES[id]).map(([id, item]) => ({ id, level : Number(item.system?.levels) || 0 }));
  }

  /* How many kinds it may master : the highest of its classes */
  static limitOf(actor){
    return Math.max(0, ...this.classesOf(actor).map(({ id, level }) => {
      const scale = actor.system?.scale?.[id] ?? {};
      const value = Number(scale.mastery?.value ?? scale["weapon-mastery"]?.value);
      if(value > 0) return value;
      const table = this.CLASSES[id].table;
      return Object.entries(table).filter(([at]) => level >= Number(at)).map(([, n]) => n).pop() ?? 0;
    }));
  }

  static knownOf(actor){
    return [...(actor?.system?.traits?.weaponProf?.mastery?.value ?? [])];
  }

  /* dnd5e's base weapons, with their type and properties (from the compendium index) */
  static async weaponKinds(){
    const ids = CONFIG.DND5E.weaponIds ?? {};
    const toUuid = id => dnd5e.documents?.Trait?.getBaseItemUUID?.(id)
      ?? (String(id).startsWith("Compendium.") ? id : `Compendium.${CONFIG.DND5E.sourcePacks?.ITEMS}.Item.${id}`);
    const byPack = new Map();
    for(const [key, id] of Object.entries(ids)){
      const { collection, documentId } = foundry.utils.parseUuid(toUuid(id));
      if(!collection) continue;
      if(!byPack.has(collection)) byPack.set(collection, []);
      byPack.get(collection).push({ key, documentId });
    }
    const kinds = [];
    for(const [pack, entries] of byPack){
      const index = await pack.getIndex({ fields : ["system.type.value", "system.properties"] });
      for(const { key, documentId } of entries){
        const entry = index.get(documentId);
        if(!entry) continue;
        kinds.push({ key, name : entry.name, img : entry.img, type : entry.system?.type?.value ?? "", properties : new Set(entry.system?.properties ?? []) });
      }
    }
    return kinds.sort((a, b) => a.name.localeCompare(b.name));
  }

  /* Does a weapon kind fit what one of the character's classes allows ? */
  static allows(pool, kind){
    if(!["simpleM", "simpleR", "martialM", "martialR"].includes(kind.type)) return false;
    if(pool === "melee") return kind.type.endsWith("M");
    if(pool === "finesseLight") return kind.properties.has("fin") || kind.properties.has("lgt");
    return true;
  }

  /**
   * Choose the masteries : add up to the limit, replace with a swap (a Long Rest gives one). The GM : freely.
   * @param {Actor} actor
   * @returns {Promise<string[]|null>}
   */
  static async choose(actor){
    const pools = this.classesOf(actor).map(({ id }) => this.CLASSES[id].pool);
    const kinds = (await this.weaponKinds()).filter(k => pools.some(p => this.allows(p, k)));
    if(!kinds.length) return null;
    const known = this.knownOf(actor);
    const swaps = game.user.isGM ? Infinity : (Number(actor.getFlag(module.id, "masterySwaps")) || 0);
    const max = this.limitOf(actor);
    const chosen = await chooseSet(kinds.map(k => ({
      value : k.key, label : k.name, img : k.img,
      detail : [CONFIG.DND5E.weaponTypes?.[k.type] ?? "", ...["fin", "lgt"].filter(p => k.properties.has(p)).map(p => CONFIG.DND5E.itemProperties?.[p]?.label ?? p)]
        .filter(Boolean).join(" · "),
    })), { known, max, swaps, allowPast : limits.canGoPast(), icon : "fa-solid fa-swords", title : module.format("weaponMastery.title", { name : actor.name }), prompt : module.i18n("weaponMastery.prompt") });
    if(!chosen) return null;
    const removedPast = known.filter(k => !chosen.includes(k)).length;
    const allowed = swaps + Math.max(0, known.length - max);
    if(chosen.past && (removedPast > allowed)){
      await limits.tellGM({ who : actor.name, what : module.i18n("restChoices.weaponMastery"), rule : module.format("weaponMastery.past", { name : actor.name, removed : removedPast, allowed }) });
    }
    const offered = new Set(kinds.map(k => k.key));
    /* Masteries outside what's offered stay (a GM's own additions) */
    const kept = known.filter(k => !offered.has(k));
    const removed = known.filter(k => offered.has(k) && !chosen.includes(k)).length;
    const update = { "system.traits.weaponProf.mastery.value" : [...kept, ...chosen] };
    /* Allowed past the rules : the sheet check mustn't refuse it */
    if(Number.isFinite(swaps)) update[`flags.${module.id}.masterySwaps`] = Math.max(0, swaps + Math.max(0, known.length - max) - removed);
    await actor.update(update, { [module.id] : { mastery : true } });
    log.debug("Weapon masteries", actor.name, chosen);
    return chosen;
  }

  /* A change on the sheet : more than the count, or a replacement with no swap left, follows Rule Limits */
  static onSheetChange(actor, changes, options = {}){
    if(!this.enabled() || game.user.isGM || options[module.id]?.mastery) return;
    const next = foundry.utils.getProperty(changes ?? {}, "system.traits.weaponProf.mastery.value");
    if(next === undefined) return;
    const max = this.limitOf(actor);
    if(!(max > 0)) return;
    const before = this.knownOf(actor);
    const after = [...(next ?? [])];
    const removed = before.filter(k => !after.includes(k)).length;
    const swaps = (Number(actor.getFlag(module.id, "masterySwaps")) || 0) + Math.max(0, before.length - max);
    let problem = null;
    if(after.length > max) problem = module.format("weaponMastery.tooMany", { name : actor.name, max });
    else if(removed > swaps) problem = module.format("weaponMastery.noSwap", { name : actor.name });
    if(problem && !limits.allow(problem, { who : actor.name, what : module.i18n("weaponMastery.sheetChange") })) return false;
    if(removed) foundry.utils.setProperty(changes, `flags.${module.id}.masterySwaps`, Math.max(0, (Number(actor.getFlag(module.id, "masterySwaps")) || 0) - removed));
  }
}
