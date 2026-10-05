import { module } from '../module.js';
import { withUnlocked } from '../helpers/utils.js';
import { logger } from '../log.js';
import { itemFixes } from './item-fixes.js';
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
    this.registerFixes();
    Hooks.once("ready", () => this.seedActions());
    Hooks.on("createActor", actor => this.fileSummon(actor));
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

  /* ---------- Corrected : as they're dropped in, and once on load (item-fixes.js) ---------- */

  static idOf(doc){
    return String(doc?.identifier ?? doc?.system?.identifier ?? "").replace(/^fighting-style-/, "");
  }

  static registerFixes(){
    itemFixes.add({ name : "Fighting Styles", where : `pack:${this.FIGHTING_STYLES}`, plan : doc => this.stylePlan(doc) });
    /* The same feats on a character (Plutonium's own, picked at level-up) */
    itemFixes.add({ name : "Fighting Styles (characters)", where : "owned", plan : doc => ((doc.type === "feat") ? this.stylePlan(doc) : null) });
    /* A familiar can't attack */
    itemFixes.add({ name : "Familiars", where : `pack:${this.FAMILIARS}`, plan : doc => {
      const items = doc.items.filter(i => [...(i.system?.activities ?? [])].some(a => a.type === "attack")).map(i => i.id);
      return items.length ? { items } : null;
    } });
  }

  /* A Fighting Style feat, corrected : what the module does itself comes off */
  static stylePlan(doc){
    const id = this.idOf(doc);
    const activities = [...(doc.system?.activities ?? [])];
    /* The attack card's Intercept / Protect buttons do it */
    if(["interception", "protection"].includes(id)) return { activities : activities.map(a => a.id), effects : doc.effects.map(e => e.id) };
    /* Always-on bonuses that only sometimes apply : the module adds them when they do */
    if(["dueling", "archery"].includes(id)) return { effects : doc.effects.map(e => e.id) };
    if(id === "unarmed-fighting"){
      const attacks = activities.filter(a => a.type === "attack").map(a => a.id);
      return attacks.length ? { activities : attacks } : null;
    }
    return null;
  }

  /* ---------- Summoned creatures : imported once (dnd5e reuses the copy), kept in one folder ---------- */

  static async fileSummon(actor){
    if(!game.users.activeGM?.isSelf || !actor?.getFlag?.("dnd5e", "isAutoImported")) return;
    let folder = game.folders.find(f => (f.type === "Actor") && f.getFlag(module.id, "summons"));
    folder ??= await Folder.implementation.create({ name : module.i18n("compendiums.summonsFolder"), type : "Actor", flags : { [module.id] : { summons : true } } });
    if(folder && (actor.folder?.id !== folder.id)) await actor.update({ folder : folder.id });
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
    await withUnlocked(pack, () => Item.implementation.createDocuments(data.map(d => { const c = { ...d }; delete c._id; return c; }), { pack : pack.collection }));
    log.info("Actions compendium filled", missing);
  }
}
