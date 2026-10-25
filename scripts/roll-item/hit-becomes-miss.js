import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf, originItem } from '../helpers/utils.js';
import { TYPES } from './message.js';
const log = logger.for(import.meta.url);

/**
 * The hit-becomes-miss lego : while a creature has one of the matched effects, each attack that hits it may miss
 * instead (Mirror Image : a duplicate is hit). The active GM rolls for it once per attack and creature, as the card
 * shows the hit (a hit gained later, from a bonus, counts as it's gained), and posts the roll; a turned hit is a miss
 * on the card (its damage, Apply Hits and on-hit parts follow). The GM's Count as hit puts it back.
 *
 *   hitBecomesMiss("mirror-image", {
 *     formula : ({ effects }) => `${effects.length}d6`,           the roll (null / "" : no roll, the hit stands)
 *     turns : ({ roll }) => roll.dice[0].results.some(r => r.result >= 3),   does it turn the hit (no formula : true)
 *     unaffected : ({ attacker, target }) => ...,                  the attacker isn't fooled (no roll)
 *     onTurned : async ({ effects }) => effects.at(-1).delete(),  after a turned hit (one duplicate gone)
 *     label : ({ effects }) => "Mirror Image",                     names it in the roll's text (default : the effect's item)
 *     flavor : ({ turned, target }) => "...",                      the roll's whole text instead
 *   })
 *
 *   match  an item identifier (the effects that item puts on a creature) or effect => boolean
 *   info   { message, ray, attacker (actor), target (token), effects (the matched ones on it), item (their origin) }
 *          and roll, turned once rolled. enabled : () => boolean leaves the rule off.
 */
const rules = [];
let hooked = false;
/* Attacks being judged now (a card's create and update come close together) */
const busy = new Set();

export function hitBecomesMiss(match, rule = {}){
  rules.push({ ...rule, match });
  if(hooked) return;
  hooked = true;
  Hooks.on("createChatMessage", message => check(message));
  Hooks.on("updateChatMessage", message => check(message));
}

const matches = (rule, effect) => (typeof rule.match === "function") ? rule.match(effect) : (idOf(originItem(effect)) === rule.match);

function effectsOf(rule, actor){
  return (actor?.effects ?? []).filter(e => !e.disabled && !e.isSuppressed && matches(rule, e));
}

/* Every attack on the card (each ray, or the one roll) : the creatures it hits now */
function hitsOn(message){
  const system = message.system;
  const rays = system.isMulti ? [...(system.rays ?? []).keys()] : [null];
  return rays.flatMap(ray => (system.hitTargets?.(ray) ?? []).map(token => ({ ray, token : token.document ?? token })));
}

const keyOf = (ray, uuid) => `hitMiss.${Number.isInteger(ray) ? ray : "single"}.${String(uuid).replaceAll(".", "-")}`;

async function check(message){
  if(!rules.length || (message.type !== TYPES.attack) || !game.users.activeGM?.isSelf || !message.system?.attackOf) return;
  for(const { ray, token } of hitsOn(message)){
    const key = keyOf(ray, token.uuid);
    const done = message.getFlag(module.id, key);
    /* Already turned, and a new attack roll (a reroll) hit again : still the duplicate's */
    if(done === "turned"){
      /* ...unless the GM counted it as a hit since */
      if(!message.system.attackOf(ray)?.options?.[module.id]?.forcedHit) await message.system.turnToMiss(ray, token.uuid);
      continue;
    }
    if(done || busy.has(`${message.id}|${key}`)) continue;
    busy.add(`${message.id}|${key}`);
    try { await judge(message, ray, token, key); }
    catch(error){ log.error("Hit becomes miss", error); }
    finally { busy.delete(`${message.id}|${key}`); }
  }
}

async function judge(message, ray, token, key){
  const attacker = message.getAssociatedActor?.() ?? ChatMessage.getSpeakerActor(message.speaker);
  let matched = false;
  for(const rule of rules){
    if(rule.enabled && !rule.enabled()) continue;
    const effects = effectsOf(rule, token.actor);
    if(!effects.length) continue;
    matched = true;
    const info = { message, ray, attacker, target : token, effects, item : originItem(effects[0]) };
    if(rule.unaffected?.(info)) continue;
    const label = rule.label?.(info) ?? info.item?.name ?? effects[0].name;
    const formula = rule.formula?.(info) ?? null;
    let turned = true;
    if(formula){
      info.roll = await new Roll(String(formula)).evaluate();
      turned = !!(rule.turns?.(info) ?? true);
    }
    info.turned = turned;
    await message.setFlag(module.id, key, turned ? "turned" : "stands");
    if(info.roll) await info.roll.toMessage({ speaker : ChatMessage.getSpeaker({ token }),
      flavor : rule.flavor?.(info) ?? module.format(turned ? "hitMiss.turned" : "hitMiss.stands", { label, name : token.name }) });
    if(!turned) continue;
    await message.system.turnToMiss(ray, token.uuid);
    await rule.onTurned?.(info);
    return;
  }
  if(matched && !message.getFlag(module.id, key)) await message.setFlag(module.id, key, "stands");
}
