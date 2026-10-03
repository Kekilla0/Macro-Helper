/**
 * Default actions : when a token is placed, its creature gets Dash, Disengage, Dodge, Help and Unarmed Strike if it doesn't have
 * them yet, and the ones it gets are added to its Favorites (characters' sheets). A creature that already has one
 * (by identifier : "dash", "disengage", "dodge", "help", "unarmed-strike") keeps its own, and nothing else happens.
 *
 * Setup : 1. Import examples/items/dash.json, disengage.json, dodge.json, help.json and unarmed-strike.json into the Items sidebar (right-click
 *            an item, Import Data). The copies there are what creatures get.
 *         2. Hook Macro (world macro, Script). Run on Hooks : "Token created" (createToken).
 *            Run For : Active GM (once).
 * Notes : Unlinked tokens (most monsters) get their own copies on that token; linked ones (characters) get them on
 *         the actor, once. Change TYPES to leave monsters out : ["character"].
 */

const TYPES = ["character", "npc"];
const DEFAULTS = ["dash", "disengage", "dodge", "help", "unarmed-strike"];

const [tokenDoc] = args;
const actor = tokenDoc?.actor;
if(!actor || !TYPES.includes(actor.type)) return;

const idOf = item => item.identifier ?? item.system?.identifier;
const missing = DEFAULTS.filter(id => !actor.items.some(i => idOf(i) === id));
if(!missing.length) return;

/* The world's copies, from the Items sidebar */
const sources = missing.map(id => game.items.find(i => idOf(i) === id)).filter(Boolean);
const absent = missing.filter(id => !game.items.some(i => idOf(i) === id));
if(absent.length) ui.notifications.warn(`Default actions : import ${absent.join(", ")} into the Items sidebar first (examples/items).`);
if(!sources.length) return;

const created = await actor.createEmbeddedDocuments("Item", sources.map(i => i.toObject()));

/* Favorites (dnd5e characters) : the new items, at the end of the list */
if(typeof actor.system.addFavorite === "function"){
  for(const item of created){
    await actor.system.addFavorite({ type : "item", id : foundry.utils.buildRelativeUuid(item, actor) });
  }
}
