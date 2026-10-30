import { module } from '../module.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { esc, buttonRow, addButton, makeButton, ownerIds, gmIds } from '../helpers/utils.js';
import { tokenOf, distanceBetween } from '../helpers/tokens.js';
import { findItem } from '../helpers/actors.js';
import { hasReaction } from '../roll-item/card-builder.js';
import { ruleArgs } from '../helpers/rules.js';
const log = logger.for(import.meta.url);

/**
 * The whenDamaged lego : a Reaction (or any use) offered to a creature right after it takes damage (Stone's
 * Endurance, Storm's Thunder; a homebrew "when you're hit, you can..."). Its player (or the GM, for a creature no
 * player owns) gets a whispered card, Use / Pass, only when it can : the feature's activity ready (its uses left; a
 * Reaction : one left, not Incapacitated), and with `within`, the one who dealt it that close.
 *
 *   whenDamaged("giant-ancestry-storm", { id : "storms-thunder", within : 60, atSource : true });
 *   whenDamaged("giant-ancestry-stone", { id : "stones-endurance", after : (ctx, used) => ... });
 *
 *   match     : the item it needs (identifier, name, or actor => item); the older form whenDamaged(id, { feature })
 *               still works
 *   when      : ctx => boolean, does this damage count
 *   within    : feet to the one who dealt it (a card's creature; damage with no card : none, so not offered)
 *   activity  : (item, ctx) => Activity, what Use uses (default : the item's Reaction activity, else its first); its
 *               own costs and economy (the Action Tracker spends the Reaction)
 *   atSource  : the use is aimed at the one who dealt it (its targets set to that creature, no pick)
 *   after     : (ctx, results) => {}, once used (Stone's Endurance : the roll that takes the damage back)
 *   label, icon, enabled
 *
 * ctx : { id, actor, token, item, amount (the damage taken, temporary Hit Points included), message (the card it
 *         came from, or null), source (the Token that dealt it, or null) }
 */
const rules = new Map();
let hooked = false;

export function whenDamaged(match, rule = {}){
  /* The older form : (id, { feature, ... }) */
  if(rule.feature !== undefined) rule = { ...rule, id : rule.id ?? match };
  else rule = ruleArgs(match, rule);
  const id = rule.id;
  if(!id || !rule.feature) return;
  rules.set(id, { ...rule, id });
  if(hooked) return;
  hooked = true;
  Hooks.on("dnd5e.applyDamage", (actor, amount, options) => offer(actor, amount, options).catch(error => log.warn("whenDamaged", error)));
  Hooks.on("renderChatMessageHTML", (message, html) => buttons(message, html));
  gm.handle("whenDamagedDone", (data, user) => doneAsGM(data, user));
}

function itemOf(rule, actor){
  return (typeof rule.feature === "function") ? rule.feature(actor) : findItem(actor, rule.feature);
}

function activityOf(rule, item, ctx){
  if(rule.activity) return rule.activity(item, ctx) ?? null;
  const all = [...(item?.system?.activities ?? [])];
  return all.find(a => a.activation?.type === "reaction") ?? all[0] ?? null;
}

/* Can it use it now : enabled, its uses left, a Reaction left for a Reaction, the one who dealt it close enough */
function ready(rule, ctx){
  if(rule.enabled && !rule.enabled()) return false;
  if(!ctx.item || !(ctx.amount > 0)) return false;
  const activity = activityOf(rule, ctx.item, ctx);
  if(!activity) return false;
  const uses = ctx.item.system?.uses;
  const spendsUses = activity.consumption?.targets?.some?.(t => (t.type === "itemUses") && (!t.target || (t.target === ctx.item.id)));
  if(spendsUses && (Number(uses?.max) > 0) && !(Number(uses.value) > 0)) return false;
  if((activity.activation?.type === "reaction") && !hasReaction(ctx.actor)) return false;
  if(Number.isFinite(rule.within)){
    if(!ctx.source?.actor || (ctx.source.actor === ctx.actor) || !ctx.token) return false;
    if(distanceBetween(ctx.token, ctx.source) > rule.within) return false;
  }
  return !rule.when || !!rule.when(ctx);
}

