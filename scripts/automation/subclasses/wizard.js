import { module } from '../../module.js';
import { logger } from '../../log.js';
import { gm } from '../../gm.js';
import { idOf, esc, ownerIds } from '../../helpers/utils.js';
import { usedThisTurn, markUsedThisTurn } from '../../helpers/actors.js';
import { tokenOf, canSee, registerPool } from '../../helpers/tokens.js';
import { TYPES } from '../../roll-item/message.js';
import { itemFixes } from '../item-fixes.js';
import { casting } from '../casting.js';
import { subclasses } from './common.js';
import { addRange } from '../ranges.js';
const log = logger.for(import.meta.url);

/**
 * Wizard subclasses, level 3 (Subclasses setting). The Savants' free spells are the spellbook's.
 *
 *   Abjurer     Arcane Ward       its Hit Points are the item's uses. An Abjuration spell cast with a slot : the ward
 *                                 made (full) the first time after a Long Rest, else 2 × the slot's level back. Damage the
 *                                 Wizard takes (after its Resistances) goes to the ward first; what's left reaches it.
 *                                 Until it's made (Create Ward used since the Long Rest) it has no Hit Points. A blue
 *                                 bar on the token shows them (a pool bar).
 *                                 Its Expend Spell Slot activity is the item's data.
 *   Diviner     Portent           each Long Rest : two d20s rolled and kept (its owner is told). A D20 Test by it or a
 *                                 creature it sees (an attack card, a save, a check) : a Portent button per roll left
 *                                 makes the d20 show it (after the roll, not before), once a turn.
 *   Evoker      Potent Cantrip    its cantrips' saves do half damage on a success (the cantrips' data, set as they're
 *                                 added); a missed cantrip attack : Potent Cantrip on the card, half the damage.
 *   Illusionist Improved Illusions Illusion spells : no Verbal component, and +60 ft range when it's 10 ft or more.
 */
export class wizardSchools{
  static WARD = "arcane-ward";
  static PORTENT = "portent";
  static POTENT = "potent-cantrip";
  static IMPROVED = "improved-illusions";

