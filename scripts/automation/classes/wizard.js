import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { idOf } from '../../helpers/utils.js';
import { recoverSpellSlots } from '../../helpers/actors.js';
import { uses } from '../../uses.js';
import { restChoices } from '../rest-choices.js';
import { itemFixes } from '../item-fixes.js';
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
 */
export class wizard{
  static RECOVERY = "arcane-recovery";

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
