/**
 * Pseudopod : damage dice follow the creature's size, so each Split hits for less.
 * Large 2d8, Medium 1d8, Small 1d4, all acid. Pairs with split.js (which lowers the size on each split).
 *
 * Setup : Item Macro on the Pseudopod, mode "Macro, then Default" : sets the dice, then the attack rolls as normal.
 * Needs : the Pseudopod's damage as its base (weapon) damage only, no extra damage parts on the attack activity.
 * Uses  : actor.getCreatureSize(), item.setBaseDamage()
 */

const TYPE = "acid";
const DICE = {
  lg  : { number : 2, denomination : 8 },
  med : { number : 1, denomination : 8 },
  sm  : { number : 1, denomination : 4 },
};

const dice = DICE[actor.getCreatureSize()?.key];
if(!dice) return;   // a size not in the table : leave the damage as it is

// Only updates when something is different, returns the fresh item if it did
const fresh = await item.setBaseDamage({ ...dice, types : TYPE });
if(!fresh) return;  // already right : attack as normal

// On unlinked tokens the update rebuilds the item, so `item` is stale : attack with the fresh one instead
await fresh.use(scope.usage ?? {}, scope.dialog ?? {}, scope.message ?? {});
return false;       // the fresh item attacked, skip the stale one
