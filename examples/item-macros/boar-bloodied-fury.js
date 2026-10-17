/**
 * Boar : Bloodied Fury
 *   "While Bloodied, the boar has Advantage on attack rolls."
 *
 * Setup : Item Macro on Bloodied Fury, Run on Hooks : "Before any attack roll".
 * Bloodied is dnd5e's own condition (its Bloodied setting must not be "None").
 */

if(actor.statuses.has("bloodied")) args[0].advantage = true;
