import { module } from '../module.js';
import { logger } from '../log.js';
import { ruleSet, ruleArgs } from '../helpers/rules.js';
import { tokenOf } from '../helpers/tokens.js';
import { hitOf } from './hit-bonus.js';
import { gm } from '../gm.js';
import { usedThisTurn, markUsedThisTurn } from '../helpers/actors.js';
const log = logger.for(import.meta.url);

/**
 * The row button lego : a button on a creature's row of an attack card, the GM's, that does something to that creature
 * once (Topple, Sap, Slow, Vex; a monster's "on a hit, the target is pushed or knocked Prone" the GM decides on).
 * Pair it with a trigger : `hit : true` (the attack hit that creature) is the default.
 *
 *   addRow({
 *     id : "topple",                                        the rule's key
 *     feature : "topple",                                   the item (identifier) the attacker needs; or (actor) => item
 *     when : row => row.mastery === "topple",               does this creature's row get it
 *     label : row => "Topple DC 13", tooltip, icon : "fa-person-falling", img : row => "...",
 *     conditions : ["prone"],                               the conditions it gives (or row => [ids]) : their rules in
 *                                                           its tooltip
 *     run : async row => {},                                does it; may return { total, success } (a save it rolled,
 *                                                           shown beside the button)
 *     withDamage : true,                                    applying the hit's damage to that creature runs it first
 *                                                           (it isn't optional : Sap, Slow, Vex)
 *     mayRun : row => gm.mine(row.target),                  who else may run it with the damage (the GM always may;
 *                                                           default : the user's own creature, gm.mine)
 *     once : "turn",                                        the attacker does it once a turn (in combat), whichever
 *                                                           creature : the other rows lose the button once it's done
 *   })
 *
 * row : the hit (hitOf : actor, token, item, activity, roll, critical, ability...) at this creature : target (its token),
 *       mastery (the attack's weapon mastery), feature. Done once per creature per attack; greyed once done.
 * removeRow(id) takes a rule away (a macro replacing a built-in one).
 */
const rules = ruleSet("Row rule", { when : false });
let hooked = false;

export function addRow(match, rule){
  rule = ruleArgs(match, rule);
  if(!rule.id) return;
  rules.add(rule.feature ?? (() => true), rule, rule.id);
  if(hooked) return;
  hooked = true;
  Hooks.on(`${module.id}.rowButtons`, (message, uuid, buttons, context = {}) => rowButtons(message, uuid, buttons, context));
  Hooks.on(`${module.id}.rowButton`, (message, uuid, id, { button } = {}) => {
    if(String(id).startsWith("row|")) clicked(message, uuid, String(id), button);
  });
  Hooks.on(`${module.id}.beforeApplyDamage`, (message, actor, waits) => waits.push(withDamage(message, actor)));
}

export function removeRow(id){
  rules.delete(id);
}

const rayKey = ray => Number.isInteger(ray) ? String(ray) : "single";
const uuidKey = uuid => String(uuid).replaceAll(".", "-");
const flagKey = (rule, ray, uuid) => `rows.${rule.id}.${rayKey(ray)}.${uuidKey(uuid)}`;

/* What was done on that creature's row : true, or the roll it made ({ total, success }) */
export function rowDone(message, id, ray, uuid){
  return message?.getFlag?.(module.id, `rows.${id}.${rayKey(ray)}.${uuidKey(uuid)}`) ?? null;
}

/* The row's facts, or null when the rule doesn't apply to it */
function rowOf(rule, message, ray, uuid){
  const hit = hitOf(message, ray);
  if(!hit) return null;
  const target = hit.targets.find(t => (t.document ?? t).uuid === uuid);
  if(!target) return null;
  const feature = rules.holds(rule, hit.actor);
  if(!feature) return null;
  if((rule.once === "turn") && !rowDone(message, rule.id, ray, uuid) && usedThisTurn(hit.actor, `row-${rule.id}`)) return null;
  const row = { ...hit, target, targets : [target], mastery : message.system.masteryOf?.(ray) ?? null, feature : (feature === true) ? null : feature };
  return (!rule.when || rule.when(row)) ? row : null;
}

function rowButtons(message, uuid, buttons, { result, ray = null } = {}){
  if(!game.user.isGM || !result?.hit) return;
  for(const rule of rules.values()){
    try {
      const row = rowOf(rule, message, ray, uuid);
      if(!row) continue;
      const done = rowDone(message, rule.id, ray, uuid);
      buttons.push({
        id : `row|${rule.id}|${rayKey(ray)}`,
        label : rule.label?.(row) ?? row.feature?.name ?? rule.id,
        tooltip : rule.tooltip?.(row) ?? null,
        conditions : ((typeof rule.conditions === "function") ? rule.conditions(row) : rule.conditions) ?? [],
        icon : rule.icon ?? "fa-hand-pointer",
        img : rule.img?.(row) ?? null,
        disabled : !!done,
        result : (typeof done === "object") ? done : null,
      });
    } catch(error){ log.error("Row rule", rule.id, error); }
  }
}

/* Does it, once : the flag first, so a second click or the damage's own run doesn't do it again */
async function run(rule, message, ray, uuid, row){
  if(rowDone(message, rule.id, ray, uuid)) return;
  await message.setFlag(module.id, flagKey(rule, ray, uuid), true);
  if(rule.once === "turn") await markUsedThisTurn(row.actor, `row-${rule.id}`);
  const result = await rule.run(row);
  if(result && (typeof result === "object")) await message.setFlag(module.id, flagKey(rule, ray, uuid), { total : result.total ?? null, success : result.success ?? null });
  log.debug("Row", rule.id, "on", row.target?.name);
}

async function clicked(message, uuid, id, button){
  const [, ruleId, key] = id.split("|");
  const rule = rules.get(ruleId);
  const ray = (key === "single") ? null : Number(key);
  const row = rule && game.user.isGM && rowOf(rule, message, ray, uuid);
  if(!row) return;
  if(button) button.disabled = true;
  try { await run(rule, message, ray, uuid, row); }
  catch(error){
    log.error("Row", rule.id, error);
    ui.notifications.warn(error.message);
  }
}

/* A hit's damage applied to a creature : the rules that come with it, first */
async function withDamage(message, actor){
  const card = message?.system;
  if(!card?.hitTargets || !actor) return;
  const rays = card.rays?.length ? card.rays.map((_, i) => i) : [null];
  for(const rule of [...rules.values()].filter(r => r.withDamage)){
    for(const ray of rays){
      for(const token of card.hitTargets(ray).filter(t => t.actor?.uuid === actor.uuid)){
        const uuid = (tokenOf(token)?.document ?? token).uuid;
        try {
          const row = rowOf(rule, message, ray, uuid);
          if(!row || rowDone(message, rule.id, ray, uuid)) continue;
          if(!game.user.isGM && !(message.isOwner && (rule.mayRun?.(row) ?? gm.mine(actor)))) continue;
          await run(rule, message, ray, uuid, row);
        } catch(error){ log.error("Row", rule.id, error); }
      }
    }
  }
}
