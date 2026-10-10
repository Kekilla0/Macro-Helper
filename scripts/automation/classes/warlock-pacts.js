import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { idOf, originItem, chooseOption, esc } from '../../helpers/utils.js';
import { chooseOne } from '../../helpers/creatures.js';
import { patch } from '../../patch.js';
import { uses } from '../../uses.js';
import { itemFixes } from '../item-fixes.js';
import { compendiums } from '../compendiums.js';
import { restChoices } from '../rest-choices.js';
import { limits } from '../limits.js';
import { hands } from '../hands.js';
import { TYPES } from '../../roll-item/message.js';
const log = logger.for(import.meta.url);

/**
 * The Warlock's pacts, Eldritch Invocations a level 1 Warlock can take (Classes setting). By identifier, whoever made
 * the items (Plutonium's data corrected by item fixes).
 *
 *   Pact of the Blade : a pact weapon (one at a time : forming another ends the last) attacks with the best of its own
 *                       ability (STR, or DEX for Finesse) and CHA, and deals its normal damage type : the attack card
 *                       offers Necrotic, Psychic or Radiant instead (its owner's buttons). Forge Pact Weapon asks : bond a
 *                       weapon (dnd5e's card : drop it there), or conjure one : a Simple or Martial melee weapon from the
 *                       Item compendiums, in your hands. Plutonium's extra "Spellcasting Attack" (on the invocation and
 *                       copied onto the weapon) is removed : the weapon's own attack does it.
 *   Pact of the Chain : its summons spend no spell slot; its Find Familiar (Plutonium's : a ritual) is a Magic action
 *                       with no slot. The familiar itself is automation/familiars.js (the special forms, attacks kept).
 *   Pact of the Tome  : the Book of Shadows, an item on the Warlock : the spells Plutonium adds with the invocation go
 *                       into it, and leave with it (deleting the book deletes them; losing the invocation, the book).
 *                       Rest Choices' Book of Shadows row : empty places filled from the Item compendiums (cantrips and
 *                       level 1 Rituals, any class), a new book when it's gone, one spell replaced per Warlock level
 *                       gained. Book spells don't count against the Warlock's prepared spells.
 */