function contextOf(rule, actor, amount, messageId, sourceUuid){
  const message = messageId ? (game.messages.get(messageId) ?? null) : null;
  const source = sourceUuid ? (fromUuidSync(sourceUuid, { strict : false })?.object ?? null) : null;
  return { id : rule.id, actor, token : tokenOf(actor), item : itemOf(rule, actor), amount, message, source };
}

/* Damage taken (on the client that applied it) : a card for each rule it can use now */
async function offer(actor, amount, options = {}){
  if(!(amount > 0) || !actor) return;
  const message = options.origin ?? options.originatingMessage ?? null;
  const from = message?.getAssociatedToken?.() ?? tokenOf(message?.getAssociatedActor?.())?.document ?? null;
  for(const rule of rules.values()){
    const ctx = contextOf(rule, actor, amount, message?.id ?? null, from?.uuid ?? null);
    if(!ready(rule, ctx)) continue;
    /* Its players and the GM (the only one, for a creature no player owns) */
    const players = ownerIds(actor, { players : true });
    const label = rule.label?.(ctx) ?? ctx.item.name;
    const text = module.format(ctx.source ? "whenDamaged.textFrom" : "whenDamaged.text",
      { name : ctx.token?.name ?? actor.name, amount, from : ctx.source?.name ?? "", item : label });
    await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor }),
      content : `<p>${esc(text)}</p>`,
      whisper : [...new Set([...players, ...gmIds()])],
      flags : { [module.id] : { whenDamaged : { rule : rule.id, actor : actor.uuid, amount, message : message?.id ?? null,
        source : from?.uuid ?? null, label, icon : rule.icon ?? "fa-bolt", done : false } } },
    });
    log.debug("whenDamaged offered", rule.id, actor.name, amount);
  }
}

/* Use / Pass for the creature's owners; the answer once given */
function buttons(message, html){
  const offer = message.getFlag?.(module.id, "whenDamaged");
  if(!offer) return;
  const row = buttonRow(html, { key : `${module.id}-when-damaged` });
  if(row.childElementCount) return;
  if(offer.done){
    const p = document.createElement("p");
    p.textContent = module.i18n(offer.done === "used" ? "whenDamaged.used" : "whenDamaged.passed");
    return row.append(p);
  }
  const actor = fromUuidSync(offer.actor, { strict : false });
  if(!actor?.isOwner) return;
  addButton(row, makeButton({ icon : offer.icon, text : module.format("whenDamaged.use", { item : offer.label }), once : true, onClick : () => use(message) }));
  addButton(row, makeButton({ icon : "fa-xmark", text : module.i18n("whenDamaged.pass"), once : true, onClick : () => answer(message, "passed") }));
}

async function use(message){
  const offer = message.getFlag(module.id, "whenDamaged");
  const rule = rules.get(offer?.rule);
  const actor = fromUuidSync(offer?.actor ?? "", { strict : false });
  if(!rule || !actor?.isOwner || offer.done) return;
  const ctx = contextOf(rule, actor, offer.amount, offer.message, offer.source);
  if(!ready(rule, ctx)){
    ui.notifications.warn(module.format("whenDamaged.cant", { name : actor.name, item : offer.label }));
    return;
  }
  const activity = activityOf(rule, ctx.item, ctx);
  const own = { skipPick : true };
  if(rule.atSource && ctx.source){
    canvas.tokens.setTargets(ctx.source.scene === canvas.scene ? [ctx.source.id] : []);
    own.useTargets = true;
  }
  const results = await activity.use({ [module.id] : own }, { configure : false });
  if(!results) return;
  await answer(message, "used");
  if(rule.after) await rule.after(ctx, results);
}

async function answer(message, done){
  await gm.run("whenDamagedDone", { message : message.id, done });
}

async function doneAsGM({ message : id, done } = {}, user){
  const message = game.messages.get(id);
  const offer = message?.getFlag(module.id, "whenDamaged");
  const actor = fromUuidSync(offer?.actor ?? "", { strict : false });
  if(!offer || offer.done || !actor?.testUserPermission(user, "OWNER") || !["used", "passed"].includes(done)) return false;
  await message.setFlag(module.id, "whenDamaged.done", done);
  return true;
}
