import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf, esc, chooseOption } from '../helpers/utils.js';
import { chooseOne } from '../helpers/creatures.js';
import { compendiums } from './compendiums.js';
const log = logger.for(import.meta.url);

/**
 * Spell pools (a lego) : spells a creature keeps in something of its own (a Book of Shadows, a Wizard's spellbook),
 * with free places by kind. open(actor, swap) : its empty places filled from the Item compendiums (free); once full, a
 * spell replaced by one of the same kind (with a Rest Choices count's `swap` : one left, or past it Rule Limits; the
 * GM freely), or one added past the free places at a cost (`extra` : a Wizard copying a spell scroll).
 *
 * spellPools.add(id, {
 *   title(actor)          the windows' title
 *   icon                  their icon (default a book)
 *   places(actor)         the free places : [{ key, count, prompt, filter(entry, actor) }]. A filter gets a compendium
 *                         index entry (system.level, system.identifier, system.properties as an array, and `fields`)
 *                         or an owned spell; a member spell fills the first kind its filter takes
 *   fields                more index fields the filters read
 *   members(actor)        the pool's spells now
 *   data(actor, place)    changes merged into an added spell's data (its method, class, flags)
 *   added(actor, spell)   after one is added (tie it to its book...)
 *   extra(actor)          ways to add one past the free places : [{ value, label, img, detail, uuid, take }] (async
 *                         allowed). take() pays for it (false : stopped, nothing added); the spell is marked paid
 *                         and fills no free place
 *   extraLabel            its choice's words (an i18n key, {n} : how many), default "Add one past the free places"
 *   full(actor)           the notice when nothing more can be done
 * })
 * A member added by the lego carries flags["macro-helper"].pool { id, paid }.
 */
export class spellPools{
  static #pools = new Map();

  static add(id, pool){
    if(!id || !pool) return;
    this.#pools.set(id, { icon : "fa-solid fa-book", ...pool, id });
  }

  static get(id){
    return this.#pools.get(id) ?? null;
  }

  /* A spell's property (an index entry's array, an item's Set) */
  static hasProperty(spell, key){
    const p = spell?.system?.properties;
    return Array.isArray(p) ? p.includes(key) : (p?.has?.(key) ?? !!p?.[key]);
  }

  static isPaid(spell){
    return !!spell?.getFlag?.(module.id, "pool")?.paid;
  }

  /* The place a member fills (paid ones : none) */
  static placeOf(actor, pool, spell){
    if(this.isPaid(spell)) return null;
    return (pool.places?.(actor) ?? []).find(p => p.filter(spell, actor)) ?? null;
  }

  /**
   * The free places left by kind. Each member takes a place of a kind its spell fits that still has room (the ones
   * fitting fewest kinds first : a Savant's school spell in a general place leaves the school places to others).
   * @returns {Record<string, number>}  place key : places left (0 when full; never below)
   */
  static room(actor, id){
    const pool = this.get(id);
    if(!pool || !actor) return {};
    const places = pool.places?.(actor) ?? [];
    const left = Object.fromEntries(places.map(p => [p.key, Number(p.count) || 0]));
    const fitting = pool.members(actor).filter(s => !this.isPaid(s)).map(s => places.filter(p => p.filter(s, actor)))
      .filter(f => f.length).sort((x, y) => x.length - y.length);
    for(const fits of fitting){
      const place = fits.find(p => left[p.key] > 0) ?? fits[0];
      left[place.key]--;
    }
    return Object.fromEntries(places.map(p => [p.key, Math.max(0, left[p.key])]));
  }

  /* The creature's own spells (not dnd5e's cached copies of spells its items cast : a scroll's, a feature's) */
  static known(actor){
    return new Set(actor.items.filter(i => (i.type === "spell") && !i.getFlag("dnd5e", "cachedFor")).map(i => idOf(i) || i.name));
  }

  /* The pool's spells, by name (Rest Choices' change list) */
  static names(actor, id){
    return this.get(id)?.members(actor).map(s => s.name) ?? [];
  }

  /* "4 / 6" : free places taken over places, all kinds together */
  static countText(actor, id){
    const pool = this.get(id);
    const places = pool?.places?.(actor) ?? [];
    const total = places.reduce((n, p) => n + (Number(p.count) || 0), 0);
    const left = Object.values(this.room(actor, id)).reduce((n, v) => n + v, 0);
    return `${total - left} / ${total}`;
  }

  /* The compendium spells that fit a place, not already the creature's */
  static async candidates(actor, pool, place){
    const have = this.known(actor);
    return compendiums.search(e => (e.type === "spell") && place.filter(e, actor) && !have.has(e.system?.identifier || e.name),
      { fields : ["system.level", "system.properties", "system.school", ...(pool.fields ?? [])], notice : module.i18n("spellPools.looking") });
  }

