/**
 * Upgrade items (GM) : the items in Macro Helper's Actions compendium (Dash, Disengage, Dodge, Help, Unarmed Strike,
 * Reckless Attack) are copied onto the selected tokens' creatures, in place :
 *   - a creature that has the item (same identifier) keeps its own : only the activities, description and the
 *     effects they use are replaced, so it stays where it was on the sheet (a Barbarian feature under Barbarian);
 *   - one that doesn't gets a copy;
 *   - a class feature that lost its place on the sheet (dragged in from a file : "Other features") is put back under
 *     its class, from the class's own grant of it.
 *
 * Setup : Script macro (GM). Select the tokens, run it.
 */

const sources = await (game.packs.get("macro-helper.actions")?.getDocuments() ?? []);
if(!sources.length) return ui.notifications.warn("Upgrade items : the Actions compendium (Macro Helper) is empty.");
const actors = [...new Set(canvas.tokens.controlled.map(t => t.actor).filter(Boolean))];
if(!actors.length) return ui.notifications.warn("Upgrade items : select one or more tokens.");

const idOf = item => item.identifier ?? item.system?.identifier;
const replace = value => (typeof _replace === "function") ? _replace(value) : foundry.data.operators.ForcedReplacement.create(value);

/* Where a class feature belongs : "<class item id>.<ItemGrant advancement id>" for the grant that gives it */
const originFor = (actor, item) => {
  for(const cls of actor.items.filter(i => ["class", "subclass"].includes(i.type))){
    for(const advancement of cls.system.advancement?.byType?.ItemGrant ?? []){
      const granted = (advancement.configuration?.items ?? []).map(e => fromUuidSync(e.uuid ?? e, { strict : false }));
      if(granted.some(g => g && ((g.name === item.name) || (idOf(g) === idOf(item))))) return `${cls.id}.${advancement.id}`;
    }
  }
  return null;
};

const report = [];
for(const actor of actors){
  for(const source of sources){
    const own = actor.items.find(i => idOf(i) === idOf(source));
    const data = source.toObject();
    if(!own){
      const origin = originFor(actor, source);
      if(origin) foundry.utils.setProperty(data, "flags.dnd5e.advancementOrigin", origin);
      await actor.createEmbeddedDocuments("Item", [data]);
      report.push(`${actor.name} : added ${source.name}`);
      continue;
    }
    const update = {
      "system.activities" : replace(data.system.activities ?? {}),
      "system.description.value" : data.system.description?.value ?? own.system.description?.value,
    };
    if(!own.getFlag("dnd5e", "advancementOrigin")){
      const origin = originFor(actor, own);
      if(origin) update["flags.dnd5e.advancementOrigin"] = origin;
    }
    await own.update(update);
    /* The effects its activities apply, with the same ids */
    for(const effect of data.effects ?? []){
      if(own.effects.get(effect._id)) await own.effects.get(effect._id).update(effect);
      else await own.createEmbeddedDocuments("ActiveEffect", [effect], { keepId : true });
    }
    report.push(`${actor.name} : upgraded ${own.name}${update["flags.dnd5e.advancementOrigin"] ? " (back under its class)" : ""}`);
  }
}
ui.notifications.info(`Upgrade items : ${report.length} changes. Details in the console (F12).`);
console.log("Macro Helper | Upgrade items\n" + report.join("\n"));
