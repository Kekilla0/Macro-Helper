import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { idOf } from '../../helpers/utils.js';
import { countedUses } from '../../helpers/actors.js';
import { markSpell, spellOf } from '../marks.js';
const log = logger.for(import.meta.url);

/**
 * Ranger, levels 1-2 (Classes setting). Weapon Mastery is automation/weapon-mastery.js; the Fighting Style is
 * automation/fighting-styles.js (swapped in Rest Choices). Works from item identifiers, whatever made the items (Plutonium,
 * dnd5e's SRD, by hand) : none of Hunter's Mark's own activities are used.
 *
 *   Hunter's Mark  : the mark lego (marks.js). Using the spell (or Favored Enemy) asks how to pay (a Favored Enemy use, free; or a slot), then the
 *                    creature to mark (90 ft). The caster pays and concentrates at once; the chat card asks the GM
 *                    to mark the creature (a button : an effect on it). The mark ends with that Concentration. Every hit on the marked
 *                    creature with an attack roll adds 1d6 Force to the attack card (its own box, doubled on a crit).
 *                    The marked creature at 0 HP : its caster is told; using Hunter's Mark again then moves the mark
 *                    (no slot, no use : a Bonus Action).
 *   Favored Enemy  : its free castings : the item's uses when it has them, else counted here (2 / 3 / 4 / 5 / 6 at
 *                    Ranger levels 1 / 5 / 9 / 13 / 17), back on a Long Rest.
 */
export class ranger{
  static MARK = "hunters-mark";
  static FAVORED = "favored-enemy";
  static RANGE = 90;

  static enabled = settings.on("classRules");

  static register(){
    if(game.system.id !== "dnd5e") return;
    /* Hunter's Mark : the mark lego, Favored Enemy's free castings first */
    markSpell({
      id : "huntersMark", spell : this.MARK, name : "Hunter's Mark", items : [this.FAVORED], enabled : () => this.enabled(), range : this.RANGE, icon : "fa-crosshairs",
      free : { left : actor => this.favoredLeft(actor), spend : actor => this.spendFavored(actor), label : left => module.format("classes.ranger.payFree", { left }) },
      hours : level => this.hoursFor(level),
      effect : (data, spell, caster) => ({ img : spell?.img ?? "icons/svg/target.svg",
        name : module.format("classes.ranger.markName", { spell : spell?.name ?? "Hunter's Mark", name : caster.name }) }),
      damage : attacker => ({ formula : "1d6", type : "force", label : spellOf(this.markRule, attacker)?.name ?? "Hunter's Mark" }),
      text : { marked : "classes.ranger.marked", moved : "classes.ranger.moved", mark : "classes.ranger.markShort", moveHere : "marks.moveHere", done : "classes.ranger.markedShort" },
    });
    this.favored = countedUses("favoredEnemy", { max : actor => this.favoredMax(actor), item : actor => this.favoredItem(actor) });
  }

  /* ---------- Favored Enemy ---------- */

  /* Free castings by Ranger level (2024 table) */
  static favoredMax(actor){
    const level = Number(actor?.classes?.ranger?.system?.levels) || 0;
    return level ? (2 + Math.floor((level - 1) / 4)) : 0;
  }

  static favoredItem(actor){
    return actor?.items?.find?.(i => idOf(i) === this.FAVORED) ?? null;
  }

  /* Free castings left */
  /* Free castings left (the countedUses lego : the item's own uses, else counted on the actor) */
  static favoredLeft(actor){
    return this.favoredItem(actor) ? this.favored.left(actor) : 0;
  }

  static spendFavored(actor){
    return this.favored.spend(actor);
  }

  /* ---------- Hunter's Mark ---------- */

  static markRule = { id : "huntersMark", spell : "hunters-mark" };

  /* 2024 : 1 hour; a level 3-4 slot 8 hours; 5+ 24 hours */
  static hoursFor(level){
    return (level >= 5) ? 24 : (level >= 3) ? 8 : 1;
  }
}
