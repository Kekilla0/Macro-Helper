import { module } from '../module.js';
import { logger } from '../log.js';
const log = logger.for(import.meta.url);

/**
 * Macro Helper's compendiums (the "Macro Helper" compendium folder) : what features choose from, kept in one place.
 *
 *   Wild Shapes     (Actor) : the Beasts a Druid can learn as forms (Plutonium's, dragged in).
 *   Familiars       (Actor) : the creatures Find Familiar / Wild Companion can summon.
 *   Fighting Styles (Item)  : the Fighting Style feats, for the level-up swap.
 *   Actions         (Item)  : Dash, Disengage, Dodge, Help, Unarmed Strike, Reckless Attack (filled from examples/items
 *                             the first time the GM loads the world, while it's empty).
 *
 * Dropped in, they're corrected to what the module expects (Plutonium's data, fixed) :
 *   Familiars : items with an attack removed (a familiar can't attack).
 *   Interception, Protection : their activities and effects removed (the attack card's Intercept / Protect buttons do it).
 *   Dueling, Archery : their always-on +2 effects removed (the +2 is added only when it applies).
 *   Unarmed Fighting : its two attacks removed (your own Unarmed Strike gets the d6 / d8); Grappled Damage stays.
 */
export class compendiums{
  static WILD_SHAPES = "wild-shapes";
  static FAMILIARS = "familiars";
  static FIGHTING_STYLES = "fighting-styles";
  static ACTIONS = "actions";
  static SEEDS = ["dash", "disengage", "dodge", "help", "unarmed-strike", "reckless-attack"];

  static INDEX_FIELDS = {
    Actor : ["system.details.cr", "system.details.type", "system.attributes.movement", "system.traits.size", "prototypeToken.texture.src", "prototypeToken.width", "prototypeToken.height"],
    Item : ["system.identifier", "system.type"],
  };

  static register(){
    /* Dropped in (by this user) : corrected right after (Foundry won't drop embedded effects while creating) */
    Hooks.on("createItem", (item, options, userId) => { if(userId === game.user.id) this.fix(item); });
    Hooks.on("createActor", (actor, options, userId) => { if(userId === game.user.id) this.fix(actor); });
    Hooks.once("ready", async () => {
      await this.seedActions();
      await this.repair();
    });
  }

  static pack(name){
    return game.packs.get(`${module.id}.${name}`) ?? null;
  }

  /**
   * A compendium's entries (index, with the fields features need : CR, type, speeds for creatures; identifier for items).
   * @param {string} name   "wild-shapes", "familiars", "fighting-styles", "actions"
   * @returns {Promise<object[]>}  index entries (each with its uuid), sorted by CR then name (creatures) or name
   */
  static async entries(name){
    const pack = this.pack(name);
    if(!pack) return [];
    const index = await pack.getIndex({ fields : this.INDEX_FIELDS[pack.documentName] ?? [] });
    const cr = e => Number(e.system?.details?.cr) || 0;
    return [...index].sort((a, b) => (cr(a) - cr(b)) || a.name.localeCompare(b.name));
  }

  /* ---------- Corrected : as they're dropped in, and once on load ---------- */

  static idOf(doc){
    return String(doc?.identifier ?? doc?.system?.identifier ?? "").replace(/^fighting-style-/, "");
  }

  /**
   * What a compendium document needs changed, or null : { activities : ids to remove, effects : ids, items : ids }.
   * @param {Item|Actor} doc
   */
  static needs(doc){
    const fix = { activities : [], effects : [], items : [] };
    if(doc.pack === `${module.id}.${this.FIGHTING_STYLES}`){
      const id = this.idOf(doc);
      const activities = [...(doc.system?.activities ?? [])];
      if(["interception", "protection"].includes(id)){
        fix.activities = activities.map(a => a.id);
        fix.effects = doc.effects.map(e => e.id);
      }
      /* Always-on bonuses that only sometimes apply : the module adds them when they do */
      if(["dueling", "archery"].includes(id)) fix.effects = doc.effects.map(e => e.id);
      if(id === "unarmed-fighting") fix.activities = activities.filter(a => a.type === "attack").map(a => a.id);
    }
    if(doc.pack === `${module.id}.${this.FAMILIARS}`){
      fix.items = doc.items.filter(i => [...(i.system?.activities ?? [])].some(a => a.type === "attack")).map(i => i.id);
    }
    return (fix.activities.length || fix.effects.length || fix.items.length) ? fix : null;
  }

  /* Apply the corrections to a document in one of our compendiums (its compendium must be unlocked) */
  static async fix(doc){
    const fix = (doc?.pack?.startsWith(`${module.id}.`)) ? this.needs(doc) : null;
    if(!fix) return false;
    const del = globalThis._del ?? new foundry.data.operators.ForcedDeletion();
    if(fix.activities.length) await doc.update(Object.fromEntries(fix.activities.map(id => [`system.activities.${id}`, del])));
    if(fix.effects.length) await doc.deleteEmbeddedDocuments("ActiveEffect", fix.effects);
    if(fix.items.length) await doc.deleteEmbeddedDocuments("Item", fix.items);
    log.info("Compendium entry corrected", doc.name, fix);
    return true;
  }

  /* Once on load (the GM) : anything dropped in before the corrections existed */
  static async repair(){
    if(!game.users.activeGM?.isSelf) return;
    for(const name of [this.FIGHTING_STYLES, this.FAMILIARS]){
      const pack = this.pack(name);
      if(!pack) continue;
      const docs = (await pack.getDocuments()).filter(d => this.needs(d));
      if(!docs.length) continue;
      const locked = pack.locked;
      if(locked) await pack.configure({ locked : false });
      try { for(const doc of docs) await this.fix(doc); }
      finally { if(locked) await pack.configure({ locked : true }); }
      ui.notifications.info(module.format("compendiums.repaired", { count : docs.length, pack : pack.metadata.label }));
    }
  }

  /* ---------- Actions : filled from examples/items, once ---------- */

  static async seedActions(){
    if(!game.users.activeGM?.isSelf) return;
    const pack = this.pack(this.ACTIONS);
    if(!pack) return;
    const index = await pack.getIndex({ fields : ["system.identifier"] });
    const have = new Set([...index].map(e => e.system?.identifier));
    const missing = this.SEEDS.filter(id => !have.has(id));
    if(!missing.length) return;
    const data = [];
    for(const id of missing){
      try {
        const response = await fetch(`${module.path ?? `modules/${module.id}`}/examples/items/${id}.json`);
        if(response.ok) data.push(await response.json());
      } catch(error){ log.error("Actions compendium", id, error); }
    }
    if(!data.length) return;
    const locked = pack.locked;
    if(locked) await pack.configure({ locked : false });
    try { await Item.implementation.createDocuments(data.map(d => { const c = { ...d }; delete c._id; return c; }), { pack : pack.collection }); }
    finally { if(locked) await pack.configure({ locked : true }); }
    log.info("Actions compendium filled", missing);
  }
}
