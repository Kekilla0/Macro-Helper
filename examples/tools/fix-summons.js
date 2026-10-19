/**
 * Fix summoning spells imported without their creatures (Plutonium : Dancing Lights summons nothing, Find Familiar has
 * no creature). Copies the summon profiles from dnd5e's own 2024 version of each spell (Spells SRD 2024), which
 * already points at dnd5e's creatures : 4 Tiny Dancing Lights (or 1 Medium), Find Familiar's CR 0 Beasts, Light.
 *
 * Setup : a world Script macro. Select the character's token (or set ACTOR_NAME) and run it once, as the GM.
 *         Players also need dnd5e's "Allow Summoning" setting on (Configure Settings → D&D 5e) and the
 *         "Create New Tokens" permission (Configure Settings → User Management → Permissions) to summon.
 */

const ACTOR_NAME = "";   // or leave empty to use the selected token's actor
const SPELLS = ["Dancing Lights", "Find Familiar", "Light"];

const target = ACTOR_NAME ? game.actors.getName(ACTOR_NAME) : canvas.tokens.controlled[0]?.actor;
if(!target) return ui.notifications.warn("Select a token, or set ACTOR_NAME.");

const pack = game.packs.get("dnd5e.spells24");
if(!pack) return ui.notifications.warn("dnd5e's 2024 spell compendium (dnd5e.spells24) isn't available.");
const index = await pack.getIndex();

const fixed = [];
for(const name of SPELLS){
  const item = target.items.find(i => (i.type === "spell") && (i.name === name));
  const entry = index.find(e => e.name === name);
  if(!item || !entry) continue;

  const source = (await pack.getDocument(entry._id))?.system.activities?.getByType("summon")[0];
  const summon = item.system.activities?.getByType("summon")[0];
  if(!source || !summon) continue;

  await summon.update({
    profiles : source.toObject().profiles,
    summon : source.toObject().summon,
    creatureTypes : source.toObject().creatureTypes ?? [],
    creatureSizes : source.toObject().creatureSizes ?? [],
  });
  fixed.push(name);
}

ui.notifications.info(fixed.length ? `${target.name} : summons fixed for ${fixed.join(", ")}.` : `${target.name} : nothing to fix.`);
