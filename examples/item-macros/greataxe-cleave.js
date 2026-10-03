/**
 * Greataxe cleave (Orc Soldier) : hits up to 2 Medium targets, or 3 Small or smaller targets,
 * within 5 feet of each other and within reach. A separate attack roll for each target.
 *
 * Setup : Item Macro on the Greataxe, mode "Macro only".
 * How   : your targets are used first. With no targets and a choice to make, a dialog lets you pick,
 *         with the reach, the candidates and your picks shown on the map.
 *         One Roll Item card with an attack block (attack, damage, APPLY) per target.
 * Uses  : item.getEnemiesWithinRange(), token.getCreatureSize(), MacroHelper.selectTargets(), item.rollItem()
 */

const enemies = item.getEnemiesWithinRange();
if(!enemies.length) return ui.notifications.warn(`${item.name}: no target in reach.`);

// How many targets the group allows : any Large or bigger = 1, any Medium = 2, all Small or smaller = 3
const numberAllowed = group => {
  const sizes = group.map(t => t.getCreatureSize()?.value ?? 2);
  if(sizes.some(s => s >= 3)) return 1;
  if(sizes.some(s => s === 2)) return 2;
  return 3;
};

const group = await MacroHelper.selectTargets(enemies, {
  numberAllowed,
  within : 5,          // feet between the targets
  setTargets : true,   // make the group your targets
  prompt : true,       // let the player choose when they have no targets
  origin : item,       // whose reach to show on the map
});
if(!group.length) return;   // chooser closed : no attack

return item.rollItem({ count : group.length, event : scope.event });