  static enabled(){
    return subclasses.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.postUseActivity", (activity, usage) => this.afterSpell(activity, usage));
    Hooks.on("dnd5e.calculateDamage", (actor, damages, options) => this.ward(actor, damages, options));
    gm.handle("arcaneWard", data => this.wardAsGM(data));
    registerPool(this.WARD, { color : "#3b82f6", read : actor => this.enabled() ? this.wardPool(actor) : null });
    /* Portent */
    Hooks.on("dnd5e.restCompleted", (actor, result) => { if(result?.longRest) this.foretell(actor); });
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => { this.portentButtons(message, buttons, ray ?? null); this.potentButton(message, buttons, ray ?? null); });
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => this.cardClicked(message, String(id), ray ?? null));
    Hooks.on(`${module.id}.rerollButtons`, (message, buttons) => this.portentTestButtons(message, buttons));
    /* Potent Cantrip */
    itemFixes.add({ name : "Potent Cantrip", where : "owned", plan : item => this.potentFix(item) });
    Hooks.on("createItem", (item, options, userId) => { if((userId === game.user.id) && (idOf(item) === this.POTENT)) this.potentAll(item.actor); });
    /* Improved Illusions */
    Hooks.on(`${module.id}.components`, (activity, need) => { if(this.illusionist(activity?.item)) need.v = false; });
    addRange(this.IMPROVED, 60, { enabled : () => this.enabled(), when : ({ item }) => this.illusionist(item) && ((item.system.range?.units ?? "ft") === "ft") && (Number(item.system.range?.value) >= 10) });
  }

  /* The slot a spell was cast with */
  static slotLevel(activity, usage = {}){
    const slot = usage?.spell?.slot;
    const level = Number(activity.actor?.system?.spells?.[slot]?.level);
    if(level > 0) return level;
    return (Number(activity.item?.system?.level) || 0) + (Number(activity.item?.getFlag?.("dnd5e", "scaling") ?? usage?.scaling) || 0);
  }

  /* ---------- Abjurer ---------- */

  static async afterSpell(activity, usage){
    const actor = activity?.actor;
    if(!this.enabled() || !actor?.isOwner || (activity.item?.type !== "spell") || (activity.item.system.school !== "abj") || !casting.spendsSlot(activity, usage ?? {})) return;
    const item = subclasses.has(actor, this.WARD);
    if(!item) return;
    const create = [...(item.system.activities ?? [])].find(a => a.uses?.max);
    const spent = Number(item.system.uses?.spent) || 0;
    /* Not made since the Long Rest : made now, full */
    if(create && (Number(create.uses.value) > 0)){
      await create.update({ "uses.spent" : (Number(create.uses.spent) || 0) + 1 });
      await item.update({ "system.uses.spent" : 0 });
      return ui.notifications.info(module.format("subclasses.wizard.wardMade", { name : actor.name, hp : item.system.uses.max }));
    }
    if(create && !spent) return;
    const back = 2 * this.slotLevel(activity, usage);
    await item.update({ "system.uses.spent" : Math.max(0, spent - back) });
    log.debug("Arcane Ward", actor.name, `+${back}`);
  }

  /* The ward's Hit Points : none until Create Ward has been used since the Long Rest */
  static wardPool(actor){
    const item = subclasses.has(actor, this.WARD);
    if(!item?.system?.uses?.max) return null;
    const create = [...(item.system.activities ?? [])].find(a => a.uses?.max);
    const made = !create || ((Number(create.uses.spent) || 0) > 0);
    return { value : made ? (Number(item.system.uses.value) || 0) : 0, max : Number(item.system.uses.max) || 0 };
  }

  /* Damage really applied : the ward takes it first */
  static ward(actor, damages, options = {}){
    if(!this.enabled() || !options?.[module.id]?.applying || !(damages?.amount > 0)) return;
    const item = subclasses.has(actor, this.WARD);
    const hp = this.wardPool(actor)?.value ?? 0;
    if(!item || (hp <= 0)) return;
    const taken = Math.min(hp, damages.amount);
    damages.amount -= taken;
    if(item.isOwner) item.update({ "system.uses.spent" : (Number(item.system.uses.spent) || 0) + taken });
    else gm.run("arcaneWard", { item : item.uuid, taken });
    ui.notifications.info(module.format("subclasses.wizard.wardTook", { name : actor.name, taken, left : hp - taken }));
  }

  static async wardAsGM({ item : uuid, taken } = {}){
    const item = fromUuidSync(uuid ?? "", { strict : false });
    if((idOf(item) !== this.WARD) || !(Number(taken) > 0)) return false;
    await item.update({ "system.uses.spent" : Math.min(Number(item.system.uses.max) || 0, (Number(item.system.uses.spent) || 0) + Number(taken)) });
    return true;
  }

  /* ---------- Diviner : Portent ---------- */

  static rollsOf(actor){
    return [...(subclasses.has(actor, this.PORTENT)?.getFlag(module.id, "portent") ?? [])];
  }

  static async foretell(actor){
    const item = subclasses.has(actor, this.PORTENT);
    if(!this.enabled() || !item || !actor.isOwner) return;
    const roll = await new Roll("2d20").evaluate();
    const values = roll.dice[0].results.map(r => r.result);
    await item.setFlag(module.id, "portent", values);
    await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }), rolls : [roll],
      whisper : [...new Set([...ownerIds(actor), ...game.users.filter(u => u.isGM).map(u => u.id)])],
      content : `<p>${esc(module.format("subclasses.wizard.foretold", { name : actor.name, values : values.join(", ") }))}</p>` });
  }

  /* This user's Diviners that can replace that creature's d20 now */
  static diviners(creature){
    if(!this.enabled() || !creature) return [];
    return (canvas.tokens?.placeables ?? []).filter(t => t.actor?.isOwner && this.rollsOf(t.actor).length && !usedThisTurn(t.actor, "portent")
      && ((t === creature) || canSee(t, creature)));
  }

  static portentButtons(message, buttons, ray){
    if((message.type !== TYPES.attack) || !message.system?.attackOf?.(ray)) return;
    const creature = tokenOf(message.getAssociatedToken?.() ?? message.getAssociatedActor?.());
    for(const t of this.diviners(creature)){
      for(const [i, value] of this.rollsOf(t.actor).entries()){
        buttons.push({ id : `portent|${t.document.uuid}|${i}`, icon : "fa-eye", label : module.format("subclasses.wizard.portent", { value }) });
      }
    }
  }

  static portentTestButtons(message, buttons){
    if(!["save", "check"].includes(message?.type)) return;
    const creature = tokenOf(message.getAssociatedToken?.() ?? message.getAssociatedActor?.());
    for(const t of this.diviners(creature)){
      for(const [i, value] of this.rollsOf(t.actor).entries()){
        buttons.push({ id : `portent-${t.id}-${i}`, icon : "fa-eye", label : module.format("subclasses.wizard.portent", { value }),
          run : () => this.usePortent(message, null, t, i) });
      }
    }
  }

  static async usePortent(message, ray, token, index){
    const values = this.rollsOf(token.actor);
    const value = values[index];
    if(!Number.isFinite(value) || usedThisTurn(token.actor, "portent")) return;
    values.splice(index, 1);
    await subclasses.has(token.actor, this.PORTENT).setFlag(module.id, "portent", values);
    await markUsedThisTurn(token.actor, "portent");
    await subclasses.changeRoll(message, { ray, value }, token.actor);
  }

  /* ---------- Evoker : Potent Cantrip ---------- */

  /* A cantrip's save that does damage : half on a success */
  static potentFix(item){
    if(!this.enabled() || (item?.type !== "spell") || (Number(item.system.level) !== 0) || !subclasses.has(item.actor, this.POTENT)) return null;
    const update = {};
    for(const a of item.system.activities ?? []){
      if((a.type === "save") && a.damage?.parts?.length && (a.damage.onSave === "none")) update[`system.activities.${a.id}.damage.onSave`] = "half";
    }
    return Object.keys(update).length ? { update } : null;
  }

  /* Potent Cantrip gained : the cantrips already known too */
  static async potentAll(actor){
    for(const spell of actor?.items?.filter?.(i => (i.type === "spell") && (Number(i.system.level) === 0)) ?? []){
      const plan = this.potentFix(spell);
      if(plan) await spell.update(plan.update);
    }
  }

  /* A missed cantrip attack : half its damage */
  static potentButton(message, buttons, ray){
    if(!this.enabled() || (message.type !== TYPES.attack) || !message.system?.attackOf?.(ray) || message.system.isHitOn?.(ray)) return;
    const actor = message.getAssociatedActor?.();
    const item = message.getAssociatedItem?.();
    if(!actor?.isOwner || (item?.type !== "spell") || (Number(item.system.level) !== 0) || !subclasses.has(actor, this.POTENT)) return;
    if(message.system.extraRolls?.(ray, this.POTENT)?.length) return;
    buttons.push({ id : "potentCantrip", icon : "fa-burst", label : subclasses.has(actor, this.POTENT).name });
  }

  static async cardClicked(message, id, ray){
    if(id === "potentCantrip"){
      const rolls = (Number.isInteger(ray) ? message.system.rayDamage?.(ray) : message.system.damageRolls) ?? [];
      const half = Math.floor(rolls.reduce((sum, r) => sum + (Number(r.total) || 0), 0) / 2);
      if(half > 0) await message.system.extraDamage(String(half), { key : this.POTENT, type : rolls[0]?.options?.type ?? null, ray, onHit : false,
        label : subclasses.has(message.getAssociatedActor?.(), this.POTENT)?.name ?? "Potent Cantrip" });
      return;
    }
    if(!id.startsWith("portent|")) return;
    const [, uuid, index] = id.split("|");
    const token = tokenOf(fromUuidSync(uuid ?? "", { strict : false }));
    if(token?.actor?.isOwner) await this.usePortent(message, ray, token, Number(index));
  }

  /* ---------- Illusionist ---------- */

  static illusionist(item){
    return this.enabled() && (item?.type === "spell") && (item.system?.school === "ill") && !!subclasses.has(item.actor, this.IMPROVED);
  }
}
