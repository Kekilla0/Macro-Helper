import { module } from '../module.js';
import { logger } from '../log.js';
const log = logger.for(import.meta.url);

/**
 * Why an attack roll has advantage or disadvantage. Every rule that gives one notes it on the roll
 * (roll.options[module.id].reasons); once rolled, the console (F12) shows one line per attack :
 *   Macro Helper | reasons.js | Goblin, Scimitar → Downed : Advantage : target Prone, within 5 ft · Disadvantage : Heavy weapon : they cancel out
 */

/**
 * Give a roll advantage or disadvantage, and say why.
 * @param {object} roll      a dnd5e roll config (config.rolls[0]) : its options carry it into the roll
 * @param {"advantage"|"disadvantage"} mode
 * @param {string} reason    shown in the log
 */
export function giveMode(roll, mode, reason){
  roll.options ??= {};
  roll.options[mode] = true;
  noteReason(roll, mode, reason);
}

/* Only note why (the advantage / disadvantage itself is set elsewhere : the roll config, keys...) */
export function noteReason(roll, mode, reason){
  roll.options ??= {};
  const mine = roll.options[module.id] = { ...(roll.options[module.id] ?? {}) };
  if((mine.reasons ?? []).some(r => (r.mode === mode) && (r.reason === reason))) return;
  mine.reasons = [...(mine.reasons ?? []), { mode, reason }];
  log.debug(mode === "advantage" ? "Advantage" : "Disadvantage", reason);
}

/* A condition's name : "Prone" */
export function conditionName(id){
  const label = CONFIG.DND5E?.conditionTypes?.[id]?.name ?? CONFIG.statusEffects?.find(e => e.id === id)?.name ?? id;
  return game.i18n.localize(label);
}

/**
 * The reasons as one line, null when it was a straight roll for no noted reason.
 * @param {D20Roll} roll
 * @returns {{ text : string }|null}
 */
export function modeNote(roll){
  if(!roll) return null;
  const reasons = roll.options?.[module.id]?.reasons ?? [];
  const final = Number(roll.options?.advantageMode ?? 0);
  if(!reasons.length && !final) return null;
  const list = mode => reasons.filter(r => r.mode === mode).map(r => r.reason);
  const adv = list("advantage"), dis = list("disadvantage");
  /* Something we don't know about (a dnd5e effect, a macro) */
  if((final > 0) && !adv.length) adv.push(module.i18n("reasons.other"));
  if((final < 0) && !dis.length) dis.push(module.i18n("reasons.other"));
  const parts = [];
  if(adv.length) parts.push(`${game.i18n.localize("DND5E.Advantage")} : ${adv.join(", ")}`);
  if(dis.length) parts.push(`${game.i18n.localize("DND5E.Disadvantage")} : ${dis.join(", ")}`);
  let text = parts.join(" · ");
  if(adv.length && dis.length && !final) text += ` : ${module.i18n("reasons.cancel")}`;
  return { text };
}

/**
 * Log why an attack had advantage / disadvantage (always on : one line per attack that had either).
 * @param {Activity} activity
 * @param {D20Roll} roll
 */
export function logReasons(activity, roll){
  const note = modeNote(roll);
  if(!note) return;
  const uuid = roll.options?.[module.id]?.target;
  const target = uuid ? fromUuidSync(uuid, { strict : false })?.name : (game.user.targets?.first?.()?.name ?? null);
  const who = `${activity?.actor?.name ?? "?"}, ${activity?.item?.name ?? "?"}${target ? ` → ${target}` : ""}`;
  log.info(`${who} : ${note.text}`);
}
