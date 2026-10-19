/**
 * Sweep (a greataxe's homebrew property) : one attack roll against each of up to 3 creatures within 5 ft of each
 * other, or only 1 if any of them is Large or bigger.
 *
 * Setup : Item Macro on the weapon, mode "Macro only".
 * Uses  : item.pickTargets() (a group pick on the map : range, how many, how close together),
 *         item.roll({ targets }) (the normal use at those targets : one attack each, no pick)
 */

const targets = await item.pickTargets({
  count : 3,
  within : 5,                                                        // feet between the creatures
  numberAllowed : group => group.some(t => !t.isSmaller("medium")) ? 1 : 3,
});
if(!targets.length) return;              // Esc : nothing used

return item.roll({ targets });
