/**
 * Reset actor (GM, for testing builds) : the selected token's actor is deleted and remade blank, same name, type,
 * image, folder and ownership, and a linked token for it goes back where the selected one stood. Nothing carries over
 * (items, classes, proficiencies, effects, flags). With the default-actions.js Hook Macro on, the new token gets
 * Dodge, Help and Unarmed Strike again.
 *
 * Setup : Script macro (GM). Select one token, run it, confirm.
 * Notes : the actor's other tokens on this scene are removed too (tokens on other scenes lose their actor). It leaves
 *         combat with them; add the new token again.
 */

const token = canvas.tokens.controlled[0];
if(!token) return ui.notifications.warn("Reset actor : select a token first.");
const scene = token.document.parent;
const base = game.actors.get(token.document.actorId) ?? token.actor;
if(!base) return ui.notifications.warn("Reset actor : this token has no actor.");

const ok = await foundry.applications.api.DialogV2.confirm({
  window : { title : "Reset actor", icon : "fa-solid fa-rotate-left" },
  content : `<p>Delete <strong>${foundry.utils.escapeHTML(base.name)}</strong> and make a blank ${base.type} in its place? Everything on it is lost.</p>`,
});
if(!ok) return;

const { x, y, elevation } = token.document;
const prototype = base.prototypeToken.toObject();
delete prototype.delta;
const fresh = await Actor.implementation.create({
  name : base.name, type : base.type, img : base.img, folder : base.folder?.id ?? null,
  ownership : foundry.utils.deepClone(base.ownership),
  prototypeToken : { ...prototype, actorLink : true },
});

await scene.deleteEmbeddedDocuments("Token", scene.tokens.filter(t => t.actorId === base.id).map(t => t.id));
await base.delete();

const placed = await fresh.getTokenDocument({ x, y, elevation });
await scene.createEmbeddedDocuments("Token", [placed.toObject()]);
ui.notifications.info(`${fresh.name} reset.`);
