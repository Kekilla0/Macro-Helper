import { module } from '../module.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
const log = logger.for(import.meta.url);

/**
 * The damage-cut lego : a reaction that makes a card's damage to a creature lower (Interception, Deflect Attacks,
 * Protective Field, Cutting Words on a damage roll) says how much; the card remembers it, shows a note, and dnd5e's
 * damage from that card to that creature (its tray, its row's Apply) is that much lower.
 *
 *   await cutDamage(message, token, { amount : 7, by : "Ana", label : "Deflect Attacks", formula, result })
 *   cutDamage(message, "all", ...)      every creature the card damages (a damage roll made lower)
 *   cutsOf(message, token)              the cuts on a card for that creature : [{ amount, by, label }]
 *
 * Anyone may ask : the card is changed by the GM (a roll on a card, not a creature's data).
 */
const ALL = "all";

/* The card flag's key for a creature (its token's uuid), or "all" */
const keyOf = token => (token === ALL) ? ALL : String(token?.document?.uuid ?? token?.uuid ?? token ?? "").replaceAll(".", "-");

let registered = false;
export function registerDamageCuts(){
  if(registered) return;
  registered = true;
  gm.handle("cutDamage", (data, user) => cutAsGM(data, user));
  Hooks.on("dnd5e.calculateDamage", (actor, damages, options) => applyCuts(actor, damages, options));
  Hooks.on(`${module.id}.cardNotes`, (message, notes, { ray } = {}) => { if(!Number.isInteger(ray)) notes.push(...notesOf(message)); });
}

/**
 * Make a card's damage to a creature lower.
 * @param {ChatMessage} message
 * @param {Token|TokenDocument|string} token   the creature, or "all"
 * @param {object} cut
 * @param {number} cut.amount
 * @param {string} cut.label     what made it lower (the note's words)
 * @param {string} [cut.by]      who
 * @param {string} [cut.id]      one per id per creature (default : the label)
 * @param {string} [cut.formula], [cut.result]   the roll, for the note's tooltip
 * @returns {Promise<boolean>}
 */
export async function cutDamage(message, token, { amount, label, by = "", id = null, formula = "", result = "" } = {}){
  if(!message) return false;
  const name = (token === ALL) ? "" : (token?.name ?? token?.document?.name ?? "");
  return !!await gm.run("cutDamage", { message : message.id, key : keyOf(token), id : id ?? label, amount, label, by, name, formula, result : String(result) });
}

/**
 * A card's cuts for one creature (its own and "all").
 * @returns {{ id : string, amount : number, label : string, by : string }[]}
 */
export function cutsOf(message, token){
  const all = message?.getFlag?.(module.id, "cuts") ?? {};
  return [...Object.values(all[keyOf(token)] ?? {}), ...Object.values(all[ALL] ?? {})];
}

/* GM : the card remembers it */
async function cutAsGM({ message : id, key, id : cutId, amount, label, by, name, formula, result } = {}, user){
  const message = game.messages.get(id);
  if(!message || !key || !cutId) return false;
  const path = `cuts.${key}.${String(cutId).replace(/[.\s]/g, "-")}`;
  if(message.getFlag(module.id, path)) return false;
  await message.setFlag(module.id, path, { id : cutId, amount : Math.max(0, Number(amount) || 0), label, by, name, formula, result, user : user?.id ?? null });
  return true;
}

/* Damage from a card to a creature with cuts : that much lower (healing isn't) */
function applyCuts(actor, damages, options = {}){
  const message = options.origin ?? options.originatingMessage;
  if(!message?.getFlag?.(module.id, "cuts") || !(damages?.amount > 0)) return;
  const token = actor.token ?? actor.getActiveTokens?.(false, true)?.[0];
  const total = cutsOf(message, token).reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
  if(!total) return;
  damages.amount = Math.max(0, damages.amount - total);
  log.debug("Damage cut", actor.name, -total);
}

/* The card's notes : who made which damage lower */
function notesOf(message){
  const notes = [];
  for(const [key, cuts] of Object.entries(message?.getFlag?.(module.id, "cuts") ?? {})){
    for(const c of Object.values(cuts)){
      notes.push({ icon : "fa-shield", tooltip : c.formula ? `${c.formula} = ${c.result}` : "",
        text : module.format((key === ALL) ? "damageCuts.noteAll" : "damageCuts.note", { label : c.label, by : c.by, amount : c.amount, target : c.name }) });
    }
  }
  return notes;
}
