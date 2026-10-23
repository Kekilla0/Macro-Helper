import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { idOf, esc, whisperOwners, gmIds } from '../helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * Species items that come at a later character level (Species setting). Plutonium gives a species everything at once
 * (or only what fits the level range picked at import), and its level-ups never add the rest. So :
 *   - below the level : the item is held on the species item (a flag) and taken off the character;
 *   - from the level  : it's given back (the held copy), or, for a spell that never came, a 2024 copy from the
 *                       compendiums (Plutonium's Advancement-Backing copy first, then any other, dnd5e's last), set up
 *                       like the species' own : always prepared, once a Long Rest free, the species' casting ability.
 * Watched on every level change (class levels, species added), and once when the GM loads. Switched off, the held
 * items are given back on the GM's next load. Only the species in LEVELS (2024); any other is left alone.
 */
export class speciesLevels{
  /* Species (or their lineage / legacy feature) identifiers -> the items' identifiers and character levels */
  static LEVELS = [
    { match : ["elf-drow-lineage", "elven-lineage-drow"], items : { "faerie-fire" : 3, "darkness" : 5 } },
    { match : ["elf-high-elf-lineage", "elven-lineage-high-elf"], items : { "detect-magic" : 3, "misty-step" : 5 } },
    { match : ["elf-wood-elf-lineage", "elven-lineage-wood-elf"], items : { "longstrider" : 3, "pass-without-trace" : 5 } },
    { match : ["tiefling-abyssal-legacy", "fiendish-legacy-abyssal"], items : { "ray-of-sickness" : 3, "hold-person" : 5 } },
    { match : ["tiefling-chthonic-legacy", "fiendish-legacy-chthonic"], items : { "false-life" : 3, "ray-of-enfeeblement" : 5 } },
    { match : ["tiefling-infernal-legacy", "fiendish-legacy-infernal"], items : { "hellish-rebuke" : 3, "darkness" : 5 } },
    { match : ["aasimar"], items : { "celestial-revelation" : 3 } },
    { match : ["dragonborn"], items : { "draconic-flight" : 5 } },
    { match : ["goliath"], items : { "large-form" : 5 } },
  ];

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("speciesRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    const changed = (item, userId) => {
      if((userId !== game.user.id) || !["class", "race"].includes(item?.type) || (item.parent?.type !== "character")) return;
      this.soon(item.parent);
    };
    Hooks.on("createItem", (item, options, userId) => changed(item, userId));
    Hooks.on("deleteItem", (item, options, userId) => changed(item, userId));
    Hooks.on("updateItem", (item, changes, options, userId) => { if(foundry.utils.hasProperty(changes, "system.levels")) changed(item, userId); });
    /* A whole character made at once (a copy, a file) : its items fire no createItem */
    Hooks.on("createActor", (actor, options, userId) => { if((userId === game.user.id) && (actor.type === "character")) this.soon(actor); });
    Hooks.once("ready", () => this.repair().catch(error => log.error(error)));
  }

  /* A level-up makes several changes (class, then its features) : once they've settled */
  static #timers = new Map();
  static soon(actor, delay = 750){
    clearTimeout(this.#timers.get(actor.uuid));
    this.#timers.set(actor.uuid, setTimeout(() => {
      this.#timers.delete(actor.uuid);
      this.sync(actor, { announce : true }).catch(error => log.error(error));
    }, delay));
  }

  /* Once on load (the GM) : every character, or (switched off) everything held given back */
  static async repair(){
    if(!game.users.activeGM?.isSelf) return;
    for(const actor of game.actors.filter(a => a.type === "character")){
      if(this.enabled()) await this.sync(actor).catch(error => log.error(error));
      else await this.release(actor).catch(error => log.error(error));
    }
  }

  /* ---------- What a species has ---------- */

  static speciesOf(actor){
    return actor?.items?.find?.(i => i.type === "race") ?? null;
  }

  /* The items the species grants (Plutonium's ItemGrant : advancementOrigin "<species id>.<advancement id>") */
  static grantedBy(actor, species){
    return actor.items.filter(i => String(i.getFlag("dnd5e", "advancementOrigin") ?? "").startsWith(`${species.id}.`));
  }

  /* Its row in LEVELS : by the species' identifier, or one of its features' (a lineage) */
  static rowOf(actor, species){
    if((species.system?.source?.rules ?? "") && (String(species.system.source.rules) !== "2024")) return null;
    const ids = [idOf(species), ...this.grantedBy(actor, species).map(i => idOf(i))].filter(Boolean);
    return this.LEVELS.find(row => row.match.some(m => ids.some(id => (id === m) || id.startsWith(`${m}-`)))) ?? null;
  }

  static held(species){
    return foundry.utils.deepClone(species.getFlag(module.id, "heldItems") ?? {});
  }

  /* ---------- Holding and giving back ---------- */

  /**
   * Hold what the character's level doesn't reach yet, give back (or add) what it does.
   * @param {Actor} actor
   * @param {object} [options]
   * @param {boolean} [options.announce]   say in chat what was given (a level-up)
   */
  static #busy = new Set();
  static async sync(actor, { announce = false } = {}){
    if(!this.enabled() || (actor?.type !== "character") || !actor.isOwner || this.#busy.has(actor.uuid)) return;
    const species = this.speciesOf(actor);
    const row = species ? this.rowOf(actor, species) : null;
    if(!row) return;
    this.#busy.add(actor.uuid);
    try {
      const level = Number(actor.system.details?.level) || 0;
      const granted = this.grantedBy(actor, species);
      const held = this.held(species);
      const hold = [], give = [], missing = [];
      for(const [id, at] of Object.entries(row.items)){
        const own = granted.filter(i => idOf(i) === id);
        if(level < at){ if(own.length) hold.push(...own); }
        else if(!own.length) give.push({ id, at });
      }
      /* Held : kept on the species item, then taken off */
      if(hold.length){
        for(const item of hold) held[idOf(item)] = item.toObject();
        await species.setFlag(module.id, "heldItems", held);
        await actor.deleteEmbeddedDocuments("Item", hold.map(i => i.id), { [module.id] : { speciesHold : true } });
        log.info("Held until their level", actor.name, hold.map(i => i.name));
      }
      /* Given : the held copy, else a spell from the compendiums */
      const create = [];
      for(const { id, at } of give){
        const data = held[id] ?? await this.spellFor(actor, species, id);
        if(!data){ missing.push(id); continue; }
        foundry.utils.setProperty(data, `flags.${module.id}.speciesLevel`, at);
        create.push(data);
      }
      if(create.length){
        await actor.createEmbeddedDocuments("Item", create, { keepId : true });
        for(const data of create) if(held[data.system?.identifier]) await species.unsetFlag(module.id, `heldItems.${data.system.identifier}`);
        log.info("Given at their level", actor.name, create.map(d => d.name));
        if(announce) await whisperOwners(actor, module.format("species.levelGiven", { name : actor.name, level, species : species.name,
          items : create.map(d => d.name).join(", ") }));
      }
      if(missing.length && announce) await ChatMessage.implementation.create({ whisper : gmIds(), speaker : { alias : module.title },
        content : `<p>${esc(module.format("species.levelMissing", { name : actor.name, species : species.name, items : missing.join(", ") }))}</p>` });
    } finally { this.#busy.delete(actor.uuid); }
  }

  /* Switched off : everything held goes back on the character */
  static async release(actor){
    const species = this.speciesOf(actor);
    const held = species ? this.held(species) : {};
    if(!actor.isOwner || !Object.keys(held).length) return;
    const have = new Set(actor.items.map(i => i.id));
    const create = Object.values(held).filter(d => !have.has(d._id));
    if(create.length) await actor.createEmbeddedDocuments("Item", create, { keepId : true });
    await species.unsetFlag(module.id, "heldItems");
    log.info("Given back (Species off)", actor.name, create.map(d => d.name));
  }

  /* ---------- A spell that never came ---------- */

  static #indexes = new Map();
  static async #index(pack){
    if(!this.#indexes.has(pack.collection)){
      this.#indexes.set(pack.collection, pack.getIndex({ fields : ["system.identifier", "system.source", "system.uses"] }).catch(() => []));
    }
    return this.#indexes.get(pack.collection);
  }

  /**
   * A 2024 copy of the spell from the Item compendiums : one with uses of its own (Plutonium's Advancement-Backing copy
   * of a species spell) first, then any other, dnd5e's last; made the species' (see speciesSpell).
   * @returns {Promise<object|null>}  item data
   */
  static async spellFor(actor, species, id){
    const rank = (pack, entry) => (pack.metadata.packageName === "dnd5e" ? 2 : 0)
      + ((Number(entry.system?.uses?.max) || String(entry.system?.uses?.max ?? "").trim()) ? 0 : 1);
    let best = null;
    for(const pack of game.packs.filter(p => p.documentName === "Item")){
      for(const entry of await this.#index(pack)){
        if((entry.type !== "spell") || (entry.system?.identifier !== id) || (String(entry.system?.source?.rules ?? "") === "2014")) continue;
        const r = rank(pack, entry);
        if(!best || (r < best.rank)) best = { rank : r, uuid : entry.uuid ?? `${pack.collection}.${entry._id}` };
      }
    }
    const source = best ? await fromUuid(best.uuid) : null;
    return source ? this.speciesSpell(actor, species, source) : null;
  }

  /**
   * The spell set up like the species' own (Plutonium's way) : always prepared, cast once a Long Rest without a slot
   * (the item's use), with the ability the species' other spells use, granted by the species.
   */
  static speciesSpell(actor, species, source){
    const data = source.toObject();
    delete data._id;
    foundry.utils.setProperty(data, "_stats.compendiumSource", source.uuid);
    const granted = this.grantedBy(actor, species);
    const sibling = granted.find(i => (i.type === "spell") && i.system.ability);
    const grant = String(granted[0]?.getFlag("dnd5e", "advancementOrigin") ?? "")
      || `${species.id}.${(species.system.advancement?.contents ?? []).find(a => a.type === "ItemGrant")?.id ?? ""}`;
    foundry.utils.mergeObject(data, {
      "system.method" : "atwill",
      "system.prepared" : 2,
      "system.sourceItem" : "",
      "flags.dnd5e.advancementOrigin" : grant,
    });
    if(sibling) data.system.ability = sibling.system.ability;
    if(!(Number(data.system.uses?.max) || String(data.system.uses?.max ?? "").trim())){
      data.system.uses = { max : "1", spent : 0, recovery : [{ period : "lr", type : "recoverAll" }] };
    }
    for(const activity of Object.values(data.system.activities ?? {})){
      const targets = activity.consumption?.targets ?? [];
      if(targets.some(t => t.type === "itemUses")) continue;
      foundry.utils.setProperty(activity, "consumption.targets", [...targets, { type : "itemUses", value : "1", target : "", scaling : {} }]);
    }
    return data;
  }
}
