import { module } from '../../module.js';
import { logger } from '../../log.js';
import { idOf, chooseOption } from '../../helpers/utils.js';
import { tempHP } from '../../helpers/actors.js';
import { gm } from '../../gm.js';
import { tokenOf, distanceBetween } from '../../helpers/tokens.js';
import { isEnemy } from '../../helpers/targets.js';
import { cardBuilder } from '../../roll-item/card-builder.js';
import { TYPES } from '../../roll-item/message.js';
import { spellEffects } from '../spell-effects.js';
import { subclasses } from './common.js';
const log = logger.for(import.meta.url);

/**
 * Warlock subclasses, level 3 (Subclasses setting). The patron spells are the import's; Healing Light's pool and
 * Awakened Mind are the items' data.
 *
 *   Archfey       Steps of the Fey   after Misty Step (its free casting or a slot) : a card offers Refreshing Step (1d10
 *                                    temporary Hit Points, you or a creature within 10 ft) or Taunting Step (a WIS save
 *                                    for the creatures within 5 ft of the space you left : Disadvantage on attack rolls
 *                                    against anyone but you until the start of your next turn; Spells : effect rules).
 *   Fiend         Dark One's Blessing  an enemy it dropped to 0 HP, or one within 10 ft of it : CHA + Warlock level
 *                                    temporary Hit Points (at least 1).
 *   Great Old One Psychic Spells     a Warlock spell's attack card : Psychic on it turns its damage Psychic; Warlock
 *                                    Enchantment and Illusion spells need no Verbal or Somatic components.
 */
export class warlockPatrons{
  static STEPS = "steps-of-the-fey";
  static BLESSING = "dark-ones-blessing";
  static PSYCHIC = "psychic-spells";

