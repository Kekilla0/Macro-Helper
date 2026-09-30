/**
 * Item helpers.
 * Updating an item on an unlinked token (a split copy, most monsters) rebuilds the token's items, so the Item you
 * held is stale afterwards : these helpers return the fresh one to keep using.
 */

/**
 * Update an item and return the fresh copy.
 * @param {Item} item
 * @param {object} changes
 * @returns {Promise<Item>}
 */
export async function updateItem(item, changes){
  await item.update(changes);
  return item.actor?.items.get(item.id) ?? item;
}

/**
 * Set an item's base (weapon) damage, only if it differs.
 * @param {Item} item
 * @param {object} damage
 * @param {number} [damage.number]        number of dice
 * @param {number} [damage.denomination]  die size (8 = d8)
 * @param {string|string[]} [damage.types]  damage type(s), e.g. "acid"
 * @param {string} [damage.bonus]
 * @returns {Promise<Item|null>}  the fresh item if something changed, null if it was already right
 */
export async function setBaseDamage(item, { number, denomination, types, bonus } = {}){
  const base = item?.system?.damage?.base;
  if(!base) return null;

  const changes = {};
  if((number !== undefined) && (base.number !== number)) changes["system.damage.base.number"] = number;
  if((denomination !== undefined) && (base.denomination !== denomination)) changes["system.damage.base.denomination"] = denomination;
  if((bonus !== undefined) && (base.bonus !== bonus)) changes["system.damage.base.bonus"] = bonus;
  if(types !== undefined){
    const wanted = [types].flat();
    const same = (base.types.size === wanted.length) && wanted.every(t => base.types.has(t));
    if(!same) changes["system.damage.base.types"] = wanted;
  }

  if(foundry.utils.isEmpty(changes)) return null;
  return updateItem(item, changes);
}
