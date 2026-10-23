import { module } from '../module.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { distanceBetween } from '../helpers/tokens.js';
const log = logger.for(import.meta.url);

/**
 * The card-save lego : a save activity's save put on an attack card that's already out, as its on-hit save (a smite
 * spell's Frightened or Prone, Hail of Thorns' burst; a monster's "if it hits, the target must make a DC 13 CON save").
 * The card's rows then roll it and its effects follow, as an item's own on-hit save does. One save a card : a card that
 * has one already keeps it (false).
 *
 *   await MacroHelper.cardSave(card, spell);                                     the creatures the attack hit
 *   await MacroHelper.cardSave(card, spell, { around : { target, feet : 5 }, level : 2 });   it and everyone within 5 ft,
 *                                                                                its damage rolled at that level, the
 *                                                                                burst shown on the map
 * @param {ChatMessage} message   the attack card
 * @param {Activity|Item} save    the save activity (an item : its first)
 * @param {object} [options]
 * @param {Token[]} [options.targets]   who saves (default : the creatures hit)
 * @param {object} [options.around]     { target, feet } : that creature and everyone within `feet` of it
 * @param {boolean} [options.damage]    its damage rolled onto the card (default : with targets or around)
 * @param {number} [options.level]      the spell's slot level, for that damage
 * @returns {Promise<boolean>}
 */
export async function cardSave(message, save, { targets = null, around = null, damage = null, level = null } = {}){
  if(save?.documentName === "Item") save = save.system.activities?.find?.(a => a.type === "save");
  if(!message?.system || !save || (save.type !== "save") || message.system.rider?.id) return false;
  const spell = save.item;
  let uuids = targets ? targets.map(t => (t.document ?? t).uuid) : null;
  const center = around?.target?.object ?? around?.target ?? null;
  const scene = center?.document?.parent ?? canvas.scene;
  if(center?.document){
    uuids = scene.tokens.filter(t => t.actor && t.object && ((t === center.document) || (distanceBetween(t.object, center) <= around.feet))).map(t => t.uuid);
  }
  const rolls = [];
  if(damage ?? !!uuids){
    const scaling = Math.max(0, (Number(level) || Number(spell?.system?.level) || 1) - (Number(spell?.system?.level) || 1));
    for(const part of save.damage?.parts ?? []){
      const formula = part.scaledFormula?.(scaling, { rollData : save.getRollData?.() ?? {} }) ?? part.formula;
      if(!formula) continue;
      const type = part.types?.first?.() ?? [...(part.types ?? [])][0] ?? "";
      const roll = await new CONFIG.Dice.DamageRoll(formula, save.getRollData?.() ?? {}, { type, types : [type], properties : (spell?.type === "spell") ? ["mgc"] : [] }).evaluate();
      roll.options[module.id] = { part : "save" };
      rolls.push(roll);
    }
  }
  await message.update({
    "system.rider" : { id : save.id, item : spell?.uuid ?? null, ability : save.save?.ability?.first?.() ?? "",
      dc : Number.isFinite(save.save?.dc?.value) ? save.save.dc.value : null, onSave : rolls.length ? (save.damage?.onSave ?? null) : null,
      ...(uuids ? { targets : uuids } : {}) },
    ...(rolls.length ? { rolls : [...message.rolls, ...rolls].map(r => JSON.stringify(r)) } : {}),
  });
  if(center?.document){
    const radius = (around.feet / scene.grid.distance) * scene.grid.size + (Math.max(center.w, center.h) / 2);
    gm.run("areaRegion", { scene : scene.id, name : spell?.name ?? save.name, color : game.user.color?.css ?? "#ffd700",
      x : center.center.x, y : center.center.y, radius, activity : save.uuid, origin : (message.getAssociatedToken?.() ?? center.document).uuid }).catch(error => log.debug(error));
  }
  return true;
}