  static enabled(){
    return subclasses.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    spellEffects.RULES[this.STEPS] ??= { onlyAgainstOrigin : "disadvantage" };
    Hooks.on("dnd5e.postUseActivity", activity => this.afterMistyStep(activity));
    subclasses.onOffer("stepsOfTheFey", (actor, data) => this.step(actor, data));
    /* The client that applied the damage : it knows the card (who did it) */
    Hooks.on("dnd5e.applyDamage", (actor, amount, options) => this.onDown(actor, amount, options));
    gm.handle("darkOnesBlessing", data => this.blessingAsGM(data));
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => this.psychicButton(message, buttons, ray ?? null));
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => { if(id === "psychicSpells") message.system.setDamageType?.("psychic", ray ?? null); });
    Hooks.on(`${module.id}.components`, (activity, need) => {
      const item = activity?.item;
      if(this.enabled() && this.isWarlockSpell(item) && ["enc", "ill"].includes(item.system.school) && subclasses.has(activity.actor, this.PSYCHIC)){ need.v = false; need.s = false; }
    });
  }

  static isWarlockSpell(item){
    return (item?.type === "spell") && ((String(item.system?.sourceItem ?? "") === "class:warlock") || (item.system?.classIdentifier === "warlock") || (item.system?.method === "pact"));
  }

  /* ---------- Archfey ---------- */

  /* Misty Step cast : where it stood (the space it leaves), and the choice */
  static async afterMistyStep(activity){
    const actor = activity?.actor;
    if(!this.enabled() || (idOf(activity?.item) !== "misty-step") || !actor?.isOwner || !subclasses.has(actor, this.STEPS)) return;
    const me = tokenOf(actor);
    if(!me) return;
    await subclasses.offer(actor, { key : "stepsOfTheFey", label : subclasses.has(actor, this.STEPS).name,
      data : { x : me.document.x, y : me.document.y, w : me.document.width, h : me.document.height },
      text : module.format("subclasses.warlock.stepsText", { name : actor.name }) });
  }

  static async step(actor, space){
    const item = subclasses.has(actor, this.STEPS);
    const me = tokenOf(actor);
    if(!item || !me) return false;
    const choice = await chooseOption({ title : item.name, icon : "fa-solid fa-wand-sparkles",
      options : ["refreshing", "taunting"].map(value => ({ value, label : module.i18n(`subclasses.warlock.${value}`) })) });
    if(!choice) return false;
    const activities = [...(item.system.activities ?? [])];
    if(choice === "refreshing"){
      const heal = activities.find(a => a.type === "heal");
      return !!(heal && await cardBuilder.roll(item, { activity : heal.id }));
    }
    const save = activities.find(a => a.type === "save");
    const near = this.aroundSpace(space).filter(t => t !== me);
    if(!save || !near.length){ ui.notifications.info(module.i18n("subclasses.warlock.noneNear")); return !!save; }
    return !!await cardBuilder.roll(item, { activity : save.id, targets : near });
  }

  /* The creatures within 5 ft of a space (touching it) */
  static aroundSpace({ x, y, w = 1, h = 1 } = {}){
    const size = canvas.grid.size;
    const a = { x, y, r : x + w * size, b : y + h * size };
    return (canvas.tokens?.placeables ?? []).filter(t => {
      if(!t.actor) return false;
      const d = t.document;
      const bx = { x : d.x, y : d.y, r : d.x + d.width * size, b : d.y + d.height * size };
      const dx = Math.max(0, bx.x - a.r, a.x - bx.r), dy = Math.max(0, bx.y - a.b, a.y - bx.b);
      return (Math.round(dx / size) === 0) && (Math.round(dy / size) === 0);
    });
  }

  /* ---------- Fiend ---------- */

  static async onDown(actor, amount, options = {}){
    if(!this.enabled() || !(amount > 0) || (Number(actor?.system?.attributes?.hp?.value) > 0)) return;
    const downed = tokenOf(actor);
    if(!downed) return;
    const killer = (options.origin ?? options.originatingMessage)?.getAssociatedActor?.() ?? null;
    for(const t of canvas.tokens.placeables){
      const item = subclasses.has(t.actor, this.BLESSING);
      if(!item || (t === downed) || !isEnemy(t, downed)) continue;
      if(!((killer === t.actor) || (distanceBetween(t, downed) <= 10))) continue;
      const temp = Math.max(1, (Number(t.actor.system.abilities?.cha?.mod) || 0) + (Number(t.actor.classes?.warlock?.system?.levels) || 0));
      if(t.actor.isOwner) await tempHP(t.actor, temp, item);
      else await gm.run("darkOnesBlessing", { actor : t.actor.uuid, item : item.uuid });
      log.debug("Dark One's Blessing", t.name, temp);
    }
  }

  /* GM : the Warlock's temporary Hit Points (only its own feature's amount) */
  static async blessingAsGM({ actor : uuid, item : itemUuid } = {}){
    const actor = fromUuidSync(uuid ?? "", { strict : false });
    const item = fromUuidSync(itemUuid ?? "", { strict : false });
    if(!actor || (item?.actor !== actor) || (idOf(item) !== this.BLESSING)) return false;
    const amount = Math.max(1, (Number(actor.system.abilities?.cha?.mod) || 0) + (Number(actor.classes?.warlock?.system?.levels) || 0));
    return tempHP(actor, amount, item);
  }

  /* ---------- Great Old One ---------- */

  static psychicButton(message, buttons, ray){
    if(!this.enabled() || (message.type !== TYPES.attack) || !message.system?.isHitOn?.(ray)) return;
    const actor = message.getAssociatedActor?.();
    const item = message.getAssociatedItem?.();
    if(!actor?.isOwner || !this.isWarlockSpell(item) || !subclasses.has(actor, this.PSYCHIC)) return;
    const rolls = Number.isInteger(ray) ? message.system.rayDamage?.(ray) : message.system.damageRolls;
    if(!rolls?.length || rolls.every(r => r.options?.type === "psychic")) return;
    buttons.push({ id : "psychicSpells", icon : "fa-brain", label : subclasses.has(actor, this.PSYCHIC).name });
  }
}
