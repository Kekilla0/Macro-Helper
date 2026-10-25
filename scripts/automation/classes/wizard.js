import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { idOf, esc } from '../../helpers/utils.js';
import { recoverSpellSlots, payCoins } from '../../helpers/actors.js';
import { uses } from '../../uses.js';
import { restChoices } from '../rest-choices.js';
import { itemFixes } from '../item-fixes.js';
import { spellPools } from '../spell-pools.js';
import { preparedSpells } from '../prepared-spells.js';
import { compendiums } from '../compendiums.js';
const log = logger.for(import.meta.url);

/**
 * Wizard, levels 1-2 (Classes setting). Changing the
 * prepared spells after a Long Rest is Prepared Spells; Ritual Adept and Scholar are the items' own data. Works from
 * item identifiers, whoever made them.
 *
 *   Arcane Recovery : after a Short Rest (a Rest Choices row, so the rest window offers it), or using it from the
 *                     sheet : spell slots back adding up to half the Wizard level (rounded up), none above 5th; its use
 *                     is spent once something is recovered (once a Long Rest : Plutonium's use comes back on a Short
 *                     Rest, changed by an item fix).
 *   Spellbook       : the Wizard's level 1+ spells (the spell pool lego) : 6 free places at Wizard level 1, 2 more each
 *                     level after, for Wizard spells of a level it has slots for; a Savant (level 3) adds 2 of its
 *                     school, and 1 more each new spell level. Filled from the Item compendiums by a Rest Choices row
 *                     on a Wizard level and by Prepared Spells' Add a Spell. Past them : a spell scroll on the sheet
 *                     (a Wizard spell, a level it can cast, not in the book) copied for 50 GP and 2 hours a spell
 *                     level, the scroll used up.
 */
