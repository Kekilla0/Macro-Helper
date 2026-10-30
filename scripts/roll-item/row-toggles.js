import { module } from '../module.js';
import { logger } from '../log.js';
import { rollModes, giveRollMode } from '../automation/roll-modes.js';
const log = logger.for(import.meta.url);

/**
 * The save-row toggle lego : on a save card, a toggle for each creature that hasn't rolled yet, for the card's owner,
 * up to a number of them; the creatures chosen succeed without rolling, or roll their first save from the card with
 * advantage or disadvantage (Careful Spell, Heightened Spell; a homebrew "shape your blast round your friends"; a
 * monster's "one creature of its choice has disadvantage on the save").
 *
 *   saveRowToggle({
 *     id : "careful",                                  the rule's key
 *     when : card => ({ limit : 3, label, icon : "fa-shield-heart", hint }),   does this card get it (null : no)
 *     success : true,                                  the chosen succeed without rolling
 *     noDamage : card => true,                         ... and take no damage (default : where a success takes half)
 *     mode : "disadvantage",                           or : their first save from the card has that mode
 *     reason : card => "Heightened Spell",             shown with it (the automatic success, the mode)
 *     enabled : () => true,
 *   })
 *
 * toggledOn(card, id) : the chosen creatures' token uuids.
 */
const rules = new Map();
let hooked = false;

const uuidKey = uuid => String(uuid).replaceAll(".", "-");

export function saveRowToggle(rule){
  if(!rule?.id) return;
  rules.set(rule.id, rule);
  if(hooked) return;
  hooked = true;
  foundry.applications.handlebars.loadTemplates({ [`${module.id}.rowToggle`] : `${module.path}/templates/row-toggle.hbs` });
  Hooks.on(`${module.id}.cardSections`, (card, sections) => { for(const rule of rules.values()) section(rule, card, sections); });
  Hooks.on(`${module.id}.cardButton`, (card, id, { button } = {}) => {
    if(String(id).startsWith("toggle|")) toggle(rules.get(String(id).slice(7)), card, button?.dataset?.target);
  });
  Hooks.on(`${module.id}.rowResults`, (card, results) => { for(const rule of rules.values()) autoSuccess(rule, card, results); });
  Hooks.on(`${module.id}.saveHint`, (card, actor, ability, { adv, dis } = {}) => {
    for(const rule of rules.values()){
      if(!rule.mode || !applies(rule, card)) continue;
      if(toggledOn(card, rule.id).some(uuid => fromUuidSync(uuid, { strict : false })?.actor === actor)) ((rule.mode === "advantage") ? adv : dis)?.push(reasonOf(rule, card));
    }
  });
  rollModes.add("rowToggles", (config, message) => { for(const rule of rules.values()) firstSave(rule, config, message); }, { rolls : "save" });
}

/* The creatures chosen on that card (token uuids) */
export function toggledOn(card, id){
  return Object.entries(card?.getFlag?.(module.id, `toggles.${id}`) ?? {}).filter(([, on]) => on).map(([key]) => key.replaceAll("-", "."));
}

function applies(rule, card){
  if(rule.enabled && !rule.enabled()) return null;
  return rule.when?.(card) ?? null;
}

function reasonOf(rule, card){
  return rule.reason?.(card) ?? applies(rule, card)?.label ?? rule.id;
}

/* The section on a save card : a toggle per target that hasn't rolled, for the card's owner */
function section(rule, card, sections){
  if(!card?.isOwner || !(card.system?.targets?.length)) return;
  const shown = applies(rule, card);
  if(!shown) return;
  const limit = Math.max(1, Number(shown.limit) || 1);
  const on = new Set(toggledOn(card, rule.id));
  const outcomes = card.system?.outcomes ?? new Map();
  const rows = card.system.targets.map(t => {
    const chosen = on.has(t.token);
    const rolled = outcomes.has?.(t.token) && !chosen;
    return { uuid : t.token, name : t.name, on : chosen, disabled : rolled || (!chosen && (on.size >= limit)) };
  });
  sections.push({ partial : `${module.id}.rowToggle`, context : { id : rule.id, rows, label : shown.label ?? rule.id, icon : shown.icon ?? "fa-square-check", hint : shown.hint ?? "" } });
}

async function toggle(rule, card, uuid){
  const shown = rule && applies(rule, card);
  if(!shown || !card?.isOwner || !uuid) return;
  const key = uuidKey(uuid);
  const now = !!card.getFlag(module.id, `toggles.${rule.id}.${key}`);
  if(!now && (toggledOn(card, rule.id).length >= Math.max(1, Number(shown.limit) || 1))) return;
  await card.setFlag(module.id, `toggles.${rule.id}.${key}`, !now);
  log.debug("Row toggle", rule.id, uuid, !now);
}

/* Success : the chosen are settled without a roll */
function autoSuccess(rule, card, results){
  if(!rule.success || !applies(rule, card)) return;
  const onSave = card.system?.rider?.onSave ?? card.getAssociatedActivity?.()?.damage?.onSave;
  const noDamage = rule.noDamage ? !!rule.noDamage(card) : (onSave === "half");
  for(const uuid of toggledOn(card, rule.id)) results.set(uuid, { total : null, success : true, auto : reasonOf(rule, card), noDamage });
}

/* Mode : the chosen creature's first save from the card */
function firstSave(rule, config, message){
  if(!rule.mode) return;
  const card = game.messages.get(message?.data?.system?.origin?.id ?? message?.data?.system?.origin);
  if(!card || !applies(rule, card)) return;
  const token = message?.data?.speaker?.token;
  if(!token || !toggledOn(card, rule.id).some(uuid => uuid.endsWith(`Token.${token}`))) return;
  const already = game.messages.contents.some(m => (m.type === "save") && ((m.system?.origin?.id ?? m.system?.origin) === card.id) && (m.speaker?.token === token));
  if(already) return;
  giveRollMode(config, rule.mode, reasonOf(rule, card));
}
