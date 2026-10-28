import { module } from '../module.js';
import { whisperOwners, esc, idOf } from '../helpers/utils.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { isIncapacitated } from '../helpers/tokens.js';
const log = logger.for(import.meta.url);

/**
 * The initiative swap lego : right after a creature with the feature rolls initiative, a card (to its owners and the GM)
 * offers to swap initiative with an ally in the combat, until the first turn passes, or "Do not swap" (Alert; a
 * monster's "Tactician : it may trade places in the order with an ally"). Not while either is Incapacitated. Carried
 * out by the GM, once the ally's player agrees (no question when the asker owns both, or no other player owns the ally).
 * With Compact Initiative the offer is on the round's initiative card instead (swap buttons on the allies' rows,
 * initiative.js).
 *
 *   initiativeSwap("alert", {          the item (identifier) it needs
 *     when : combatant => true,         may it offer a swap now
 *     enabled : () => true,
 *   })
 *
 * initiativeSwap.open(combat) : the combat's open offers (Compact Initiative), [{ combatant, info, feature }]
 * initiativeSwap.allies(combatant, combat) : who it could swap with
 */
const rules = new Map();
let hooked = false;

export function initiativeSwap(feature, rule = {}){
  if(!feature) return;
  rules.set(feature, { ...rule, feature });
  if(hooked) return;
  hooked = true;
  Hooks.on("updateCombatant", (combatant, changes, options) => onInitiative(combatant, changes, options));
  Hooks.on("renderChatMessageHTML", (message, html) => wireCard(message, html));
  gm.handle("initiativeSwap", (data, user) => swapAsGM(data, user));
}

/* The rule (and its item) a creature swaps with */
function featureOf(actor){
  for(const rule of rules.values()){
    if(rule.enabled && !rule.enabled()) continue;
    const item = actor?.items?.find?.(i => idOf(i) === rule.feature);
    if(item) return { rule, item };
  }
  return null;
}

/* A combatant's initiative was just rolled (or set) : the active GM posts the swap card */
async function onInitiative(combatant, changes, options = {}){
  if(!("initiative" in (changes ?? {})) || (changes.initiative === null)) return;
  if(options?.[module.id]?.initiativeSwap) return;   // our own swap, not a new roll
  if(!game.users.activeGM?.isSelf) return;
  const found = featureOf(combatant.actor);
  if(!found || (found.rule.when && !found.rule.when(combatant))) return;
  const combat = combatant.combat ?? combatant.parent;
  const list = allies(combatant, combat);
  if(!list.length) return;
  const at = { round : combat.round, turn : combat.turn ?? 0, done : false, feature : found.item.name };

  /* Compact Initiative : the offer goes on the round's initiative card */
  if(settings.value("initiativeMessages") === "compact"){
    await combat.setFlag(module.id, `initiativeSwap.${combatant.id}`, at);
    log.debug("Initiative swap offered on the initiative card", combatant.name);
    return;
  }

  const rows = list.map(c => `
    <li class="macro-helper-row">
      <img class="token" src="${esc(c.img)}" alt="" data-token="${esc(c.token?.uuid ?? "")}">
      <span class="name">${esc(c.name)}</span>
      <span class="result">${c.initiative ?? "—"}</span>
      <button type="button" data-macro-helper-swap="${c.id}"><i class="fa-solid fa-right-left" inert></i> ${module.i18n("initiativeSwap.swap")}</button>
    </li>`).join("") + `
    <li class="macro-helper-row">
      <button type="button" data-macro-helper-swap=""><i class="fa-solid fa-ban" inert></i> ${module.i18n("initiativeSwap.keep")}</button>
    </li>`;
  await whisperOwners(combatant.actor, `<div class="macro-helper-swap"><p><strong>${esc(found.item.name)}</strong> : ${module.format("initiativeSwap.hint", { initiative : combatant.initiative })}</p><ul class="unlist macro-helper-rows">${rows}</ul></div>`,
    { flags : { [module.id] : { initiativeSwap : { ...at, combat : combat.id, combatant : combatant.id } } } });
  log.debug("Initiative swap offered", combatant.name, list.map(c => c.name));
}

/* Allies in the same combat who could swap : same side, initiative rolled and not the same as its own (a swap would
   change nothing), not incapacitated */
function allies(combatant, combat){
  const side = combatant.token?.disposition ?? combatant.actor?.prototypeToken?.disposition;
  return (combat?.combatants?.contents ?? [...(combat?.combatants ?? [])]).filter(c => (c.id !== combatant.id)
    && (c.initiative !== null) && (c.initiative !== combatant.initiative) && c.actor
    && ((c.token?.disposition ?? c.actor.prototypeToken?.disposition) === side)
    && !isIncapacitated(c.actor));
}
initiativeSwap.allies = allies;

/**
 * An offer and how to close it : from its own card ({ message }), or from the combat (Compact Initiative :
 * { combat, combatant }).
 * @returns {{ info : object|null, read : () => object|null, close : () => Promise }}
 */
function offerOf({ message : id, combat : combatId, combatant : combatantId } = {}){
  if(id){
    const message = game.messages.get(id);
    return { info : message?.getFlag(module.id, "initiativeSwap") ?? null, read : () => message?.getFlag(module.id, "initiativeSwap"),
      close : () => message.setFlag(module.id, "initiativeSwap.done", true) };
  }
  const combat = game.combats.get(combatId);
  const read = () => {
    const info = combat?.getFlag(module.id, `initiativeSwap.${combatantId}`);
    return info ? { ...info, combat : combatId, combatant : combatantId } : null;
  };
  return { info : read(), read, close : () => combat.setFlag(module.id, `initiativeSwap.${combatantId}.done`, true) };
}