export class pacts{
  static BLADE = "pact-of-the-blade";
  static CHAIN = "pact-of-the-chain";
  static TOME = "pact-of-the-tome";
  static PACT_TYPES = ["necrotic", "psychic", "radiant"];
  static BOOK = { cantrips : 3, rituals : 2 };

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static is2014(item){
    return String(item?.system?.source?.rules ?? "") === "2014";
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    /* ---------- Blade ---------- */
    itemFixes.add({ name : "Pact of the Blade", where : "owned", plan : item => this.bladeFix(item) });
    /* At init (not setup : the world's actors are prepared before setup) */
    {
      patch.wrap("CONFIG.Item.dataModels.weapon.prototype.prepareFinalData", function(wrapped, ...args){
        try { pacts.pactAbilities(this); } catch(error){ log.error(error); }
        return wrapped(...args);
      });
      patch.wrap("CONFIG.DND5E.activityTypes.attack.documentClass.prototype.rollAttack", function(wrapped, config = {}, ...rest){
        if((config.ability === undefined) && pacts.isPactWeapon(this.item)) config = { ...config, ability : this.ability };
        return wrapped(config, ...rest);
      });
    }
    Hooks.on(`${module.id}.damageType`, (activity, { types, preset }) => {
      if(this.isPactWeapon(activity?.item)) preset.type = types.find(t => !this.PACT_TYPES.includes(t)) ?? types[0];
    });
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => this.typeButtons(message, buttons, ray));
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => {
      if(String(id).startsWith("pactType|")) message.system.setDamageType?.(id.split("|")[1], Number.isInteger(ray) ? ray : null);
    });
    Hooks.on("createActiveEffect", (effect, options, userId) => { if(userId === game.user.id) this.onPactFormed(effect); });
    uses.onActivity("pactWeapon", (activity, ctx, next) => this.forgeStep(activity, ctx, next));
    /* ---------- Chain ---------- */
    itemFixes.add({ name : "Pact of the Chain", where : "owned", plan : item => this.chainFix(item) });
    /* ---------- Tome ---------- */
    Hooks.on("createItem", (item, options, userId) => { if(userId === game.user.id) this.onItemAdded(item); });
    Hooks.on("deleteItem", (item, options, userId) => { if(userId === game.user.id) this.onItemRemoved(item); });
    restChoices.add({
      id : "bookOfShadows", label : "restChoices.bookOfShadows", rest : "level", classes : ["warlock"],
      applies : actor => this.enabled() && !!this.tomeOf(actor),
      grant : actor => actor.setFlag(module.id, "bookSwaps", 1),
      summary : actor => this.bookSummary(actor),
      open : actor => this.openBook(actor),
    });
  }

  /* ========== Pact of the Blade ========== */

  /* Plutonium's "Spellcasting Attack" : on the invocation, as an enchantment rider, and copied onto weapons */
  static bladeFix(item){
    if(!this.enabled() || this.is2014(item)) return null;
    const source = item._source?.system?.activities ?? {};
    if(idOf(item) === this.BLADE){
      const attacks = Object.values(source).filter(a => a.type === "attack").map(a => a._id);
      const update = {};
      for(const a of Object.values(source).filter(a => a.type === "enchant")){
        const effects = (a.effects ?? []).map(e => ({ ...e, riders : { ...(e.riders ?? {}), activity : (e.riders?.activity ?? []).filter(id => !attacks.includes(id)) } }));
        if(effects.some((e, i) => (e.riders.activity.length !== (a.effects[i].riders?.activity ?? []).length))) update[`system.activities.${a._id}.effects`] = effects;
      }
      return (attacks.length || Object.keys(update).length) ? { activities : attacks, update } : null;
    }
    if(item.type !== "weapon") return null;
    const copied = Object.values(source).filter(a => (a.type === "attack") && (a.attack?.ability === "spellcasting") && a.flags?.dnd5e?.dependentOn).map(a => a._id);
    return copied.length ? { activities : copied } : null;
  }

  /* The weapon's pact enchantment (bonded or conjured) */
  static pactEffectOf(item){
    return item?.effects?.find?.(e => (e.type === "enchantment") && !e.disabled && (this.originId(e, item) === this.BLADE)) ?? null;
  }

  /* The identifier of the item an enchantment came from. While the actor is first prepared its other items may not
     be there yet : read from its source data then */
  static originId(effect, item){
    const origin = originItem(effect);
    if(origin) return idOf(origin);
    const id = /Item\.([^.]+)/.exec(String(effect.origin ?? ""))?.[1];
    const source = id ? item?.actor?._source?.items?.find?.(i => i._id === id) : null;
    return source?.system?.identifier ?? "";
  }

  static isPactWeapon(item){
    return this.enabled() && (item?.type === "weapon") && (!!this.pactEffectOf(item) || !!item.getFlag?.(module.id, "pactWeapon"));
  }

  static #added = new WeakMap();

  /* As dnd5e prepares the weapon : CHA beside its own abilities (dnd5e takes the highest) */
  static pactAbilities(system){
    const item = system?.parent;
    const attacks = (system?.activities?.contents ?? [...(system?.activities ?? [])]).filter(a => (a.type === "attack") && a.attack?.abilities);
    for(const activity of attacks) for(const ability of this.#added.get(activity) ?? []) activity.attack.abilities.delete(ability);
    if(!item?.actor || !this.isPactWeapon(item)) return;
    for(const activity of attacks){
      if(["none", "spellcasting"].includes(activity.attack.ability)) continue;
      /* Before dnd5e adds the weapon's own (STR, DEX for Finesse) in its final preparation */
      const add = ["cha"].filter(a => !activity.attack.abilities.has(a));
      for(const ability of add) activity.attack.abilities.add(ability);
      this.#added.set(activity, add);
    }
  }

  /* Necrotic, Psychic, Radiant (or back to its own type) : the attack card's buttons, for its owner */
  static typeButtons(message, buttons, ray){
    if(!this.enabled() || (message.type !== TYPES.attack) || !message.isOwner) return;
    const item = message.getAssociatedItem?.();
    if(!this.isPactWeapon(item)) return;
    const rolls = Number.isInteger(ray) ? (message.system.rayDamage?.(ray) ?? []) : (message.system.damageRolls ?? []);
    const current = rolls[0]?.options?.type;
    if(!current) return;
    const own = [...(item.system.damage?.base?.types ?? [])].find(t => !this.PACT_TYPES.includes(t));
    for(const type of [own, ...this.PACT_TYPES].filter(t => t && (t !== current))){
      buttons.push({ id : `pactType|${type}`, icon : "fa-wand-magic", label : module.format("classes.warlock.pactType", { type : game.i18n.localize(CONFIG.DND5E.damageTypes[type]?.label ?? type) }) });
    }
  }

  /* A pact weapon formed : the last one ends (its enchantment off a bonded weapon; a conjured one gone) */
  static async onPactFormed(effect){
    if(!this.enabled() || (effect.type !== "enchantment") || (this.originId(effect, effect.parent) !== this.BLADE)) return;
    const weapon = effect.parent;
    const actor = weapon?.actor;
    if(!actor) return;
    for(const other of actor.items.filter(i => (i !== weapon) && (i.type === "weapon"))){
      if(other.getFlag(module.id, "pactWeapon")?.conjured){ await other.delete(); continue; }
      const old = this.pactEffectOf(other);
      if(old) await old.delete();
    }
  }

  /* Forge Pact Weapon : bond a weapon (dnd5e's card), or conjure one */
  static async forgeStep(activity, ctx, next){
    if(!this.enabled() || (activity?.type !== "enchant") || (idOf(activity.item) !== this.BLADE) || !activity.actor?.isOwner) return next();
    const choice = await chooseOption({ title : activity.item.name, icon : "fa-solid fa-khanda", prompt : module.i18n("classes.warlock.forgePrompt"),
      options : [{ value : "bond", label : module.i18n("classes.warlock.forgeBond") }, { value : "conjure", label : module.i18n("classes.warlock.forgeConjure") }] });
    if(!choice) return;
    if(choice === "bond") return next();
    return this.conjure(activity);
  }

  static async conjure(activity){
    const actor = activity.actor;
    /* Mundane ones (a magic weapon can be bonded, not conjured) */
    const magical = e => { const p = e.system?.properties; return !!e.system?.rarity || (Array.isArray(p) ? p.includes("mgc") : !!p?.mgc); };
    /* The standard weapons (dnd5e's list of base weapons), not a creature's or a spell's attack items */
    const standard = new Set(Object.keys(CONFIG.DND5E.weaponIds ?? {}));
    const weapons = await compendiums.search(e => (e.type === "weapon") && ["simpleM", "martialM"].includes(e.system?.type?.value) && !magical(e)
      && (!standard.size || standard.has(e.system?.identifier) || standard.has(e.system?.type?.baseItem)),
      { fields : ["system.type", "system.rarity", "system.properties"], notice : module.i18n("classes.warlock.looking") });
    if(!weapons.length) return ui.notifications.warn(module.i18n("classes.warlock.noWeapons"));
    const chosen = await chooseOne(weapons.map(w => ({ value : w.uuid, label : w.name, img : w.img, detail : game.i18n.localize(CONFIG.DND5E.weaponTypes?.[w.system?.type?.value] ?? "") })),
      { title : activity.item.name, icon : "fa-solid fa-khanda", columns : 4, prompt : module.i18n("classes.warlock.conjurePrompt") });
    const source = chosen ? await fromUuid(chosen) : null;
    if(!source) return;
    const data = source.toObject();
    delete data._id;
    foundry.utils.mergeObject(data, { "system.equipped" : true, "system.quantity" : 1, [`flags.${module.id}.pactWeapon`] : { conjured : true } });
    const [weapon] = await actor.createEmbeddedDocuments("Item", [data]);
    /* The invocation's enchantment on it (as dnd5e's card would put it) */
    const profile = activity.effects?.[0]?._id;
    const enchantment = profile ? activity.item.effects.get(profile) : activity.item.effects.find(e => e.type === "enchantment");
    if(enchantment){
      const effect = foundry.utils.mergeObject(enchantment.toObject(), { origin : activity.uuid, disabled : false, "flags.dnd5e.enchantmentProfile" : profile ?? enchantment.id }, { inplace : false });
      delete effect._id;
      await weapon.createEmbeddedDocuments("ActiveEffect", [effect]);
    }
    /* In your hand (Hands : a free one, else the main hand) */
    if(hands.manages(actor)) await hands.put(actor, actor.items.get(weapon.id) ?? weapon, hands.freeHand(actor, weapon) ?? "main");
    await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }),
      content : `<p>${esc(module.format("classes.warlock.conjured", { name : actor.name, weapon : source.name }))}</p>` });
    log.debug("Pact weapon conjured", actor.name, weapon.name);
    return true;
  }

  /* ========== Pact of the Chain ========== */

  static chainFix(item){
    if(!this.enabled() || this.is2014(item)) return null;
    const source = item._source?.system?.activities ?? {};
    const update = {};
    if(idOf(item) === this.CHAIN){
      for(const a of Object.values(source)) if((a.type === "summon") && (a.consumption?.spellSlot !== false)) update[`system.activities.${a._id}.consumption.spellSlot`] = false;
    }
    /* Its Find Familiar (Plutonium's comes as a ritual) : a Magic action, no slot */
    else if((item.type === "spell") && (idOf(item) === "find-familiar") && (item._source?.system?.method === "ritual") && item.parent?.items?.some?.(i => idOf(i) === this.CHAIN)){
      update["system.method"] = "atwill";
      for(const a of Object.values(source)) update[`system.activities.${a._id}.activation`] = { type : "action", value : null, override : true };
    }
    return Object.keys(update).length ? { update } : null;
  }

  /* ========== Pact of the Tome ========== */

  static tomeOf(actor){
    return actor?.items?.find?.(i => idOf(i) === this.TOME) ?? null;
  }

  static bookOf(actor){
    return actor?.items?.find?.(i => i.getFlag(module.id, "bookOfShadows") === true) ?? null;
  }

  static spellsIn(actor, book = this.bookOf(actor)){
    return book ? actor.items.filter(i => (i.type === "spell") && (i.getFlag(module.id, "inBook") === book.id)) : [];
  }

  static isRitual(spell){
    const props = spell?.system?.properties;
    return Array.isArray(props) ? props.includes("ritual") : !!props?.has?.("ritual");
  }

  /* The book's empty places : cantrips, rituals */
  static room(actor){
    const spells = this.spellsIn(actor);
    return { cantrips : this.BOOK.cantrips - spells.filter(s => Number(s.system.level) === 0).length,
      rituals : this.BOOK.rituals - spells.filter(s => Number(s.system.level) === 1).length };
  }

  static #tomeAdded = new Map();

  static async onItemAdded(item){
    const actor = item?.parent;
    if(!this.enabled() || (actor?.documentName !== "Actor")) return;
    if(idOf(item) === this.TOME){
      this.#tomeAdded.set(actor.uuid, Date.now());
      await this.makeBook(actor);
      return;
    }
    /* A spell arriving with the invocation (Plutonium adds the chosen ones right after it) : into the book */
    const at = this.#tomeAdded.get(actor.uuid);
    if((item.type !== "spell") || !at || ((Date.now() - at) > 15000) || item.getFlag(module.id, "inBook")) return;
    const book = this.bookOf(actor);
    const room = this.room(actor);
    const level = Number(item.system.level);
    if(!book || !(((level === 0) && (room.cantrips > 0)) || ((level === 1) && (room.rituals > 0) && this.isRitual(item)))) return;
    await item.setFlag(module.id, "inBook", book.id);
  }

  static async onItemRemoved(item){
    const actor = item?.parent;
    if(!this.enabled() || (actor?.documentName !== "Actor")) return;
    /* The book gone : its spells go */
    if(item.getFlag(module.id, "bookOfShadows") === true){
      const spells = actor.items.filter(i => i.getFlag(module.id, "inBook") === item.id).map(i => i.id);
      if(spells.length) await actor.deleteEmbeddedDocuments("Item", spells);
    }
    /* The invocation gone : the book goes */
    else if(idOf(item) === this.TOME){
      const book = this.bookOf(actor);
      if(book) await book.delete();
    }
  }

  static async makeBook(actor){
    if(this.bookOf(actor)) return this.bookOf(actor);
    const [book] = await actor.createEmbeddedDocuments("Item", [{
      name : module.i18n("classes.warlock.book"), type : "loot", img : "icons/sundries/books/book-black-grey.webp",
      system : { description : { value : `<p>${esc(module.i18n("classes.warlock.bookText"))}</p>` }, quantity : 1 },
      flags : { [module.id] : { bookOfShadows : true } },
    }]);
    return book;
  }

  static bookSummary(actor){
    const book = this.bookOf(actor);
    if(!book) return module.i18n("classes.warlock.noBook");
    return module.format("classes.warlock.bookSummary", { spells : this.spellsIn(actor, book).map(s => s.name).join(", ") || "—",
      swaps : Number(actor.getFlag(module.id, "bookSwaps")) || 0 });
  }

  /* The pool : cantrips or level 1 Rituals from any class (2024), not already the Warlock's */
  static async pool(actor, level){
    const have = new Set(actor.items.filter(i => i.type === "spell").map(i => idOf(i) || i.name));
    const ritual = e => { const p = e.system?.properties; return Array.isArray(p) ? p.includes("ritual") : !!p?.ritual; };
    return compendiums.search(e => (e.type === "spell") && (Number(e.system?.level) === level) && ((level === 0) || ritual(e)) && !have.has(e.system?.identifier || e.name),
      { fields : ["system.level", "system.properties"], notice : module.i18n("classes.warlock.lookingSpells") });
  }

  static async addToBook(actor, uuid, book){
    const source = await fromUuid(uuid);
    if(!source) return null;
    const data = source.toObject();
    delete data._id;
    foundry.utils.mergeObject(data, { "system.method" : "pact", "system.prepared" : 2, "system.sourceItem" : "class:warlock", [`flags.${module.id}.inBook`] : book.id });
    const [spell] = await actor.createEmbeddedDocuments("Item", [data]);
    return spell;
  }

  /**
   * The Book of Shadows row : a new book when it's gone, its empty places filled (free), one spell replaced per
   * Warlock level gained, the GM's changes counted too (past that, Rule Limits Off / Warn ask and tell the GM).
   */
  static async openBook(actor){
    const book = this.bookOf(actor) ?? await this.makeBook(actor);
    let room = this.room(actor);
    for(const [kind, level] of [["cantrips", 0], ["rituals", 1]]){
      while(room[kind] > 0){
        const options = await this.pool(actor, level);
        const chosen = await chooseOne(options.map(o => ({ value : o.uuid, label : o.name, img : o.img })), { title : book.name, icon : "fa-solid fa-book",
          columns : 4, prompt : module.format(level ? "classes.warlock.pickRitual" : "classes.warlock.pickCantrip", { n : room[kind] }) });
        if(!chosen) return;
        await this.addToBook(actor, chosen, book);
        room = this.room(actor);
      }
    }
    /* Full : replace one (a level gained) */
    const spells = this.spellsIn(actor, book);
    if(!spells.length) return;
    const swaps = Number(actor.getFlag(module.id, "bookSwaps")) || 0;
    let past = false;
    if(!(swaps > 0)){
      /* The GM may still go past, after the same question */
      if(!limits.canGoPast() && !game.user.isGM) return ui.notifications.info(module.format("classes.warlock.bookFull", { name : actor.name }));
      past = await foundry.applications.api.DialogV2.confirm({ window : { title : book.name },
        content : `<p>${esc(module.format("classes.warlock.bookPast", { name : actor.name }))}</p>`, rejectClose : false });
      if(!past) return;
    }
    const out = await chooseOne(spells.map(s => ({ value : s.id, label : s.name, img : s.img })), { title : book.name, icon : "fa-solid fa-book", columns : 3,
      prompt : module.i18n("classes.warlock.bookOut") });
    const old = out ? actor.items.get(out) : null;
    if(!old) return;
    const level = Number(old.system.level);
    const options = await this.pool(actor, level);
    const chosen = await chooseOne(options.map(o => ({ value : o.uuid, label : o.name, img : o.img })), { title : book.name, icon : "fa-solid fa-book", columns : 4,
      prompt : module.format("classes.warlock.bookIn", { name : old.name }) });
    if(!chosen) return;
    await old.delete();
    const added = await this.addToBook(actor, chosen, book);
    await actor.setFlag(module.id, "bookSwaps", Math.max(0, swaps - 1));
    if(past && !game.user.isGM) await limits.tellGM({ who : actor.name, what : module.format("classes.warlock.bookSwapped", { from : old.name, to : added?.name ?? "" }), rule : module.i18n("classes.warlock.bookRule") });
  }
}