  static async pickFor(actor, pool, place, prompt){
    const options = await this.candidates(actor, pool, place);
    if(!options.length){
      ui.notifications.warn(module.format("spellPools.noneLeft", { name : pool.title(actor) }));
      return false;
    }
    return chooseOne(options.map(o => ({ value : o.uuid, label : o.name, img : o.img, detail : module.format("spellPools.level", { level : o.system?.level ?? 0 }) })),
      { title : pool.title(actor), icon : pool.icon, columns : 4, prompt });
  }

  static async addSpell(actor, pool, uuid, place, { paid = false } = {}){
    const source = await fromUuid(uuid);
    if(!source) return null;
    const data = source.toObject();
    delete data._id;
    foundry.utils.mergeObject(data, pool.data?.(actor, place) ?? {});
    foundry.utils.setProperty(data, `flags.${module.id}.pool`, { id : pool.id, paid });
    const [spell] = await actor.createEmbeddedDocuments("Item", [data]);
    if(spell) await pool.added?.(actor, spell);
    log.debug("Spell pool", pool.id, actor.name, spell?.name, paid ? "paid" : "free");
    return spell ?? null;
  }

  /**
   * The pool's window : empty places first, then (full) replace one or add one past the free places.
   * @param {Actor} actor
   * @param {string} id
   * @param {object} [swap]  a Rest Choices count's swap (replacing allowed)
   * @returns {Promise<boolean>}  something changed
   */
  static async open(actor, id, swap){
    const pool = this.get(id);
    if(!pool || !actor?.isOwner) return false;
    let changed = false;
    for(const place of pool.places?.(actor) ?? []){
      while((this.room(actor, id)[place.key] ?? 0) > 0){
        const chosen = await this.pickFor(actor, pool, place, module.format(place.prompt, { n : this.room(actor, id)[place.key] }));
        /* None left for this place : the next one */
        if(chosen === false) break;
        if(!chosen) return changed;
        if(!(await this.addSpell(actor, pool, chosen, place))) return changed;
        changed = true;
      }
    }
    /* Full */
    const members = pool.members(actor);
    const extra = (await pool.extra?.(actor)) ?? [];
    const ways = [];
    if(swap && members.some(s => this.placeOf(actor, pool, s)))
      ways.push({ value : "replace", label : module.format("spellPools.replace", { n : Number.isFinite(swap.left) ? swap.left : "∞" }) });
    if(extra.length) ways.push({ value : "extra", label : module.format(pool.extraLabel ?? "spellPools.extra", { n : extra.length }) });
    if(!ways.length){
      if(!changed) ui.notifications.info(pool.full?.(actor) ?? module.format("spellPools.full", { name : pool.title(actor) }));
      return changed;
    }
    const way = await chooseOption({ title : pool.title(actor), icon : pool.icon, prompt : module.format("spellPools.fullPrompt", { name : pool.title(actor) }), options : ways });
    if(way === "replace") return (await this.replace(actor, pool, swap)) || changed;
    if(way === "extra") return (await this.addExtra(actor, pool, extra)) || changed;
    return changed;
  }

  /* One spell for another of its kind, a change spent */
  static async replace(actor, pool, swap){
    if(!(await swap.allow())) return false;
    const members = pool.members(actor).filter(s => this.placeOf(actor, pool, s));
    const out = await chooseOne(members.map(s => ({ value : s.id, label : s.name, img : s.img })), { title : pool.title(actor), icon : pool.icon, columns : 3,
      prompt : module.i18n("spellPools.out") });
    const old = out ? actor.items.get(out) : null;
    const place = old ? this.placeOf(actor, pool, old) : null;
    if(!place) return false;
    const chosen = await this.pickFor(actor, pool, place, module.format("spellPools.in", { name : old.name }));
    if(!chosen) return false;
    await old.delete();
    const added = await this.addSpell(actor, pool, chosen, place);
    await swap.spend();
    /* Rest Choices' message lists the swap */
    return !!added;
  }

  /* One past the free places, paid for */
  static async addExtra(actor, pool, extra){
    const value = await chooseOne(extra.map(e => ({ value : e.value, label : e.label, img : e.img, detail : e.detail })), { title : pool.title(actor), icon : pool.icon, columns : 3,
      prompt : module.i18n("spellPools.extraPrompt") });
    const way = extra.find(e => e.value === value);
    if(!way?.uuid) return false;
    if(!(await way.take())) return false;
    return !!(await this.addSpell(actor, pool, way.uuid, null, { paid : true }));
  }
}

/* The lego, for macros : MacroHelper.addSpellPool / openSpellPool */
export const addSpellPool = (id, pool) => spellPools.add(id, pool);
export const openSpellPool = (actor, id, swap) => spellPools.open(actor, id, swap);
