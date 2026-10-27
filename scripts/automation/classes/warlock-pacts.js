import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { idOf, originItem, chooseOption, esc } from '../../helpers/utils.js';
import { weaponUses } from '../weapon-uses.js';
import { uses } from '../../uses.js';
import { itemFixes } from '../item-fixes.js';
import { pickFromCompendium } from '../compendiums.js';
import { conjureItem, linkItems } from '../../helpers/items.js';
import { damageTypeChoice } from '../../roll-item/damage-type-choice.js';
import { restChoices } from '../rest-choices.js';
import { spellPools } from '../spell-pools.js';
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
 *                       Rest Choices' Book of Shadows row (the spell pool lego) : empty places filled from the Item compendiums (cantrips and
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
    /* Its attacks : CHA beside the weapon's own abilities (the weapon-uses lego) */
    weaponUses.add("pactOfTheBlade", { applies : item => this.isPactWeapon(item), abilities : () => ["cha"] });
    /* Its damage : its normal type, or Necrotic, Psychic or Radiant (the damage type lego) */
    damageTypeChoice("pactWeapon", { applies : item => this.isPactWeapon(item),
      types : item => [this.ownType(item), ...this.PACT_TYPES], normal : (item, types) => types?.find?.(t => !this.PACT_TYPES.includes(t)) ?? types?.[0] });
    Hooks.on("createActiveEffect", (effect, options, userId) => { if(userId === game.user.id) this.onPactFormed(effect); });
    uses.onActivity("pactWeapon", (activity, ctx, next) => this.forgeStep(activity, ctx, next));
    /* ---------- Chain ---------- */
    itemFixes.add({ name : "Pact of the Chain", where : "owned", plan : item => this.chainFix(item) });
    /* ---------- Tome ---------- */
    Hooks.on("createItem", (item, options, userId) => { if(userId === game.user.id) this.onItemAdded(item); });
    /* Its spells : the spell pool lego (3 cantrips, 2 level 1 Rituals, any class), one replaced per Warlock level */
    spellPools.add("bookOfShadows", {
      title : actor => this.bookOf(actor)?.name ?? module.i18n("classes.warlock.book"),
      places : () => [
        { key : "cantrips", count : this.BOOK.cantrips, prompt : "classes.warlock.pickCantrip", filter : e => Number(e.system?.level) === 0 },
        { key : "rituals", count : this.BOOK.rituals, prompt : "classes.warlock.pickRitual", filter : e => (Number(e.system?.level) === 1) && spellPools.hasProperty(e, "ritual") },
      ],
      members : actor => this.spellsIn(actor),
      data : actor => ({ "system.method" : "pact", "system.prepared" : 2, "system.sourceItem" : "class:warlock", [`flags.${module.id}.inBook`] : this.bookOf(actor)?.id }),
      added : (actor, spell) => linkItems(this.bookOf(actor), [spell]),
      full : actor => module.format("classes.warlock.bookFull", { name : actor.name }),
    });
    restChoices.add({
      id : "bookOfShadows", label : "restChoices.bookOfShadows", rest : "level", classes : ["warlock"], count : (actor, { levels }) => levels || 1,
      applies : actor => this.enabled() && !!this.tomeOf(actor),
      summary : actor => this.bookSummary(actor),
      state : actor => this.spellsIn(actor).map(s => s.name),
      open : (actor, swap) => this.openBook(actor, swap),
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

  /* The weapon's own damage type (not one of the pact's) */
  static ownType(item){
    return [...(item?.system?.damage?.base?.types ?? [])].find(t => !this.PACT_TYPES.includes(t)) ?? null;
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
    const source = await pickFromCompendium(e => (e.type === "weapon") && ["simpleM", "martialM"].includes(e.system?.type?.value) && !magical(e)
      && (!standard.size || standard.has(e.system?.identifier) || standard.has(e.system?.type?.baseItem)),
      { fields : ["system.type", "system.rarity", "system.properties"], notice : module.i18n("classes.warlock.looking"), empty : module.i18n("classes.warlock.noWeapons"),
        detail : w => game.i18n.localize(CONFIG.DND5E.weaponTypes?.[w.system?.type?.value] ?? ""),
        title : activity.item.name, icon : "fa-solid fa-khanda", columns : 4, prompt : module.i18n("classes.warlock.conjurePrompt") });
    if(!source) return;
    /* In your hands (the conjure lego); one at a time is onPactFormed's (a bonded weapon's pact ends too) */
    const weapon = await conjureItem(actor, source, { data : { flags : { [module.id] : { pactWeapon : { conjured : true } } } } });
    if(!weapon) return;
    /* The invocation's enchantment on it (as dnd5e's card would put it) */
    const profile = activity.effects?.[0]?._id;
    const enchantment = profile ? activity.item.effects.get(profile) : activity.item.effects.find(e => e.type === "enchantment");
    if(enchantment){
      const effect = foundry.utils.mergeObject(enchantment.toObject(), { origin : activity.uuid, disabled : false, "flags.dnd5e.enchantmentProfile" : profile ?? enchantment.id }, { inplace : false });
      delete effect._id;
      await weapon.createEmbeddedDocuments("ActiveEffect", [effect]);
    }
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

  /* The book's empty places : cantrips, rituals */
  static room(actor){
    return spellPools.room(actor, "bookOfShadows");
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
    if(!book || !(((level === 0) && (room.cantrips > 0)) || ((level === 1) && (room.rituals > 0) && spellPools.hasProperty(item, "ritual")))) return;
    await item.setFlag(module.id, "inBook", book.id);
    await linkItems(book, [item]);
  }

  static async makeBook(actor){
    if(this.bookOf(actor)) return this.bookOf(actor);
    const [book] = await actor.createEmbeddedDocuments("Item", [{
      name : module.i18n("classes.warlock.book"), type : "loot", img : "icons/sundries/books/book-black-grey.webp",
      system : { description : { value : `<p>${esc(module.i18n("classes.warlock.bookText"))}</p>` }, quantity : 1 },
      flags : { [module.id] : { bookOfShadows : true } },
    }]);
    /* It goes with the invocation, and its spells with it (linkItems) */
    const tome = this.tomeOf(actor);
    if(tome && book) await linkItems(tome, [book]);
    return book;
  }

  static bookSummary(actor){
    const book = this.bookOf(actor);
    if(!book) return module.i18n("classes.warlock.noBook");
    return module.format("classes.warlock.bookSummary", { spells : this.spellsIn(actor, book).map(s => s.name).join(", ") || "—",
      swaps : restChoices.swapsText(actor, "bookOfShadows") });
  }

  /* The Book of Shadows row : a new book when it's gone, then the spell pool (empty places filled free; full, one
     spell replaced per Warlock level gained, past that Rule Limits; the GM freely) */
  static async openBook(actor, swap){
    await this.makeBook(actor);
    return spellPools.open(actor, "bookOfShadows", swap);
  }
}
