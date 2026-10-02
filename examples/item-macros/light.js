/**
 * Light (cantrip) on something you carry : your token sheds bright light 20 ft and dim light 20 ft further, and moves
 * with you. Cast it again to put it out (your token's own light comes back).
 * To leave the light somewhere instead (an unattended object), use dnd5e's own Light : it places a light token, with
 * dnd5e's "Allow Summoning" setting on for players.
 *
 * Setup : Item Macro on the Light spell, mode "Macro only".
 * Uses  : token.addLight(), token.removeLight(), token.hasLight()
 */

/* Same light as dnd5e's Light summon */
const LIGHT = {
  bright : 20, dim : 40, color : "#ff810a", alpha : 0.3,
  animation : { type : "flame", speed : 1, intensity : 3 },
};

if(!token) return ui.notifications.warn(`${actor.name} has no token on this scene.`);

if(token.hasLight("light")){
  await token.removeLight({ key : "light" });
  return ChatMessage.create({ speaker : ChatMessage.getSpeaker({ actor }), content : `<p>${actor.name}'s light goes out.</p>` });
}

await token.addLight(LIGHT, { key : "light" });
ChatMessage.create({ speaker : ChatMessage.getSpeaker({ actor }), content : `<p>${actor.name} casts <em>${item.name}</em>.</p>` });
