/**
 * Arcane Recovery (Wizard) : after a Short Rest, recover expended spell slots with a combined level of up to half your
 * Wizard level (rounded up), none of 6th level or higher. Once per Long Rest.
 * Natural Recovery (Circle of the Land Druid) works the same way : set CLASS to "druid".
 *
 * Setup : Item Macro on the feature, mode "Macro only" (the macro spends the feature's use itself).
 * Uses  : actor.recoverSpellSlots() : a dialog of spent slots with the running total, then restores them
 */

const CLASS = "wizard";

const level = actor.classes?.[CLASS]?.system.levels ?? actor.system.details?.level ?? 1;
return actor.recoverSpellSlots({
  levels : Math.ceil(level / 2),
  maxLevel : 5,
  item,
});
