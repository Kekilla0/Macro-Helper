import { module } from '../module.js';
import { chooseOne } from '../helpers/creatures.js';
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
 *   Actions         (Item)  : Dash, Disengage, Dodge, Help, Hide, Unarmed Strike, Reckless Attack (filled from
 *                             examples/items when the GM loads the world : the ones it doesn't have yet).
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
  static SEEDS = ["dash", "disengage", "dodge", "help", "hide", "unarmed-strike", "reckless-attack"];

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

  /**
   * Search every Item compendium (2024 only : 2014 copies left out) : one entry per identifier, a copy of yours
   * (Plutonium's, in any compendium that isn't dnd5e's) before dnd5e's own, but a plain copy before one with uses of its
   * own (a feature's free casting : Plutonium's Advancement-Backing Items). Reading every index the first time takes a
   * few seconds (a progress notice when given one).
   * @param {(entry : object) => boolean} filter   on index entries (with system.identifier, system.source and fields)
   * @param {object} [options]
   * @param {string[]} [options.fields]   more index fields (system.type, system.level, system.properties...)
   * @param {string} [options.notice]     a progress notice while reading
   * @param {(entry : object) => string} [options.key]   what makes two entries the same (default : the identifier, else
   *                                       the name) : "metamagic-careful-spell" and "careful-spell" as one
   * @returns {Promise<object[]>}  index entries (uuid, name, img, ...), sorted by name
   */
  static async search(filter, { fields = [], notice = null, key = null } = {}){
    const bar = notice ? ui.notifications.info(notice, { progress : true }) : null;
    const found = new Map();
    try {
      const packs = [...game.packs].filter(p => p.documentName === "Item")
        .sort((a, b) => Number(a.metadata.packageName === "dnd5e") - Number(b.metadata.packageName === "dnd5e"));
      for(const pack of packs){
        let index;
        /* system.source whole : the server's index can't take source.rules where an item's source is a number */
        try { index = await pack.getIndex({ fields : ["system.identifier", "system.source", "system.uses", ...fields] }); } catch { continue; }
        const granted = e => !!(Number(e.system?.uses?.max) || String(e.system?.uses?.max ?? "").trim());
        for(const entry of index){
          if(String(entry.system?.source?.rules ?? "") === "2014") continue;
          const id = key?.(entry) ?? (entry.system?.identifier || entry.name);
          const had = found.get(id);
          if((had && !(granted(had) && !granted(entry))) || !filter(entry)) continue;
          found.set(id, entry);
        }
      }
    } finally { bar?.update?.({ pct : 1 }); }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
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

/**
 * Choose one entry from the compendiums, as a grid of pictures, and get it (a Fighting Style to swap in, a Pact weapon,
 * a homebrew "choose a creature to become"). From one compendium (`pack` : Macro Helper's by name, or any by its id),
 * else every Item compendium (compendiums.search : one per identifier, 2024 only).
 * @param {(entry : object) => boolean} [filter]   on index entries
 * @param {object} [options]
 * @param {string} [options.pack]
 * @param {string[]} [options.fields]   more index fields for the filter
 * @param {string} [options.title], [options.prompt], [options.icon], [options.notice]
 * @param {number} [options.columns]
 * @param {(entry) => string} [options.detail]   a line under each name
 * @param {string} [options.empty]       the warning when there's nothing to choose
 * @param {(entry) => string} [options.key]   every Item compendium : what makes two entries the same (compendiums.search)
 * @returns {Promise<Document|null>}  the chosen document (from its compendium), null : none to choose, or closed
 */
export async function pickFromCompendium(filter = () => true, { pack = null, fields = [], title = "", prompt = "", icon = "fa-solid fa-book", columns = 3, notice = null, detail = null, empty = null, key = null } = {}){
  let entries;
  if(pack){
    const found = compendiums.pack(pack) ?? game.packs.get(pack);
    const index = found ? await found.getIndex({ fields : [...(compendiums.INDEX_FIELDS[found.documentName] ?? []), ...fields] }) : [];
    entries = [...index].filter(filter).sort((a, b) => a.name.localeCompare(b.name));
  }
  else entries = await compendiums.search(filter, { fields, notice, key });
  if(!entries.length){
    if(empty) ui.notifications.warn(empty);
    return null;
  }
  const chosen = await chooseOne(entries.map(e => ({ value : e.uuid, label : e.name, img : e.img, detail : detail?.(e) ?? "" })), { title, prompt, icon, columns });
  return chosen ? await fromUuid(chosen) : null;
}
