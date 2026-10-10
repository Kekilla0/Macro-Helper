import { module } from '../module.js';
import { withUnlocked } from '../helpers/utils.js';
import { logger } from '../log.js';
const log = logger.for(import.meta.url);

/**
 * Corrections to imported data (Plutonium's), in one place. Features add a fix; each looks at a document and says what
 * to change, or null :
 *   { update : { "system.path" : value }, activities : ids to remove, effects : ids, items : ids (an actor's),
 *     create : { effects : [data with an _id] } (made first, so update can link them), updateEffects : [{ _id, ... }] }
 * A fix must say nothing once its change is there (an effect it makes : look for its _id).
 * Where it looks :
 *   "pack:<name>" : entries of one of the module's compendiums (fighting-styles, familiars...)
 *   "owned"       : items on the world's actors (a character's features)
 * Applied as a document is made (by the user who made it; Foundry won't drop embedded documents while creating), and
 * once when the GM loads, for anything already there. Each fix has a row in docs/plutonium-notes.md.
 */
export class itemFixes{
  static #fixes = [];

  /**
   * @param {object} fix
   * @param {string} fix.name                   for the log
   * @param {string} fix.where                  "pack:<name>" or "owned"
   * @param {(doc : Item|Actor) => object|null} fix.plan
   */
  static add(fix){
    if(this.#fixes.some(f => f.name === fix.name)) return;
    this.#fixes.push(fix);
  }

  static #applies(fix, doc){
    if(fix.where.startsWith("pack:")) return doc?.pack === `${module.id}.${fix.where.slice(5)}`;
    if(fix.where === "owned") return !doc?.pack && (doc?.documentName === "Item") && (doc.parent?.documentName === "Actor");
    return false;
  }

  /**
   * Everything a document needs changed, from every fix that looks at it, or null.
   * @param {Item|Actor} doc
   * @returns {{ update? : object, activities : string[], effects : string[], items : string[] }|null}
   */
  static planFor(doc){
    const out = { activities : [], effects : [], items : [], createEffects : [], updateEffects : [] };
    let update = null;
    for(const fix of this.#fixes){
      if(!this.#applies(fix, doc)) continue;
      const plan = fix.plan(doc);
      if(!plan) continue;
      if(plan.update && Object.keys(plan.update).length) update = { ...(update ?? {}), ...plan.update };
      for(const key of ["activities", "effects", "items", "updateEffects"]) out[key].push(...(plan[key] ?? []));
      out.createEffects.push(...(plan.create?.effects ?? []));
    }
    if(update) out.update = update;
    /* Two fixes changing one effect : one update for it */
    const byId = new Map();
    for(const change of out.updateEffects) byId.set(change._id, { ...(byId.get(change._id) ?? {}), ...change });
    out.updateEffects = [...byId.values()];
    return (update || ["activities", "effects", "items", "createEffects", "updateEffects"].some(k => out[k].length)) ? out : null;
  }

  /* Apply what a document needs (a compendium's must be unlocked) */
  static async apply(doc){
    const plan = this.planFor(doc);
    if(!plan) return false;
    const del = globalThis._del ?? new foundry.data.operators.ForcedDeletion();
    if(plan.createEffects.length) await doc.createEmbeddedDocuments("ActiveEffect", plan.createEffects, { keepId : true });
    if(plan.updateEffects.length) await doc.updateEmbeddedDocuments("ActiveEffect", plan.updateEffects);
    const update = { ...(plan.update ?? {}), ...Object.fromEntries(plan.activities.map(id => [`system.activities.${id}`, del])) };
    if(Object.keys(update).length) await doc.update(update);
    if(plan.effects.length) await doc.deleteEmbeddedDocuments("ActiveEffect", plan.effects);
    if(plan.items.length) await doc.deleteEmbeddedDocuments("Item", plan.items);
    log.info("Corrected", doc.name, plan);
    return true;
  }

  static register(){
    Hooks.on("createItem", (item, options, userId) => { if(userId === game.user.id) this.apply(item).catch(error => log.error(error)); });
    Hooks.on("createActor", (actor, options, userId) => { if(userId === game.user.id) this.apply(actor).catch(error => log.error(error)); });
    Hooks.once("ready", () => this.repair().catch(error => log.error(error)));
  }

  /* Once on load (the GM) : the compendiums' entries and the world's actors' items */
  static async repair(){
    if(!game.users.activeGM?.isSelf) return;
    const packs = new Set(this.#fixes.filter(f => f.where.startsWith("pack:")).map(f => f.where.slice(5)));
    for(const name of packs){
      const pack = game.packs.get(`${module.id}.${name}`);
      if(!pack) continue;
      const docs = (await pack.getDocuments()).filter(d => this.planFor(d));
      if(!docs.length) continue;
      await withUnlocked(pack, async () => { for(const doc of docs) await this.apply(doc); });
      ui.notifications.info(module.format("compendiums.repaired", { count : docs.length, pack : pack.metadata.label }));
    }
    if(!this.#fixes.some(f => f.where === "owned")) return;
    for(const actor of game.actors){
      for(const item of actor.items) if(this.planFor(item)) await this.apply(item).catch(error => log.error(error));
    }
  }
}