export class wizard{
  static RECOVERY = "arcane-recovery";
  static BOOK = "wizardSpellbook";
  static SAVANTS = { abjuration : "abj", conjuration : "con", divination : "div", enchantment : "enc", evocation : "evo", illusion : "ill", necromancy : "nec", transmutation : "trs" };

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    itemFixes.add({ name : "Arcane Recovery", where : "owned", plan : item => this.recoveryFix(item) });
    restChoices.add({
      id : "arcaneRecovery", label : "restChoices.arcaneRecovery", rest : "short",
      applies : actor => this.enabled() && !!this.usable(actor),
      summary : actor => module.format("classes.wizard.recoverySummary", { levels : this.levelsOf(actor) }),
      open : actor => this.recover(actor),
    });
    /* Used from the sheet : the same window (its own activity only spends the use) */
    uses.onItem("arcaneRecovery", (item, ctx, next) => {
      if(!this.enabled() || (idOf(item) !== this.RECOVERY) || !item.actor) return next();
      return this.recover(item.actor);
    });
    /* The spellbook */
    spellPools.add(this.BOOK, {
      title : actor => module.format("classes.wizard.spellbook", { name : actor.name }),
      places : actor => this.bookPlaces(actor),
      members : actor => preparedSpells.spellsOf(actor, "wizard").filter(s => !preparedSpells.always(s) && !s.getFlag("dnd5e", "cachedFor")),
      data : () => ({ "system.sourceItem" : "class:wizard", "system.method" : "spell", "system.prepared" : 0 }),
      extra : actor => this.scrolls(actor), extraLabel : "classes.wizard.copyScroll",
      full : actor => module.format("classes.wizard.bookFull", { name : actor.name }),
    });
    restChoices.add({
      id : "wizardSpellbook", label : "restChoices.spellbook", rest : "level", classes : ["wizard"],
      applies : actor => this.enabled() && !!actor?.classes?.wizard,
      summary : actor => module.format("classes.wizard.bookSummary", { count : spellPools.countText(actor, this.BOOK) }),
      open : actor => spellPools.open(actor, this.BOOK),
    });
    preparedSpells.addVia("wizard", actor => spellPools.open(actor, this.BOOK));
  }

  /* ---------- Spellbook ---------- */

  /* The school of its Savant feature (Abjuration Savant...), if any */
  static savantSchool(actor){
    const savant = actor?.items?.find?.(i => idOf(i).endsWith("-savant") && this.SAVANTS[idOf(i).slice(0, -7)]);
    return savant ? this.SAVANTS[idOf(savant).slice(0, -7)] : null;
  }

  /* Wizard spells of a level it has slots for */
  static fitsBook(actor){
    const top = preparedSpells.maxLevel(actor, "wizard");
    const list = dnd5e.registry?.spellLists?.forType?.("class", "wizard")?.identifiers;
    return e => (Number(e.system?.level) >= 1) && (Number(e.system?.level) <= top) && (!list?.size || list.has(e.system?.identifier));
  }

  /* Its free places : a Savant's school ones first, then 6 + 2 a level after the first */
  static bookPlaces(actor){
    const levels = Number(actor?.classes?.wizard?.system?.levels) || 0;
    if(!levels) return [];
    const fits = this.fitsBook(actor);
    const places = [];
    const school = this.savantSchool(actor);
    if(school) places.push({ key : "savant", count : 2 + Math.max(0, preparedSpells.maxLevel(actor, "wizard") - 2), prompt : "classes.wizard.pickSavant",
      filter : e => fits(e) && (e.system?.school === school) });
    places.push({ key : "book", count : 6 + (2 * (levels - 1)), prompt : "classes.wizard.pickSpell", filter : fits });
    return places;
  }

  /* The spell on a scroll : dnd5e's compendium scroll casts it by uuid; one made from a spell holds its copy (found
     again by name) */
  static async scrollSpell(scroll){
    const cast = scroll.system?.activities?.find?.(a => (a.type === "cast") && a.spell?.uuid);
    if(cast) return fromUuid(cast.spell.uuid);
    const name = /:\s*(.+)$/.exec(scroll.name)?.[1]?.trim();
    if(!name) return null;
    const [entry] = await compendiums.search(e => (e.type === "spell") && (e.name === name));
    return entry ? fromUuid(entry.uuid) : null;
  }

  /* Past the free places : its spell scrolls to copy */
  static async scrolls(actor){
    const fits = this.fitsBook(actor);
    const have = spellPools.known(actor);
    const out = [];
    for(const scroll of actor.items.filter(i => (i.type === "consumable") && (i.system?.type?.value === "scroll"))){
      const spell = await this.scrollSpell(scroll);
      if((spell?.type !== "spell") || !fits(spell) || have.has(idOf(spell) || spell.name)) continue;
      const level = Number(spell.system.level);
      const cost = { gp : 50 * level, hours : 2 * level };
      out.push({ value : scroll.id, label : spell.name, img : scroll.img, uuid : spell.uuid, detail : module.format("classes.wizard.copyCost", cost),
        take : () => this.copy(actor, scroll, spell, cost) });
    }
    return out;
  }

  /* Copied : paid, the scroll used up */
  static async copy(actor, scroll, spell, { gp, hours }){
    if(!(await payCoins(actor, gp))){
      ui.notifications.warn(module.format("classes.wizard.copyGold", { name : actor.name, gp }));
      return false;
    }
    const quantity = Number(scroll.system.quantity) || 1;
    if(quantity > 1) await scroll.update({ "system.quantity" : quantity - 1 });
    else await scroll.delete();
    await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }),
      content : `<p>${esc(module.format("classes.wizard.copied", { name : actor.name, spell : spell.name, gp, hours }))}</p>` });
    log.debug("Spell copied", actor.name, spell.name, gp);
    return true;
  }

  /* Its use back on a Long Rest only (2024 : once a Long Rest, used after a Short Rest) */
  static recoveryFix(item){
    if(!this.enabled() || (idOf(item) !== this.RECOVERY) || (String(item.system?.source?.rules ?? "") === "2014")) return null;
    const recovery = item._source?.system?.uses?.recovery ?? [];
    if(!recovery.some(r => r?.period === "sr")) return null;
    return { update : { "system.uses.recovery" : [{ period : "lr", type : "recoverAll" }] } };
  }

  /* The feature, while its use is left */
  static usable(actor){
    const item = actor?.items?.find?.(i => idOf(i) === this.RECOVERY);
    if(!item) return null;
    return (!item.system.uses?.max || (Number(item.system.uses.value) > 0)) ? item : null;
  }

  static levelsOf(actor){
    return Math.ceil((Number(actor?.classes?.wizard?.system?.levels) || 1) / 2);
  }

  static async recover(actor){
    const item = this.usable(actor);
    if(!item){
      ui.notifications.warn(module.format("classes.wizard.noRecovery", { name : actor?.name ?? "" }));
      return null;
    }
    const result = await recoverSpellSlots(actor, { levels : this.levelsOf(actor), maxLevel : 5, item });
    log.debug("Arcane Recovery", actor.name, result);
    return result;
  }
}
