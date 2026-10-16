/**
 * Berserker : Bloodied Frenzy
 *   "While Bloodied, the berserker has Advantage on attack rolls and saving throws."
 *
 * Setup : Item Macro on Bloodied Frenzy, Run on Hooks : "Before any attack roll" and "Before any saving throw".
 * Bloodied is dnd5e's own condition (its Bloodied setting must not be "None").
 */

if(actor.statuses.has("bloodied")) args[0].advantage = true;
