import { module } from '../module.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { gm } from '../gm.js';
import { tokenOf } from '../helpers/tokens.js';
const log = logger.for(import.meta.url);

/**
 * The willing lego : a use whose target makes its save only when it's unwilling (Enlarge/Reduce; Polymorph; a homebrew
 * "the creature can refuse"). Its pick offers anyone (allies and the caster too, not just enemies). Once the targets are
 * picked, the GM says for each one whether it's willing (the caster aiming it at itself is). All willing : no save card,
 * Roll Item's card has their effect rows to apply as a buff's are (the creature's owner or the GM). Some : the save
 * card, the willing ones' rows failed without a roll. The GM closing the question : nothing is cast. No GM online :
 * the save card, as for an unwilling target.
 *
 *   willingSave({ id : "enlarge-reduce", applies : activity => true, enabled : () => true })
 *
 * willingOn(card) : the willing creatures' token uuids.
 */
const rules = new Map();
let hooked = false;

export function willingSave(rule){
  if(!rule?.id) return;
  rules.set(rule.id, rule);
  if(hooked) return;
  hooked = true;
  uses.onActivity("willingPick", (activity, ctx, next) => {
    if(ruleFor(activity)) uses.mark(ctx, { pickWho : "any" });
    return next();
  });
  uses.onActivity("willing", (activity, ctx, next) => step(activity, ctx, next));
  gm.handle("willing", data => ask(data));
  /* A save card's willing rows : failed, no roll */
  Hooks.on(`${module.id}.rowResults`, (card, results) => {
    for(const uuid of willingOn(card)) results.set(uuid, { total : null, success : false, auto : module.i18n("willing.label") });
  });
}

export function willingOn(card){
  return [...(card?.getFlag?.(module.id, "willing") ?? [])];
}

function ruleFor(activity){
  if(activity?.type !== "save") return null;
  return [...rules.values()].find(rule => (!rule.enabled || rule.enabled()) && rule.applies?.(activity)) ?? null;
}

async function step(activity, ctx, next){
  if(!ruleFor(activity)) return next();
  const targets = [...game.user.targets];
  if(!targets.length) return next();
  const caster = tokenOf(activity.item)?.actor ?? activity.actor;
  /* The caster on itself : willing; the others : the GM says */
  const others = targets.filter(t => t.actor !== caster);
  let willing = targets.filter(t => t.actor === caster).map(t => t.document.uuid);
  if(others.length){
    const answer = await gm.run("willing", { item : activity.item.name, caster : caster?.name ?? "",
      targets : others.map(t => ({ uuid : t.document.uuid, name : t.name })) }, { timeout : 120000 }).catch(error => { log.warn("Willing", error); return null; });
    if(answer?.cancel) return void ui.notifications.info(module.format("willing.cancelled", { item : activity.item.name }));
    willing = willing.concat(answer?.willing ?? []);
  }
  if(!willing.length) return next();
  const note = module.format("willing.note", { names : targets.filter(t => willing.includes(t.document.uuid)).map(t => t.name).join(", ") });
  /* All willing : no save (a buff's card); else the willing rows fail without a roll */
  if(willing.length === targets.length) uses.flag(ctx, { noSave : true, note });
  else uses.flag(ctx, { willing, note });
  log.debug("Willing", activity.item.name, willing);
  return next();
}

/* The GM : willing or not, for each target */
async function ask({ item, caster, targets = [] } = {}){
  const willing = [];
  for(const target of targets){
    const answer = await foundry.applications.api.DialogV2.wait({
      window : { title : item, icon : "fa-solid fa-handshake" },
      content : `<p>${foundry.utils.escapeHTML(module.format("willing.ask", { caster, target : target.name, item }))}</p>`,
      buttons : [
        { action : "willing", label : module.i18n("willing.yes"), icon : "fa-solid fa-check", default : true },
        { action : "unwilling", label : module.i18n("willing.no"), icon : "fa-solid fa-shield" },
      ],
      rejectClose : false,
    }).catch(() => null);
    if(!answer) return { cancel : true };
    if(answer === "willing") willing.push(target.uuid);
  }
  return { willing };
}