/* The open offers of a combat (Compact Initiative) : [{ combatant, info }] */
initiativeSwap.open = function(combat){
  const offers = combat?.getFlag?.(module.id, "initiativeSwap") ?? {};
  return Object.keys(offers).map(id => ({ combatant : combat.combatants.get(id), info : offerOf({ combat : combat.id, combatant : id }).info }))
    .filter(o => o.combatant && inTime(o.info));
};

/**
 * Two combatants' initiative after a swap. The rolled initiative trades places; dnd5e's ability score tie-breaker
 * (DEX 14 : +0.14 in the initiative) belongs to each creature, so each keeps its own.
 * @returns {{ a : number, b : number }}
 */
export function swappedInitiatives(a, b){
  const tie = c => {
    let on = false;
    try { on = game.settings.get("dnd5e", "initiativeDexTiebreaker"); } catch { on = false; }
    if(!on) return 0;
    const ability = c.actor?.system?.attributes?.init?.ability || CONFIG.DND5E.defaultAbilities?.initiative || "dex";
    const value = Number(c.actor?.system?.abilities?.[ability]?.value);
    return Number.isFinite(value) ? value / 100 : 0;
  };
  const round = n => Math.round(n * 100) / 100;
  const ta = tie(a), tb = tie(b);
  return { a : round((b.initiative - tb) + ta), b : round((a.initiative - ta) + tb) };
}

/* Still in time : the same combat, no turn has passed since the roll */
function inTime(info){
  const combat = game.combats.get(info?.combat);
  return !!combat && !info.done && (combat.round === info.round) && ((combat.turn ?? 0) === info.turn);
}

function wireCard(message, html){
  const info = message.getFlag?.(module.id, "initiativeSwap");
  if(!info) return;
  const open = inTime(info);
  for(const button of html.querySelectorAll("[data-macro-helper-swap]")){
    button.disabled = !open;
    button.addEventListener("click", async event => {
      event.preventDefault();
      button.disabled = true;
      const ally = button.dataset.macroHelperSwap || null;
      if(ally) ui.notifications.info("initiativeSwap.asking", { localize : true });
      try {
        /* The GM may wait on the ally's player : give it time */
        const notes = await gm.run("initiativeSwap", { message : message.id, ally }, { timeout : 90000 });
        for(const note of notes ?? []) ui.notifications.info(note);
      } catch(error){
        ui.notifications.warn(error.message);
      } finally {
        button.disabled = !inTime(message.getFlag(module.id, "initiativeSwap"));
      }
    });
  }
}

/**
 * Done by the GM's client : the asker must own the swapping creature, it must still be in time, and both must be able
 * to swap (in the combat, allies, not Incapacitated). The ally's player is asked (unless the asker owns it too, or no
 * other player does); then the two initiatives trade places. No ally (null) : "Do not swap", the offer closes.
 */
async function swapAsGM({ message : id, combat : combatId, combatant : combatantId, ally : allyId } = {}, user){
  const offer = offerOf({ message : id, combat : combatId, combatant : combatantId });
  const info = offer.info;
  const combat = game.combats.get(info?.combat);
  const combatant = combat?.combatants.get(info?.combatant);
  if(!combatant) throw new Error("This initiative swap no longer matches a combat.");
  if(!user?.isGM && !combatant.actor?.testUserPermission(user, "OWNER")) throw new Error("Only the swapping creature's owner can swap.");
  if(!inTime(info)) return [module.i18n("initiativeSwap.late")];
  if(!allyId){
    await offer.close();
    return [module.format("initiativeSwap.kept", { a : combatant.name })];
  }
  if(isIncapacitated(combatant.actor)) return [module.i18n("initiativeSwap.incapacitated")];
  const ally = allies(combatant, combat).find(c => c.id === allyId);
  if(!ally) return [module.i18n("initiativeSwap.noAlly")];

  /* The ally's player agrees to it (not the asker, not a GM) */
  const feature = info.feature ?? featureOf(combatant.actor)?.item?.name ?? "";
  const answer = await gm.askPlayer(ally.actor, {
    title : feature, icon : "fa-solid fa-right-left",
    content : `<p>${module.format("initiativeSwap.askHint", { a : esc(combatant.name), b : esc(ally.name), feature : esc(feature), mine : combatant.initiative, theirs : ally.initiative })}</p>`,
    buttons : [
      { action : "yes", label : module.i18n("initiativeSwap.accept"), icon : "fa-solid fa-check", default : true },
      { action : "no", label : module.i18n("initiativeSwap.decline"), icon : "fa-solid fa-xmark" },
    ],
  }, { exclude : [user], fallback : "yes" });
  if(answer !== "yes") return [module.format("initiativeSwap.declined", { b : ally.name })];
  if(!inTime(offer.read())) return [module.i18n("initiativeSwap.late")];

  const swapped = swappedInitiatives(combatant, ally);
  await combat.updateEmbeddedDocuments("Combatant", [{ _id : combatant.id, initiative : swapped.a }, { _id : ally.id, initiative : swapped.b }],
    { [module.id] : { initiativeSwap : true } });
  await offer.close();
  return [module.format("initiativeSwap.swapped", { a : combatant.name, b : ally.name })];
}
