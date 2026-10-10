# Macro Helper

Small reusable helpers for macros, item macros, hook macros and one-click roll cards for Foundry VTT.

- **Foundry:** v14 (verified 14.368)
- **System:** Helpers, Item Macro and Hook Macros work in any system. Roll Item and the size, status and damage helpers need dnd5e 6.x.
- **Recommended:** [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper)

## Install

In Foundry's **Add-on Modules** tab, click **Install Module** and paste this manifest URL:

```
https://github.com/Kekilla0/Macro-Helper/releases/latest/download/module.json
```

## Settings and System Automation

**Configure Settings → Macro Helper** has one sub-menu per feature: **My Settings**, **Helpers**, **Item Macro**, **Hook Macros**, **Roll Item**, **System Automation** and **Roll Requests**. **Roll Item** rolls an item from its own data; **System Automation** is every rule the module applies, with its own **Enable** switch (off turns all of them off at once, Roll Item keeps working), **Rule Limits** and **Rule Fixes**, and buttons opening its pages: **Rules** (conditions, vision, masteries, default actions), **Characters** (classes, species, feats, spells), **Equipment** (Hands, held light, ammunition), **Combat** (initiative, summons, instant areas) and **Homebrew**. Rules that work on dnd5e's own rolls (conditions, Hands, initiative, rests) keep working with Roll Item off; the ones that live on Roll Item's card (smite and Sneak Attack buttons, Hunter's Mark's die, Graze...) need it. Settings are the GM's and apply to everyone, on pages only the GM opens. Each user's own choices are on **My Settings**: **Pick Targets**, **Main Hand** and the Item Macro **Button in Title Bar**, each shown only while the GM has its feature on (Roll Item, Hands, Item Macro; for players the title bar button also needs *Allow Players to Edit*). For the GM, My Settings also has a **Server Settings** section: a button for each of the other pages. **Debug** stays in Configure Settings itself.

**Rule Limits** (System Automation: Off, Warn, Block; default *Warn*): one setting for everything the rules don't allow. *Warn* gives a notice and lets it happen, *Block* stops it, *Off* checks nothing.

**Rule Fixes** (System Automation: Off, Offer a Fix, Fix Automatically; default *Off*): when changing something meets the rule: a weapon put in hand or equipped, hands freed for it, a Versatile weapon held one-handed, a Druid leaving Wild Shape (its Bonus Action) to cast a spell, an item ticked Equipped with full hands held in the main hand. *Fix Automatically* makes the change without asking. *Offer a Fix* asks: the Druid and the Equipped tick get a window (**Fix**, **Go ahead** when Rule Limits allows it, **Cancel**); an attack gets a card for the creature's owners with a **Fix** button to use before rolling again, while the attack itself follows Rule Limits. *Off*: Rule Limits decides. What no change can fix (Loading, Light, Rage...) always follows Rule Limits. A world on the old *Change* becomes *Block* with *Fix Automatically*. It covers the weapon handling below, Rage (no spells; not starting in heavy armor), Reckless Attack off your turn, Savage Attacker and Cleave once a turn, Cleave melee only, the Grapple / Shove / Push size limits, spells in a Wild Shape form, Weapon Mastery changes made on the sheet, Interception's and Protection's requirements, and **Reroll** buttons (Roll Item's cards, dnd5e's check and save messages, request cards: a free reroll isn't in the rules; the GM always may). Each time one comes up on *Warn* or *Block*, the GM gets a whispered table like the equipment log: **Round** (or the time out of combat), **Who**, **Did**, **Status** (allowed, stopped, or past the rules on purpose) and **Rule**.

**Weapon handling** (part of Rule Limits): weapon properties are applied from the weapon's data, following dnd5e's **Rules Version** setting (Modern 2024 / Legacy 2014). Like the other settings here, they apply to every attack roll.
- **Heavy:** disadvantage below STR 13 (melee) or DEX 13 (ranged). With 2014 rules, Small and Tiny creatures instead.
- **Versatile:** two-handed when the other hand is free (no shield and no other weapon equipped), otherwise one-handed. The card shows which was used.
- **Allowed-use checks:**
  - A character's weapon must be equipped. Natural weapons and Unarmed Strike always count as in hand.
  - Two hands: a Two-Handed weapon (a bow, a greatsword) takes both, and any other weapon or a shield takes one. What else is equipped has to leave room for the weapon being used.
  - One Loading shot per turn.
  - The off-hand (extra) attack: only with a Light weapon, after an attack with a different Light weapon that turn (dnd5e leaves out the ability modifier unless it's negative; Two-Weapon Fighting adds it back; with Hands, the weapon must be in the off hand). With Pick Targets, the mode is chosen for you: with Hands, a Light weapon in the **off hand** always attacks in Off-hand mode (in the main hand, a normal attack); without Hands, a Light weapon attacks in Off-hand mode once a different Light weapon has attacked this turn (out of combat, within the last minute). The Bonus Action it costs waits for the action tracker.
  - Loading and Light are only tracked in combat.
  - Range: with no map pick (Pick Targets off, or Roll Item off), a target beyond the weapon's reach (melee), its long range (ranged) or its long thrown range (a weapon that can be thrown). With a pick, the pick holds to the range itself.
- **Handling:**
  - *Warn* lets the roll happen.
  - *Block* stops it.
  - *Change* fixes what can be fixed, then rolls: it equips the weapon, puts away what's in the way (two-handed weapons first, then other weapons, then shields), and holds a Versatile weapon one-handed when the other hand is busy. Loading and Light can't be fixed, so they warn.
  - *Off* turns all of the above off, Heavy included.

**Species** and **Feats** (System Automation → Characters, separate switches, on by default): traits and feats dnd5e has no data for, recognised by the item's identifier. Species covers Brave, Fey Ancestry and Dwarven Resilience; Feats covers the rest, the Fighting Styles included. **Spells** (on by default) covers Find Familiar so far.
- **Brave** (Frightened), **Fey Ancestry** (Charmed) and **Dwarven Resilience** (Poisoned) give advantage on saves rolled from a card whose activity applies that condition.
- **Fighting Styles** (found as `dueling` or, taken through the class feature, `fighting-style-dueling`):
  - *Archery:* +2 to attacks with Ranged weapons only; a thrown melee weapon (a Javelin) doesn't get it. The compendium's feat has no always-on effect (the module adds the +2); with Plutonium's own copy, the +2 is taken off a thrown melee weapon.
  - *Defense:* Plutonium's +1 AC, only while you wear light, medium or heavy armor (its effect switches off and on as armor is equipped).
  - *Dueling:* +2 damage only with a melee weapon in one hand and no other weapon equipped (a shield is fine). A Versatile weapon is used one-handed when you have Dueling. Plutonium's always-on +2 is taken off attacks that don't qualify.
  - *Great Weapon Fighting:* with a melee weapon held in two hands (Two-Handed, or Versatile used two-handed), 1s and 2s on the attack's damage dice count as 3.
  - *Thrown Weapon Fighting:* +2 damage on a ranged attack with a Thrown weapon.
  - *Two-Weapon Fighting:* the Light weapon's extra attack (off-hand) adds the ability modifier dnd5e leaves out.
  - *Blind Fighting:* Plutonium's Blindsight 10 ft; the vision rules use it.
  - *Unarmed Fighting:* your own Unarmed Strike does 1d6 + STR bludgeoning, 1d8 holding no weapon or shield (the feat's extra attacks aren't needed; it wins over Tavern Brawler). At the start of your turn in combat, a card offers 1d4 to each creature you grapple, through the feat's Grappled Damage (the GM applies it).
  - *Interception:* when an attack hits a creature within 5 ft of yours, the attack card gets **Intercept** for you: 1d10 + Proficiency (its dice shown, no chat message of its own), a note on the card says how much less that creature takes, and the damage applied to it from that card is that much lower.
  - *Protection:* when a creature within 5 ft of yours is attacked, the card gets **Protect** (hover it for who shields whom; not when the attack already had disadvantage, which doesn't stack): a second d20 is added and the lower kept (Disadvantage, after the roll rather than before), and until the start of your next turn you're **Protecting** it (the mark is on you, not on it): attacks against it have Disadvantage while you're within 5 ft with a shield.
  - Interception and Protection shield a creature on your side from one that isn't (never your ally's attack on an enemy), and need you to see the attacker and hold a shield (Interception: or a Simple / Martial weapon); Rule Limits decides (*Warn*: the button with a notice, *Block*: no button).
- **Savage Attacker:** each weapon hit gets a button for its owner that rolls the damage again. Each roll has its own APPLY, and applying one hides the other. Once per turn in combat.
- **Alert:** right after the character's initiative is rolled, their player and the GM get a card listing allies in the combat (not those on the same initiative: the swap would change nothing). Clicking one asks that ally's player to agree, then the GM swaps the two initiatives. There's no question when you own both characters or no other player owns the ally. **Do not swap** closes the offer. It isn't available while either of them is Incapacitated, and the offer closes once a turn passes.
- **Lucky:** after an attack roll, the attacker's owner can spend a Luck Point to roll a second d20 and keep the higher. The owner of an attacked Lucky character can spend one to roll a second d20 and keep the lower; the GM carries that out, since it changes someone else's card. Advantage and disadvantage don't stack, and they cancel. If the new die changes whether it's a crit, the damage is rerolled to match.
- **Tavern Brawler:** your Unarmed Strike's own damage becomes 1d4 + STR, rerolling 1s (Enhanced Unarmed Strike and Damage Rerolls), unless it already rolls a die (a Monk's Martial Arts). Once per turn, an Unarmed Strike hit also gets a GM button to push the target 5 ft (homebrew obstacle rule included).
- **Healer:**
  - *Healing Rerolls:* 1s on a spell's healing dice are rolled again.
  - *Battle Medic:* using the feat picks a creature within 5 ft, reads its remaining Hit Dice (when it has several sizes, the creature's player picks which one; for an NPC or your own character, you pick), and rolls the matching "Heal dX". It needs a Healer's Kit with a use left, and spends one. The target's owner spends that Hit Die when they apply it from the card. Traits dnd5e does have data for, like Gnomish Cunning, Luck and Powerful Build, work through dnd5e as usual.

**Conditions** (System Automation → Rules, default *Full*; *Attack disadvantage only* keeps just the Poisoned-style rule below): the 5e condition rules dnd5e doesn't apply to attacks.
- **Attacks against** a Blinded, Paralyzed, Petrified, Restrained, Stunned or Unconscious creature have advantage. Against a Prone one, advantage within 5 ft and disadvantage beyond (so a ranged attack on a downed character is a normal roll: advantage and disadvantage cancel). Against an Invisible one, disadvantage.
- **Attackers** who are Blinded, Prone or Restrained have disadvantage; attackers who are Invisible have advantage.
- **Auto-crit:** a hit on a Paralyzed or Unconscious creature from within 5 ft is a critical hit, and its damage rolls as one.
- **Death saves:** a character at 0 HP who takes damage fails a death save, or two on a crit. A hit of at least their max HP, or massive damage while they're still up, is three failures. Applying the same card twice adds no more failures. At three failures the character is marked Dead, in or out of combat.
- **Why advantage or disadvantage:** the browser console (F12) logs one line per attack that had either, like "Goblin, Scimitar → Downed : Advantage : target Prone, within 5 ft · Disadvantage : Heavy weapon : they cancel out". That covers conditions, long range, being threatened, Heavy, flanking, Sap, Vex, the mode you chose, and held keys. Anything else shows as "another rule". Each player's console shows their own attacks.
- **Pick map:** when the attacker's own condition gives every attack disadvantage (Prone, Blinded, Restrained, Poisoned...), the whole range shows red, with a note in the banner.

- **Automatic save failures:** a Paralyzed, Petrified, Stunned or Unconscious creature fails STR and DEX saves. Its row skips the roll and shows "Auto-fail (Paralyzed)" with Apply sized as a failure. A Grapple card grapples it straight away.
- **Dodging:** attacks against a Dodging creature have disadvantage, if it can see the attacker (Vision Rules). dnd5e already gives the DEX save advantage.
- **Stable:** a Stable creature makes no death saves. It stops being Stable when it takes damage or regains HP.

**Vision** (System Automation → Rules, default *Full sight*; *Conditions only* counts Blinded and Invisible but not walls or light): attacking a creature you can't see has disadvantage, and attacking one that can't see you has advantage (a Dodging creature only gets its disadvantage against an attacker it can see). It also decides who can help with Sneak Attack, Interception and Protection, and who the map pick offers. It uses each token's own sight, the way Foundry works it out: walls, light and darkness, darkvision and other senses, Blinded and Invisible. When the GM attacks with an NPC, it's what the NPC sees, not what the GM's screen shows. This follows the 2024 rules: dim light (Lightly Obscured) changes nothing for attacks; darkness without darkvision (Heavily Obscured: Blinded for seeing into it) gives the disadvantage and advantage; darkvision sees darkness as dim light within its range. Not automated: an obscuring area only counts where the scene blocks sight (a wall, a darkness source), so a Fog Cloud or Darkness template on its own doesn't; and the Lightly Obscured disadvantage on Wisdom (Perception) checks to see is the GM's (a check doesn't say what it's looking at).
- **Picking targets:** you can't pick a creature your token can't see. Areas (Fireball, Burning Hands) aren't limited.
- **Attacks:** attacking a creature you can't see has disadvantage, and attacking one that can't see you has advantage. The console log line says which.
- **Threatened** (ranged attacks within 5 ft of an enemy) and **Dodging** both need that creature to see you.
- A token with sight turned off (or a scene without token vision) still follows the conditions: it sees nothing while Blinded, and never sees an Invisible creature. Otherwise it sees everything, with a warning in the console so you can spot tokens missing vision.

**Dash, Disengage, Dodge & Help** (System Automation → Rules → **Default Actions**, on by default, which also covers Grapple and Shove; a creature also needs the item): items in Macro Helper's **Actions** compendium (filled from [examples/items](examples/items) the first time the GM loads the world), recognised by identifier. Each activity carries its own text, so the card shows only the one used:
- **Dash:** Dashing until the end of the turn (extra movement equal to your Speed, for the action tracker).
- **Disengage:** Disengaged until the end of the turn (your movement doesn't provoke Opportunity Attacks).
- **Dodge:** Dodging until the start of your next turn.
- **Help** asks which of its three activities:
  - *Assist Attack:* pick an enemy within 5 ft. The next attack roll against it by one of your allies (not you) has advantage. The mark goes on the enemy through the GM (a **Mark (enemy)** button on a card); it ends when used, or at the start of your next turn.
  - *Assist Check:* choose one of your skill or tool proficiencies from a list, then pick an ally within 30 ft who can hear you (not Deafened). Their next check with it has advantage, once the GM's **Help (ally)** button gives it to them (unless you own the ally). It ends when used, or at the start of your next turn; out of combat, only when used.
  - *Stabilize:* pick a creature at 0 HP within 5 ft and roll WIS (Medicine) against DC 10. On a success it's Stable (on a creature you don't own, or when the GM does it, the GM's **Stabilize** button on a card does it); a reroll of the Medicine check that passes counts too.
  - *Healer's Kit:* its **Stabilize** (2024: a use, no check) picks a creature at 0 HP within 5 ft first (nobody there: nothing is spent), then spends the use and the creature is Stable (the GM's button for a creature you don't own).
  - The choice and the pick come first, so the card targets who was picked and says what for ("Assist Check: Bob has advantage on their next Athletics check"), on dnd5e's own card too.
- [examples/items/unarmed-strike.json](examples/items/unarmed-strike.json) is dnd5e's 2024 Unarmed Strike with separate Damage, Grapple and Shove activities.

**Equipment changes in combat** (with Rule Limits on): equipping, unequipping, adding an equipped item or deleting one during a running combat whispers the GM a short table: **Round** (two digits, and whose turn it is), **Who**, **Equipped** (the item), **Status** (Equipped, Unequipped or Removed) and, for armor and shields, **Time** in bold: the 2024 time it takes (light 1 / 1 min, medium 5 / 1 min, heavy 10 / 5 min to don / doff; a shield a Utilize action). Nothing is blocked.

**Elevation:** distances count the height gap between tokens from their elevation, which you set by hand for flying or climbing. Each token is as tall as it is wide, so a Medium creature flying 5 ft up is still adjacent to one on the ground, and one 30 ft up is out of a sword's reach.

**Classes** (System Automation → Characters, on by default): class features at levels 1-2, on top of what the items' own data does. Edits Plutonium's items need are listed in [docs/plutonium-notes.md](docs/plutonium-notes.md). So far:
- **Barbarian, Rage:** dnd5e's Rage effect already gives the resistances, the STR advantage and the Rage damage. The module adds:
  - *Turning it on:* using Rage turns its effect on and ends your Concentration. Using it again while raging extends it without spending a use (the Bonus Action extension).
  - *Rage damage:* only on attacks using Strength. A DEX melee attack doesn't get it, and a STR thrown attack does.
  - *How long:* until the end of your next turn. On each of your turns, an attack roll against an enemy, or posting a card that makes an enemy save (Grapple, Shove, any save aimed at an enemy), keeps it going. Otherwise it ends at the end of that turn, with a chat line saying why. Out of combat, dnd5e's 10 minutes apply.
  - *Ends early:* when you're Incapacitated, equip heavy armor, or the combat ends. You can't start a Rage in heavy armor.
  - *No spells:* casting a spell while raging is refused.
- **Barbarian, Danger Sense:** no DEX save advantage while Incapacitated. The save hover now names advantage from item effects ("Advantage : Danger Sense").
- **Barbarian, Reckless Attack:** dnd5e's item has no activity, so run [upgrade-items.js](examples/item-macros/upgrade-items.js) on the character (it copies from the Actions compendium): it gives their own Reckless Attack the activity and keeps it under Barbarian. Using it on your turn makes you Reckless until the start of your next turn: your STR attacks have advantage and attacks against you have advantage. The attack pick map colours follow.

- **Bard, Bardic Inspiration:** nothing is rolled when you inspire (Roll Item skips Inspire's formula, which only names the die). *Inspire* marks the creature you pick (not yourself; one die at a time) as Inspired with your die (d6 at levels 1-2) for an hour, with dnd5e's own **Apply** on the card's effect (the GM's, for a creature its player doesn't own). When that creature fails a D20 Test, its owner gets a 🎵 **Bardic Inspiration (+1d6)** button: on a missed attack (attack card), a failed save (card row or sheet) or a failed check from the sheet. When no DC is known, the button shows anyway. Clicking rolls the die, adds it to the roll (the card re-judges it) and removes the mark. Expertise and Jack of All Trades are dnd5e's own (2024 Jack of All Trades only adds to skill checks).

- **Cleric:** Thaumaturge's Arcana / Religion bonus, Channel Divinity's uses and Divine Spark are the items' own data.
  - *Divine Spark (damage):* Roll Item asks **necrotic or radiant** before rolling (any damage that offers a choice of types does, like Chromatic Orb; the last choice comes first).
  - *Turn Undead* (its own item, or the Turn Undead use on dnd5e's Channel Divinity): no template to place and no pick. A 30 ft circle appears round the Cleric (removed at the end of the turn), and every Undead in it (not on the Cleric's side) becomes the targets and saves on its row. The GM applies **Turned** to those that fail with the row's **Apply effect** button. Turned ends early when that creature takes damage, or when the Cleric is Incapacitated or dies. Moving away is left to the table.

- **Druid:** Druidic and Primal Order are the items' own data. dnd5e's Wild Shape keeps your HP and features, gives temp HP equal to your Druid level, and leaves your spells behind, so you can't cast while shifted.
  - *Spells while shifted:* a spell cast from your own sheet while your form is out, or Wild Companion from the form, follows **Rule Limits** (spells dnd5e keeps on the form, Circle of the Moon's, are fine). On *Change* you're asked to leave the form (your Bonus Action) and cast; *No* casts nothing. In combat, a Bonus Action spell can't follow leaving the form, so it's stopped.
  - *Forms:* drag the Beasts players can become into Macro Helper's **Wild Shapes** compendium. Only the ones the Druid's level allows are offered (CR ¼, no fly speed at level 2), checked from each actor's own data.
  - *Known forms:* chosen from that folder, up to the class's Known Forms (4 at level 2). Adding is free up to the limit; replacing a known form needs a Long Rest (one swap, from **Rest Choices**). The GM can change them freely.
  - *Room for it:* a bigger form spreads where there's space around the Druid (centred first, any direction, not through creatures, walls or the scene's edge). If it can't fit anywhere, you're told before anything is spent. Leaving the form puts the Druid back where it fits.
  - *Using Wild Shape:* pick one of your known forms and you take it straight away, with no chat button (**Known Forms** on the picker changes the list). The GM's client does the transform, since players can't create actors, on whichever scene the Druid is.
  - *Using it again while shifted:* **Leave form** (the Bonus Action, nothing spent) or **New form** (spends a use).
  - *How long:* the form carries a **Wild Shape** effect lasting half your Druid level in hours. It ends on its own when that time is up (a rest at least as long as the time left counts: any rest at levels 2-3), or when you're Incapacitated or die; Incapacitated, Unconscious or Prone carry over to the Druid. Uses spent while shifted are kept when the form ends.
  - *Familiars:* Wild Companion (Classes switch), Find Familiar (Spells switch) and Pact of the Chain (Classes switch) pick from Macro Helper's **Familiars** compendium (Pact of the Chain adds its special forms), then you click an empty space within 10 ft on the map, with no wall in the way. The square under the mouse shows yellow, or red where the familiar can't go. The token appears there on your side and owned by you, with its attacks removed (a familiar can't attack; an attack added later, like a macro's Unarmed Strike, is removed too). A Pact of the Chain Warlock's familiar keeps its attacks. Not while in a Wild Shape form (it casts a spell). With the compendium empty, dnd5e's own summoning is used.
    - *Using it again:* asked before dnd5e's choice of paying with a spell slot or Wild Shape. With a familiar out, choose **Store** (kept exactly as it is now: HP, conditions), **Summon New** (casts again, replacing it) or **Release**. With one stored, choose **Bring It Back** (an empty space within 30 ft, as it was) or **Summon New**. Store, Release and Bring It Back spend nothing.
    - *0 HP:* it disappears; only a new casting brings one back.
    - *Long Rest:* Wild Companion's familiar disappears, stored or not, and its player gets a whisper saying so.

- **Fighter:** Second Wind is the item's own data.
  - *Weapon Mastery:* Plutonium never asks which weapons, so they're chosen in **Rest Choices**: up to the class's count (Fighter 3 at level 1; Barbarian, Paladin, Ranger, Rogue 2; a multiclass character uses the highest), from what the classes allow (Fighter, Paladin, Ranger any Simple or Martial; Barbarian melee; Rogue Finesse or Light). Adding up to the count is free any time; replacing one needs a Long Rest. Changes made on the sheet that break this follow Rule Limits.
  - *Action Surge:* using it marks you (Action Surge) until the end of this turn, for the action tracker's extra action.
  - *Tactical Mind:* on a failed ability check (a DC from dnd5e's roll request, `[[/check skill=athletics dc=15]]`, lets it tell), your **Tactical Mind (+1d10)** button adds the die to the check without spending anything. If it then succeeds (or there's no DC to tell), the GM gets **spend a Second Wind use** on the message.
  - *Fighting Style:* gaining a Fighter, Paladin or Ranger level allows one swap in **Rest Choices**, from Macro Helper's **Fighting Styles** compendium (drag Plutonium's in, Blessed Warrior and Druidic Warrior too). The new feat goes under the class's features on the sheet (Plutonium's own choice sits in Other Features). Any Fighting Style feat is open to all three classes; Blessed Warrior is the Paladin's own option and Druidic Warrior the Ranger's.

- **Monk:** Unarmored Defense is dnd5e's own AC. Works with dnd5e's own Monk (one *Monk's Focus* item holding the Focus Points, with Flurry of Blows, Patient Defense and Step of the Wind as its uses) and with separate items (Plutonium's *Focus Point*, *Flurry of Blows*...).
  - *Martial Arts:* while you wear no armor and hold no shield, an Unarmed Strike or Monk weapon (Simple melee weapons, Martial melee weapons with Light) uses the better of STR and DEX, and your Martial Arts die instead of its own when that's bigger (dnd5e's own Unarmed Strike, "1 + modifier", loses the flat 1 to the die). The weapon itself changes, so the sheet, the card and the roll all show it (Plutonium's Martial Arts enchantment isn't needed); put on armor or take a shield and it's back to normal. The bonus Unarmed Strike waits for the action tracker.
  - *Flurry of Blows:* spends a Focus Point and uses your own **Unarmed Strike** two times (three from Monk level 10), each one Attack, Grapple or Shove, with its reach and Martial Arts. The second strike's window opens once the first one's card is done (dice landed, result shown), so you choose it knowing how the first went. Closing the first gives the point back.
  - *Patient Defense:* the free use marks you Disengaged; with a Focus Point, Disengaged and Dodging (the Default Actions' marks, put on instead of the item's own effects: dnd5e's carries a Dodging that never ends). The card's effect buttons are greyed out, since they're already applied.
  - *Step of the Wind:* like Patient Defense: the free use marks you Dashing; with a Focus Point, Dashing and Disengaged. Plutonium's item (one Focus Point activity and uses of its own) gets the free activity and loses its own uses when it's added (and once when the GM loads, for characters already made).
  - *Unarmored Movement:* its speed only counts while you wear no armor and hold no shield.
  - *Uncanny Metabolism:* while its use is left, your initiative roll has an **Uncanny Metabolism** button at its foot (you and the GM): it uses the item (Focus Points back, the healing roll), and the button then shows greyed on that roll for both of you.

- **Paladin:** Weapon Mastery and the Fighting Style work as for the Fighter (Rest Choices).
  - *Smite:* after a melee weapon or Unarmed Strike hit (not a throw), the attack card has a **Smite** button for you. It lists the smite spells you have prepared (Divine Smite, Wrathful, Thunderous, Searing...) with what can pay: **Paladin's Smite** (Divine Smite only, free once per Long Rest: the use on the item, or with dnd5e's own on the Divine Smite it grants, so the sheet shows it spent; counted by the module when there's none anywhere) or a spell slot of the spell's level or higher. The damage goes on the card in its own box, with its own Apply, doubled on a crit. Divine Smite deals 2d8 Radiant, +1d8 per slot level above 1st, +1d8 against a Fiend or Undead. Wrathful (Frightened) and Thunderous (pushed, Prone) put their saving throw on the card for the creature hit; a creature that fails Thunderous's gets a **Push** button for the GM. The 2024 smites don't need Concentration. Searing Smite's burning each turn waits for the spell batch. Once per attack; a second smite in a turn (a Bonus Action) follows **Rule Limits**. Using a smite spell or Paladin's Smite from your sheet smites your latest melee hit, or tells you there's none. Needs Roll Item's attack card.
  - *Lay on Hands:* both uses reach a creature you touch, picked on the map. **Remove Poison** ends Poisoned on a creature you own (the card's buttons grey out); on anyone else, or when the GM uses it, the GM gets **End Poisoned** on the card.

- **Ranger:** Weapon Mastery and the Fighting Style work as for the Fighter (Rest Choices). Works from the items' identifiers, whoever made them.
  - *Hunter's Mark:* using the spell (or Favored Enemy) asks how to pay (a free **Favored Enemy** use, or a slot), then the creature to mark within 90 ft. You pay and concentrate at once; the chat card gives the GM a **Mark (creature)** button that puts the mark on it (an effect); the mark ends with that Concentration (1 hour; 8 hours with a level 3-4 slot, 24 with level 5+). Every attack at the marked creature rolls **1d6 Force** in its own box on the card (hit or miss, so the die doesn't give a miss away; its Apply only shows on a hit; doubled on a crit). When the marked creature drops to 0 HP you're told; using Hunter's Mark again then moves the mark (no slot or use; the GM's **Move the mark** button on its card).
  - *Favored Enemy:* its free castings are the item's uses when it has them, otherwise counted by the module (2 at levels 1-4, 3 at 5-8, 4 at 9-12...), back on a Long Rest.

- **Rogue:** Expertise and Thieves' Cant are the items' own data; Weapon Mastery works as for the Fighter (Rest Choices). Works from the items' identifiers and the class's Sneak Attack scale, whoever made them.
  - *Sneak Attack:* on a hit with a Finesse or ranged weapon that had advantage, or with one of your allies (not Incapacitated) within 5 ft of the target, and no disadvantage, the card has a **Sneak Attack** button for you. It rolls your Sneak Attack die (1d6 at levels 1-2; the weapon's damage type; doubled on a crit) into a box of its own. Rolling isn't using it: your once a turn counts when that box's damage is applied to a creature. Applying another one that turn follows **Rule Limits**, and the button stops showing on later hits that turn. Using Sneak Attack from your sheet puts it on your latest qualifying hit.
  - *Cunning Action:* Dash and Disengage mark you like the Default Actions. **Hide** needs you Heavily Obscured or behind three-quarters or total cover, out of enemies' sight, so it asks the GM first: a card (for the GM and you) names the enemies whose tokens can see you, and the GM clicks **Allow** or **Deny**. Nothing is used yet, so a denied Hide costs nothing. Allowed, you get **Roll Stealth (DC 15)**, which uses Hide then; 15 or more (a reroll counts) makes you Invisible until the GM ends it.

- **Sorcerer:** Works from the items' identifiers, whoever made them.
  - *Font of Magic:* using it opens a window with two rows of slot levels. **A spell slot into Sorcery Points**: each level you have a slot left of, with the points it gives (never past your maximum). **Sorcery Points into a slot** (2024): each level 1-5 you have slots of, with what it costs (2 / 3 / 5 / 6 / 7), from Sorcerer level 2 / 3 / 5 / 7 / 9 (a level you can't make yet shows the Sorcerer level it needs). A full level works too: the slot you make goes on top (5 / 4) and vanishes when you finish a Long Rest; the window says how many you're holding. Click one to convert.
  - *Innate Sorcery:* using it puts its effect on you at once (+1 spell save DC, for a minute on the world clock: 10 combat rounds; it's removed when the minute is up). The +1 is only for Sorcerer spells: dnd5e gives it to every spell, so the module takes it back off the others (a species' or feat's spell). While it's on, your attack rolls with Sorcerer spells have advantage (the pick map shows it too).
  - *Metamagic swap:* gaining a Sorcerer level allows replacing one option per level, in the level-up window: which one goes, then which comes. The new options come from your Item compendiums: a copy you imported (Plutonium's, in any compendium of yours) comes before dnd5e's own 2024 option, and 2014 copies are left out. The new one takes the old one's place under the class.
  - *Metamagic:* casting a spell (any spell you have, as 2024 Metamagic changes "spells you cast") when you know Metamagic options and have the Sorcery Points asks which option to use, or none. Only the options that fit the spell and that you can pay for are offered. The card shows the option under the spell's description, laid out like the spell: its own header (name, cost, Transmuted's damage type) with its description folding under it, both following **Card Descriptions**. The attack and damage follow on the same card. Its points are spent once the cast goes through (closing the pick, or nobody in range, costs nothing).
    - **Careful Spell / Heightened Spell:** toggles on the save card's rows, for the caster's owner. Careful: up to your CHA modifier (at least one) succeed without rolling and take no damage where a success would take half. Heightened: one creature, its save against the spell has disadvantage (the save button's hint names it).
    - **Distant Spell:** doubles the range you pick within, attack spells included (Touch becomes 30 ft).
    - **Empowered Spell / Seeking Spell:** buttons on the card after the roll, usable alongside another option. Empowered rerolls your lowest damage dice (up to your CHA modifier, at least one), once a card. Seeking rerolls a missed spell attack's d20. The new rolls are kept. Once used, each shows on the card like the others.
    - **Extended Spell:** its Concentration and the effects it puts on creatures last twice as long (24 hours at most), and its Concentration saves have advantage.
    - **Quickened Spell:** recorded as a Bonus Action casting. Under **Rule Limits**, no level 1+ spell after it that turn, and no Quickened after one.
    - **Subtle Spell:** recorded as no components (for the action tracker and spell components later).
    - **Transmuted Spell:** asks which type the damage becomes (acid, cold, fire, lightning, poison, thunder).
    - **Twinned Spell:** one more creature in the pick (the spell's effective level +1). For now it's offered on any level 1+ spell without an area; it will be limited to the spells that gain a target when cast higher once spells get their list.
- **Warlock** (levels 1-2): works from the items' identifiers, whoever made them. Pact Magic's slot is dnd5e's own (back on a Short Rest); a Warlock's prepared spells are in Rest Choices' **Prepared Spells** (Pact Magic spells count).
  - *Hex:* handled like Hunter's Mark (none of the spell's own activities are used): using it asks how to pay (a slot or the Pact slot), which ability's checks it hinders, and the creature (90 ft, on the map). You concentrate at once (1 hour; a level 2 slot 4 hours; 3-4 8 hours; 5+ 24 hours), and the GM's button curses the creature: an effect giving disadvantage on that ability's checks, its data on the effect (`flags["macro-helper"].hex`: caster, spell, ability). Every attack at it rolls 1d6 Necrotic onto your attack card (its Apply on a hit, doubled on a crit). The curse ends with the Concentration; casting it again moves it; with the creature at 0 HP, using Hex again moves it (no slot).
  - *Pact of the Blade:* your pact weapon attacks with the best of its own ability (STR, or DEX for Finesse) and CHA, and deals its normal damage type; the attack card offers **Necrotic**, **Psychic** or **Radiant damage** instead (buttons for you), so there's no question on every attack. **Forge Pact Weapon** asks: bond a weapon (dnd5e's card: drop it there), or **conjure** one: a Simple or Martial melee weapon from your Item compendiums (the standard weapons, not magic ones), in your hand (with Hands: a free hand, else the main hand). One pact weapon at a time: forming another ends the last (a conjured one disappears, a bonded one loses the enchantment).
  - *Pact of the Chain:* its summons (and its Find Familiar, cast as a Magic action) spend no spell slot. The familiar is the module's (see Familiars), with the special forms too (Imp, Pseudodragon, Quasit, Sphinx of Wonder, Skeleton, Slaad Tadpole, Sprite, Venomous Snake), and it keeps its attacks.
  - *Pact of the Tome:* a **Book of Shadows** item on the Warlock. The spells Plutonium adds with the invocation go into it and leave with it (deleting the book deletes them; losing the invocation, the book). Rest Choices' **Book of Shadows** row: a new book when it's gone, its empty places filled from your Item compendiums (3 cantrips and 2 level 1 Rituals, any class, ones you don't have), and one spell replaced per Warlock level gained, the GM's changes counted too (past that: Rule Limits for players; the GM is asked first). Book spells don't count against the Warlock's prepared spells.
  - *Invocations on a cantrip* (Agonizing Blast, Repelling Blast, Eldritch Spear): picking one asks which of your known Warlock cantrips it goes on (Agonizing: one that deals damage; Repelling: one with an attack roll; Spear: damage and a range of 10 ft or more; a single fit is taken without asking) and puts the invocation's enchantment on it: Agonizing adds CHA to its damage, Spear adds 30 ft a Warlock level to its range. One without a cantrip yet (taken before the module, or with no cantrip that fits): Rest Choices' **Invocation Cantrips** row; moving one to another cantrip needs a Warlock level gained (the GM freely; past that, Rule Limits).
  - *Repelling Blast:* each hit of its cantrip (Eldritch Blast when none carries it) on a Large or smaller creature gives the GM a button pushing it 10 ft away.
  - *Magical Cunning:* with every Pact slot there it would regain nothing: Rule Limits (Block stops it, its use kept).
  - *Devil's Sight:* a sense of its own on the token (**Devil's Sight**, 120 ft): sight that darkness doesn't stop, magical or not (a darkness source), within its range. Walls still block it and an Invisible creature still isn't seen. Vision counts it for advantage and disadvantage like any sense.
- **Wizard** (levels 1-2): works from the items' identifiers, whoever made them.
  - *Arcane Recovery:* after a Short Rest (Rest Choices: dnd5e's rest window offers it) or used from the sheet: a window to choose expended slots adding up to half your Wizard level (rounded up), none above level 5. Once a Long Rest (Plutonium's use comes back on a Short Rest: changed by an item fix).
  - *Scholar* (level 2): Plutonium writes the Expertise into the skill (its window also offers skills you aren't proficient in: pick one you are).
  - *Ritual Adept:* the rituals in your spellbook (your Wizard spells) can be cast without preparing them, as Rituals (see Spells: Rituals).
  - *Spellbook:* Plutonium adds no level 1 spells; Prepared Spells' **Add a Spell** fills it (no spellbook count yet: that comes with the spellcasting work).

- **Spells** (Characters → **Spells**), by identifier:
  - *Blade Ward:* cast, its effect goes on you (ending with its Concentration), and attack rolls against you subtract 1d4. Its "Attack Penalty" die isn't rolled on a card.
  - *Chill Touch:* a creature with its effect can't regain Hit Points: healing applied to it is stopped, with a notice (temporary HP still work). Any effect flagged `flags["macro-helper"].noHealing` does the same. It lasts until the end of your next turn.
  - *Ray of Sickness:* Poisoned on a hit, through the attack card's effect tray, until the end of your next turn.
  - *Mind Sliver:* its effect (-1d4 to saves) lasts until the end of your next turn and ends once the creature has made a saving throw: it only takes from the next one. Any effect flagged `flags["macro-helper"].nextSave` does the same.
  - *Armor of Agathys:* cast, you're marked with its Cold damage (5 a slot level) for its hour, until its Temporary Hit Points are gone. A melee attack card that hits you while you have them gets the GM's button: that Cold damage to the attacker (with a line in chat).
  - *Dancing Lights* (an item with nothing to summon, like Plutonium's): choose four lights or one glowing Medium form, then click where each goes (within the spell's range; each light within 20 ft of another; over a creature is fine; Esc after the first: no more lights). The lights are Neutral tokens (nobody's ally, so never a creature beside a target for Sneak Attack) that you own and move by hand: nothing is drawn but their light (Dim Light in a 10 ft radius), so each is just a glow you can still grab. They aren't creatures (no combat, no sheet; one "Dancing Light" actor in the summons folder stands behind them all). They end with the spell's Concentration or when you cast it again, and a light moved beyond the spell's range from you vanishes. An item that does have something to summon is left to dnd5e.
  - *Repeating effects:* effects that come back each turn carry `flags["macro-helper"].repeat`: `label` (`"start"` or `"end"` of a turn, or `"time"`: until its duration ends), `from` (the item and the caster), `roll` (save or check, ability, skill, DC from the spell's save) and `when` (start or end of whose turn: the affected creature's, unless the spell says the caster's), plus `damage` taken first (more dice with a higher slot). At that turn in combat, the GM's client posts a card with the affected creature's owner's buttons: take the damage, then roll; a success ends the effect. Hold Person and Wrathful Smite (end, WIS save), Searing Smite (start, 1d6 fire, CON save), Ensnaring Strike (start, 1d6 piercing, a STR (Athletics) check as an action), Ray of Sickness and Chill Touch (time), Sleep (end, WIS save: a failure makes it Unconscious for the rest of the spell, with no more saves; it ends when the creature takes damage).
  - *Giant Insect:* the Centipede's Venomous Spew is a CON save (one creature within 10 ft, Poisoned on a failure) against your spell save DC.
  - *Rituals:* a spell with the Ritual tag that you have prepared asks: **Cast normally** (a spell slot, a higher level allowed) or **Cast as a Ritual** (10 minutes longer, no slot, its own level). A Wizard's unprepared spellbook ritual (Ritual Adept) is cast as a Ritual without asking. The card notes it.
  - *Range:* with Rule Limits on and no map pick (Pick Targets off, or Roll Item off), a spell aimed at creatures out of its range (Distant Spell's too) follows Rule Limits.
  - The items' missing effects are added by the module (2024 items only; see the Plutonium notes).
- **Prepared spells** (all prepared casters): a **Prepared Spells** row in Rest Choices, per class: after a Long Rest for the Cleric, Druid and Wizard (any of them) and the Paladin and Ranger (one); on gaining a level for the Bard, Sorcerer and Warlock (one). Its window lists the class's spells (level 1+; always-prepared ones shown, locked) with *prepared / maximum* (the class's max-prepared scale) and the changes left. Changes count against the list as it was at the rest (those spells are marked): filling up to the maximum is always free, preparing one in place of another uses a change. The window stops at the maximum and once the changes are used (ticking an original back frees a change); a player under Rule Limits *Off* or *Warn* can tick **Change more than the rules allow**, and the GM is told. Ticking Prepared on the sheet past those limits follows **Rule Limits**. **Add a Spell** (in the window): one from the class's spell list (dnd5e's spell lists) up to its highest slot level, from your Item compendiums (your imported copies before dnd5e's own, but never a feature's copy with uses of its own; 2014 ones left out), added unprepared to tick; Plutonium doesn't add the spells a new level lets you prepare. Only spells in a compendium can be offered. Weapon Mastery and Wild Shape's known forms mark their original choices the same way.

**Compendiums** (the **Macro Helper** compendium folder): what features choose from, in one place. **Actions** (Dash, Disengage, Dodge, Help, Unarmed Strike, Reckless Attack) fills itself the first time the GM loads the world. **Wild Shapes**, **Familiars** and **Fighting Styles** are for you to fill by dragging Plutonium's creatures and feats in (unlock the compendium first: right-click it, Toggle Edit Lock). They're corrected as they land (and once when the GM loads, for anything already there), so a re-import can't bring bad data back: familiars lose their attacks; Interception and Protection lose their activity and effect (the attack card's buttons do it); Dueling loses its always-on +2; Unarmed Fighting loses its two extra attacks (keeping Grappled Damage). The same feats on a character (Plutonium's own, picked at level-up) are corrected the same way, when added and once when the GM loads. The compendiums live in the module's `packs` folder, so they're kept with the module (commit them).

**Going past the rules:** with Rule Limits on *Off* or *Warn*, the Wild Shape forms and Weapon Mastery windows have a **Replace more than the rules allow** box (swap two, or all of them; never more than the limit known), and a Fighting Style swap with none left asks whether to swap anyway. On *Warn* the GM gets a whisper only GMs see; on *Block* or *Change* there's no box.

**Rest Choices** (with the Classes switch): after a rest or a level gained, a window opens for the character's player listing what they may change, each with a **Change** button: Wild Shape forms and Weapon Mastery (one swap per Long Rest), a Fighting Style (one swap per level), Metamagic (one swap per Sorcerer level). **Level Up:** the window opens once the level-up is done, however it was done (dnd5e's advancement, Plutonium's Level Up, the sheet): when the character's total level went up, it waits until the character's items stop changing and dnd5e's advancement window is closed, then lists the choices of the classes that gained a level (a new class too). It's also always on the character sheet's header (**Rest Choices**), since adding up to a limit needs no rest. After a rest the GM ran for everyone, the macro `MacroHelper.restChoices(actor)` opens it too. dnd5e's **Short Rest** and **Long Rest** windows list the choices that rest brings, each ticked. After resting, each ticked one's own window opens in turn (the next once the last is closed), with no summary window; an unticked one isn't allowed or opened, so it stays as it was. A rest without that window (a macro) and a level gained still show the summary window.

**Initiative Messages** (System Automation → **Combat**, default *Individual*): *Compact*: instead of one chat message per combatant, one card per round lists everyone's initiative, highest first. Hover a total for its dice. The combatant's owner and the GM get a Reroll button on its row, which follows the Advantage setting and moves the combatant in the tracker. Hidden combatants go on a second card only the GM sees. Players' own initiative rolls land on the same card. Dice So Nice still shows the dice, in each player's own dice colours (the GM's for monsters). The card follows the tracker: after a swap or an edit it shows the new initiative and order (the roll stays in the hover). An **Alert** character's swap offer appears here instead of its own card: its owner gets a swap button on each ally's row, previewing where both would end up ("Bob would go 2nd (15), Aria 5th (9)"), and **Do not swap** on its own row. The buttons go once a turn passes. With dnd5e's ability score tie-breaker on, only the rolled initiative swaps: each creature keeps its own DEX decimal.

**Card Descriptions** (in **Helpers**, default *Collapsed*): every chat card, dnd5e's and Roll Item's (attack cards included, which now carry the item's description), shows its description folded for everyone, the way dnd5e's own *Collapse Item Cards in Chat* does for one player. Click the card's title to open it. It works with Roll Item off too.

**Summon Initiative** (System Automation → **Combat**, default *Roll Initiative*): summoned creatures (dnd5e's summons and familiars, also when a stored familiar comes back) join the combat their summoner is in. *Roll Initiative*: they roll their own, straight away when the combat is under way (or with everyone, with Auto-Rolled Initiative). *Shared Initiative*: they go right after the summoner, and follow when its initiative is rolled, rerolled or swapped. A summon and its summoner added to a combat by hand (or there before it began) are linked the same way. A creature imported from a compendium to be summoned goes into the **Summoned Creatures** actor folder; dnd5e reuses that copy for every later summoning, so it's imported only once.

**Initiative Method** (System Automation → **Combat**, default *Player rolled*): *Auto-rolled*: when combat begins, everyone who hasn't rolled initiative rolls, and the first turn goes to the top of the order. Anyone added to the combat later rolls as they join, without moving the current turn.

**Conditions on attack rolls** (Conditions *Attack disadvantage only* or *Full*): Poisoned gives disadvantage on attack rolls, as does Exhaustion 3 with 2014 rules and Heavily Encumbered on Strength and Dexterity attacks. dnd5e 6 lists these but only applies them to ability checks. This covers every dnd5e attack, and it works the same whether the creature has the Poisoned condition or an effect whose Statuses include Poisoned.

## Helpers

Small functions for macros, available as `MacroHelper.x(...)` or `game.modules.get("macro-helper").api.x(...)`.

| Helper | What it does |
|---|---|
| `tokenOf(thing)` | The canvas token for a token, token document, actor or item. Falls back to your selected token. |
| `actorOf(thing)` | The actor for a token, token document, actor or item. |
| `distanceBetween(a, b)` | Feet between two tokens, edge to edge on the grid, including the height gap from their elevation. Adjacent squares, diagonals included, are 5 ft. Further out it follows the **Range Shape** setting (Homebrew): *Square* (the rules: every diagonal step is 5 ft, the default) or *Circle* (true distance). |
| `canSee(viewer, target)` | Whether one token can see another by its own sight (Vision Rules): walls, light, darkvision, Blinded, Invisible. Without sight to work it out (vision off on the token or the scene), only the conditions count: Blinded sees nothing, Invisible can't be seen. Always true when the setting is off. |
| `getRange(item, { long, thrown })` | How far an item reaches: a melee weapon's reach, a ranged weapon's range, or a spell's range. |
| `pushDestination(thing, from, feet)`, `pushAway(thing, from, feet)` | Push a token straight away from another, square by square, stopping at walls and other creatures (Push mastery, Shove, Thunderwave). It's measured by the **Range Shape** setting (Homebrew). `pushAway` needs permission to move the token, and returns how many feet it moved (0 if blocked straight away). |
| `addLight(thing, light, { key })`, `removeLight(thing, { key })`, `hasLight(thing, key)` | Give a token light (`{ bright, dim, color, animation }`) and take it away again. The token's original light comes back when the last source (`key`: "light", "torch"…) is removed. |
| `getTokensInArea(area, { includeHidden, filter })` | The tokens inside a template (a Region in v14). A token counts when any square of its space is inside. |
| `getTokensWithin(origin, feet, { disposition, includeDead, includeHidden, filter, includeSelf })` | Tokens within a distance, nearest first. `disposition` is `"any"`, `"enemy"` or `"ally"`. |
| `highlightRange(origin, feet, { normal, tokens, selected })` | Shows a range on the map, on your screen only: blue within `normal`, red from there out to `feet` (long range), orange candidates and green picks. Returns `{ select, clear }`. |
| `isEnemy(a, b)`, `isAlly(a, b)` | Compares the two tokens' dispositions. |
| `getFlanker(attacker, target)`, `isFlanking(attacker, target)` | The attacker's ally flanking the target with them (DMG rule: both next to it, on opposite sides or corners), or `null`. |
| `isThreatened(thing, { range, includeIncapacitated, includeHidden })` | Whether an enemy (opposite disposition) is within 5 ft, not counting incapacitated, dead or GM-hidden ones. In 5e, ranged attacks made while threatened have disadvantage. |
| `getThreats(thing, { range, includeIncapacitated, includeHidden })` | Those creatures (Hostile or Neutral, not Incapacitated, able to see it), nearest first. |
| `getEnemiesWithinRange(item, { numberOfEnemies, range, long, thrown })` | Your targets in range first, then every other enemy in range, nearest first. |
| `selectTargets(tokens, { numberAllowed, within, setTargets, prompt, origin })` | Picks a group of targets standing within `within` ft of each other. `numberAllowed` is a number or `group => number`. With `prompt`, and no targets of your own, you choose the targets in a dialog, with the range and your picks shown on the map. **Async**, so use `await`. |
| `isValidGroup(tokens, { numberAllowed, within })` | Checks a group against those rules. Returns `{ valid, reason }`. |
| `setTargets(tokens)` | Replaces your targets. |
| `getSize(thing)` | dnd5e size, e.g. `{ key: "lg", value: 3, label: "Large" }`. |
| `stepSize(key, steps)` | Another size category, e.g. `stepSize("lg", -1)` → `"med"`. |
| `setStatus(thing, status, active, { overlay })` | Turns a condition on or off. It never flips a status that's already in that state. |
| `setDefeated(thing, defeated)` | Marks the creature defeated, or not, in the current combat. |
| `stabilize(thing)` | A creature at 0 HP: resets its death saves and makes it Stable. The GM does it when you don't own the creature. Returns true when it worked. |
| `damage(thing, value, type, { properties, multiplier, ignore })` | Damages a creature through dnd5e, so resistances, immunities and temp HP apply. `value` can be a number, a formula (`"2d6 + 3"`), or parts `[{ value, type }]`. |
| `heal(thing, value)` | Heals a creature, up to its max HP. `value` can be a number or a formula. |
| `tempHP(thing, value, source)` | Gives temp HP. The higher of the current and new amount is kept (they don't stack). `source` is recorded in `flags["macro-helper"].tempHP` when applied. |
| `dropsToZero(thing, amount)` | Whether this much damage drops a creature that's still up to 0 HP (temp HP soak first). |
| `isKilledOutright(thing, amount)` | Whether it's massive damage: what's left after reaching 0 HP is at least the creature's HP max. |
| `preventDropToZero(thing, amount, updates, { hp, massiveDamage })` | For "reduced to 0 but not killed outright" features. Use it in a `dnd5e.preApplyDamage` Hook Macro, before any `await`: it changes dnd5e's pending update so the creature stays on `hp` (1). Massive damage still kills unless `massiveDamage: false`. Returns whether it kept them up. |
| `getLastDamage(thing)`, `clearLastDamage(thing)` | The last damage a creature took through dnd5e's damage application, and the card that dealt it: `{ amount, message, at }`. For reactions that reduce damage, like Stone's Endurance. A reaction clears it once it's used it, and any rest clears it. |
| `usedThisTurn(thing, key)`, `markUsedThisTurn(thing, key)` | "Once per turn" in combat (Savage Attacker, Sneak Attack): whether it's been used this turn, and marking it used. Out of combat there are no turns, so it's never used. |
| `rollSave(thing, ability, dc)` | Rolls a saving throw against a DC, with no dialog. Returns `{ success, total, roll }`. |
| `addTimedEffect(thing, effectData, { of, until })` | Adds an effect that lasts until the start (`"turnStart"`) or end (`"turnEnd"`) of someone's next turn in combat (`of`, default the creature itself). The active GM removes it then, or when the combat ends. Made out of combat: if a combat begins with that creature in it, it lasts until its first turn there; otherwise it ends after 30 seconds of game time. The same effect (name and origin) already there lasts from now instead of being added twice. |
| `recoverSpellSlots(thing, { levels, maxLevel, item, chat })` | A dialog to choose expended spell slots to recover, up to a combined level, and none above `maxLevel` (5). Used for Arcane Recovery and Natural Recovery. With `item`, it needs a use left and spends one. Returns `{ level: recovered }`. |
| `findItem(thing, query, { type })` | One of the actor's items by name (any case), identifier, id or uuid. `query` can be several (`["Relentless Endurance", "Relentless"]`, first match wins) or a function. |
| `splitToken(thing, { copies, hp, scale, stepSize, chat })` | Replaces a token with smaller copies that share its HP (Ochre Jelly's Split). GM only. |
| `pickAndAttack(item, { count, repeat, disposition, within, long, confirm, clearTargets, strict, threatened, event })` | The whole attack in one call: clears your targets, you pick on the map, then one attack roll per pick. With `repeat`, a target can be picked more than once (Multiattack: both attacks at one foe). Fewer picks than `count` is fine: press Enter. Targets beyond reach get thrown at when the weapon can be thrown, targets at long range are attacked with disadvantage, and so are ranged or thrown attacks while the attacker is threatened (melee attacks aren't). Nobody attacks with what they don't have (quantity 0, not enough to throw or shoot) unless `strict: false`. Problems show as notifications. |
| `pickAttack(item, { count, repeat, activity, used, ... })` | The picking half of `pickAndAttack`: checks, the map pick, and the ammunition and throw checks. Returns `{ attack, targets, attackMode, disadvantage }` to pass to `rollItem`, or `null`. For when you want to pick now and roll your own way. |
| `isOtherHandFree(item)`, `hasShieldEquipped(thing)` | From what's equipped: whether the hand not holding this weapon is free (no shield, no other weapon), and whether a shield is equipped. |
| `attackModeFor(item, target, { long })` | The attack mode: Versatile weapons `"twoHanded"` when the other hand is free, else `"oneHanded"`; weapons that can be thrown, `"thrown"` beyond reach (within thrown range), otherwise the melee mode. `null` when dnd5e's usual mode is fine. |
| `isLongRange(item, target)` | Whether a target is beyond the weapon's normal range but within its long range (ranged or thrown), where 5e attacks have disadvantage. |
| `isRangedItem(item)` | Whether the item is a ranged attack by nature: a ranged weapon or a ranged spell attack. A Dagger isn't. |
| `isRangedAttack(item, target)` | Whether attacking this target is a ranged attack: a ranged item, or a thrown weapon thrown at it. |
| `canThrow(item)` | Whether the weapon has the Thrown property. |
| `getAmmunition(item)` | The ammunition item dnd5e would use for the weapon's attack, or `null`. |
| `pickTargets(origin, { count, range, disposition, numberAllowed, within, confirm, useTargets, repeat, filter })` | Pick targets by clicking them on the map, with the range and candidates shown. Enter confirms, Esc cancels. With `repeat`, clicking a picked token picks it again and right click takes one away; the picks come back once per pick (`[A, A, B]`). Targets you already have in range are used as they are; `useTargets: false` clears them and always asks. **Async**. |
| `multiattack(thing, plan, { repeat, event, attack })` | A Multiattack written out, e.g. `[{ weapon: "Bite", count: 1 }, { weapon: "Claw", count: 2 }]`, made weapon by weapon: a pick on the map and a card per weapon. `weapon: ["Shortsword", "Longbow"]` asks how to split the attacks first. `repeat` (default `true`) lets a target take more than one of a weapon's attacks. Enter stops with fewer picks, and Esc skips that weapon. |
| `useAndApply(item, { activity, to, max, event })` | Uses the item the dnd5e way, then applies the healing or damage it rolled to `to` (default yourself), never more than `max`. A two-line Second Wind: `return item.useAndApply();` |
| `getAppliedConditions(card)` | The conditions a chat card's activity applies (its effects' statuses, and an on-hit rider's), e.g. `Set { "frightened" }`. Used by Brave: is this save against Frightened? |
| `getHealing(item, { average })` | How much an item heals, as a formula: its Heal activity, else its Utility roll formula, else its description ("heal 11 hit points" gives `"11"`, "regains 10 (3d6) hit points" gives `"3d6"`, or `"10"` with `average`). `null` if it doesn't say. |
| `getUses(item)` | The item's limited uses `{ value, max, spent }`, or `null` if it has none. |
| `hasUses(item, amount)` | Whether it has that many uses left. Items without limited uses always do. |
| `spendUses(item, amount, { warn })` | Uses up `amount` (1) uses, or gives them back if negative. Returns the fresh item, or `null` if there weren't enough (with a warning). |
| `useActivity(item, { activity, configure, event })` | Uses the item the dnd5e way (its card, uses, spell slot, action, effects) from inside its own Item Macro, with no dialog unless `configure`. Returns dnd5e's results, or `null` if it couldn't be used, so the macro can stop there. |
| `updateItem(item, changes)` | Updates an item and returns the fresh copy. Items on unlinked tokens are rebuilt when updated. |
| `setBaseDamage(item, { number, denomination, types, bonus })` | Sets a weapon's base damage, only if it's different. |
| `wait(ms)`, `waitFor(condition, { interval, timeout })` | Small async helpers. |
| `rollItem(item, { activity, count, targets, attackMode, disadvantage, event })` | Rolls an item as a Roll Item card (see below). `targets` gives one attack per token, in order (the same token twice is two attacks at it), instead of spreading `count` over your targets. `attackMode` is a dnd5e mode (`"thrown"`…), or a function `target => mode` that picks one per target. `disadvantage` is `true`, or `target => boolean` per target. Thrown attacks and ammunition are used up, as with dnd5e's own attacks. |

### Methods on tokens, actors and items

The helpers are also added as methods on the things they act on. Turn this off in the **Helpers** settings.

| On | Methods |
|---|---|
| Token | `getCreatureSize()`, `distanceTo(other)`, `getTokensWithin(feet, opts)`, `isEnemy(other)`, `isAlly(other)`, `isThreatened()`, `getThreats()`, `canSee(other)`, `setStatus(...)`, `setDefeated(...)`, `stabilize()`, `damage(value, type)`, `heal(value)`, `tempHP(value, source)`, `dropsToZero(amount)`, `isKilledOutright(amount)`, `preventDropToZero(amount, updates, opts)`, `findItem(query, opts)`, `split(opts)`, `highlightRange(feet, opts)`, `pickTargets(opts)` |
| TokenDocument | The same as Token, without `highlightRange`. |
| Actor | `getCreatureSize()`, `getTokensWithin(...)`, `isEnemy(...)`, `isAlly(...)`, `isThreatened()`, `getThreats()`, `canSee(...)`, `setStatus(...)`, `setDefeated(...)`, `stabilize()`, `damage(...)`, `heal(...)`, `tempHP(...)`, `dropsToZero(...)`, `isKilledOutright(...)`, `preventDropToZero(...)`, `findItem(...)`, `usedThisTurn(key)`, `markUsedThisTurn(key)`, `multiattack(plan, opts)` |
| Item | `pickAndAttack(opts)`, `pickAttack(opts)`, `getRange(opts)`, `getEnemiesWithinRange(opts)`, `pickTargets(opts)`, `attackModeFor(target)`, `isLongRange(target)`, `isRangedItem()`, `isRangedAttack(target)`, `canThrow()`, `getAmmunition()`, `multiattack(plan, opts)`, `useAndApply(opts)`, `getHealing(opts)`, `getUses()`, `hasUses(amount)`, `spendUses(amount)`, `useActivity(opts)`, `setBaseDamage(damage)`, `updateFresh(changes)`, `rollItem(opts)` |

A method is never added over an existing one from Foundry, the system or another module. That's why size is `getCreatureSize()`: Foundry's own `getSize()` is the token's size in pixels.

```js
// Greataxe: hit up to 2 Medium, or 3 Small, targets within 5 ft of each other
const enemies = item.getEnemiesWithinRange();
const numberAllowed = group => {
  const sizes = group.map(t => t.getCreatureSize()?.value ?? 2);
  return sizes.some(s => s >= 3) ? 1 : sizes.some(s => s === 2) ? 2 : 3;
};
const group = await MacroHelper.selectTargets(enemies, { numberAllowed, within : 5, setTargets : true, prompt : true, origin : item });
if(group.length) return item.rollItem({ count : group.length });
```

## Item Macro

- **Storing a macro:** store a macro on any item, or on a dnd5e activity, from the **</>** button in its sheet's title bar. The button turns gold once a macro is set. **Button in Title Bar** is each user's own setting (off puts it in the ⋯ menu); players see it once **Allow Players to Edit** is on.
- **The editor** is Foundry's own macro editor. Players need Foundry's script macro permission, and the GM can stop players editing item macros altogether with **Allow Players to Edit**. Items with a macro still run it for everyone.
- **When it runs:** choose **Default only**, **Macro only**, or **Macro, then Default**. In the last mode, the macro can return `false` to skip the default.
- **Variables:** macros get `item`, `activity`, `actor`, `token`, `speaker`, `event`, `usage`, `dialog`, `message` and `scope`, plus `hook` and `args` (below; `null` and `[]` when the item is used).
- **Run on Hooks (GMs, items):** a passive feature's macro can also run when a hook fires, e.g. Relentless Endurance on *Damage about to apply*. It only listens while the creature has a token on the scene you're viewing, so nothing is left behind when it isn't on the battlefield.
  - **Only About This Creature** (on by default) runs it only when the hook is about this creature: the damaged actor, its token, its item, or its turn.
  - **Run For** is *Owner, where it happens*, meaning the client where the hook fires if that user owns the creature. Use *Active GM (once)* for hooks that fire for everyone, like *Actor changed* or *Combat turn*.
  - Only macros saved by a GM run from hooks. If a player changes one, its hooks stop until a GM saves it again.
  - The macro runs inside the hook, so until its first `await` it can change what the hook passed.

## Hook Macros

Run a world macro when something happens in the game, without installing a module for it.

**Allow Players to Create** (Hook Macros setting, off by default): players get the *Run on Hooks* fields on macros they own. A player's hook macro only ever runs on that player's own client, never the GM's or anyone else's.

1. Open a world macro (GM only).
2. Expand **Run on Hooks** under the Type line.
3. Pick hooks from the list, or type any hook name under **Custom Hooks**.
4. Choose **Run For**:
   - **Active GM (once):** the default, and right for most things.
   - **Every client:** runs wherever the hook fires. dnd5e roll hooks need this, because they only fire on the roller's client.

The macro gets `hook` (the hook's name) and `args` (its arguments). Only macros written by a GM run from hooks.

The macro runs inside the hook, so until its first `await` it can still change what the hook passed, such as the pending update in *Damage about to apply*. Returning `false` doesn't cancel the hook. For a feature that belongs to one creature, use an item macro's **Run on Hooks** instead (see Item Macro): it only listens while that creature is on the scene.

```js
// Run on "Turn changed" (combatTurnChange)
const [combat] = args;
ChatMessage.create({ content : `It's ${combat.combatant?.name}'s turn.` });
```

## Hands (dnd5e)

Settings page System Automation → **Equipment**: **Hands** (on by default); **Main Hand** (each player's own, on **My Settings**: *Right* or *Left*). Two slots on the character sheet, at the bottom corners of the portrait: the **main hand** and the **off hand**, placed as the character faces you (a right-handed character's main hand on your left).

- **Holding something:** drag an item from the character's sheet onto a hand, or right-click a one-handed item in the sheet: **Equip to Main Hand** / **Equip to Off Hand** (instead of dnd5e's Equip; Unequip when it's held). Right-click a hand to empty it; click it to open what it holds.
  - *Two-Handed* (a greatsword, a bow): takes both hands; whatever they held is let go.
  - *One-handed*: that hand; the other keeps what it has (a Two-Handed item held there is let go).
  - *Versatile*: two-handed when the other hand is empty, one-handed as soon as something else is held. With **Dueling** it always stays one-handed.
  - *Shields, torches, tools, anything carried*: one hand. Armor is worn, not held.
- **Auto-equipped gear:** weapons and shields added to a character (Plutonium's starting equipment) arrive unequipped, and any weapon or shield that's equipped but not in a hand is unequipped when the sheet opens. Armor stays worn. Unarmed Strike is never held (a kick or headbutt works with your hands full).
- **Equipped follows:** what's in a hand is equipped, a weapon or shield that leaves it is unequipped. Ticking *Equipped* on the sheet puts the item in a free hand (and unticking takes it out); with no hand free, **Rule Limits** decides: *Off* and *Warn* put it in the main hand (letting go of what was there), *Block* and *Change* leave it unequipped.
- **Light** (**Held Light**: *Off*, *Light only*, *Light and burn time* by default): a torch, lantern, lamp or candle in a hand lights the character's token (2024: torch 20 ft bright / 20 more dim, hooded lantern 30 / 30, bullseye lantern a 60 ft cone / 60 more, lamp 15 / 30, candle 5 / 5); letting go of it brings the token's own light back. Found by item identifier, since dnd5e's items carry no light data. With burn time, a lit light is a **Lit Torch** (etc.) effect on the character lasting its time on the game clock (torch and candle 1 hour, lanterns and lamp 6 hours on a flask of oil). Put down early, it keeps the time left. When the clock passes its end it burns out, and its owner is whispered: a torch or candle is used up (one of the stack), a lantern or lamp stays in hand dark until it's taken in hand again, which uses a flask of **Oil** from the inventory. Deleting the effect snuffs the light (the time left is kept). A token of a character with a lit light (placed on another scene, placed again, back from Wild Shape) is lit too; a Wild Shape form holds nothing, so it doesn't carry the light.
- **Hotbar macros:** dnd5e's hotbar macro finds its item by name and would use the first of several. With two of the same (a Dagger in each hand), it uses the one meant instead: the one held; with both held, the main hand's, then the off hand's once the main-hand weapon has attacked this turn (out of combat, in the last minute). So one Dagger button makes the attack, then the extra off-hand attack. Without Hands, an equipped one.
- **Attacks and rules:** with Hands on, everything that asks what's held asks the hands: weapon handling (a weapon must be *in a hand*, not just equipped; Rule Limits *Change* takes it in hand by the rules above; a two-handed grip needs it in both hands), the Versatile grip, Dueling and Unarmed Fighting ("no other weapon", "no weapon or shield"), Protection (a shield in hand) and Interception (a shield or weapon in hand). An off-hand attack has to be with what the off hand holds. Armor checks (Rage, Defense) still read what's equipped: armor is worn. Attacking with something held that isn't a weapon (a burning torch, as an improvised weapon) is from the main hand (Rule Limits), and it then counts as a weapon in hand until the end of your turn (so it breaks Dueling that turn). A torch's attack doesn't use the torch up.

## Roll Requests (dnd5e)

The GM asks creatures for an ability check, skill, tool or save, with the DC set **before** anyone rolls. Settings page **Roll Requests**: **Enable Roll Requests**, **DM Screen** (players don't see the DC, only ✓ / ✗) and **Request Messages** (*Compact* or *Individual*, below).

- **Opening it:** the small d20 button at the right end of the hotbar (GM only), or the macro `MacroHelper.rollRequest()`.
- **Who:** every creature on the scene, plus the player characters who aren't on it (in italics). The selected tokens are ticked; with none selected, the players on the scene. **Players / Everyone / Nobody** set the ticks quickly.
- **The check** (in a tab): **What** (a category: Ability Checks, Saving Throws, Skills, Tools; then which one), **DC** (5 to 30 in fives, hover for the PHB's names, then **−2 / +2** or type it; its name shows underneath) and **How** (*Each rolls*, or *Group check*: the group succeeds when at least half succeed). **Whisper** keeps the cards and their rolls to the GM and the creatures' owners.
- **One tab:** **Request** posts the card and the window closes.
- **Skill Challenge:** the **+** by the tabs adds another check; more than one tab makes it a Skill Challenge. Each tab is its own check (each rolls or group, its own DC), requested when you want (**Request check 2**, in any order); it's posted exactly like a single request. The window keeps each check's outcome (✓ / ✗ on its tab; an *each rolls* check counts when at least half succeed, one creature: its own result) and stays open (closing it keeps the challenge; the hotbar button brings it back). A tab not requested yet can be removed. Once every tab is decided, a **Skill Challenge** message says whether the party succeeded: a majority of the checks. **Start over** clears it.
- **The card:** a row per creature with a **Roll** button for its owner (the GM can roll any). It's dnd5e's roll, so the Advantage setting applies. The GM's client marks the row ✓ / ✗. With Roll Item's DM Screen on, players don't see NPCs' totals.
  - *Compact* (default): the roll goes into the card, nothing else is posted (Dice So Nice still shows it). **Reroll** sits by the total. **Lucky**, **Bardic Inspiration** and **Tactical Mind** are buttons at the card's foot, each only for its owner; the GM's **Tactical Mind: Spend Use** shows there once Tactical Mind has made it a success.
  - *Individual*: each roll is dnd5e's own message (with its buttons), linked to the card, which follows any change to it.

## Roll Item (dnd5e)

**Settings:** **Enable Roll Item** (at the top; off turns Roll Item off, the rules stay with System Automation), **DM Screen**, **Roll Type** (*Normal*: dnd5e's own cards, while Pick Targets, template help and the Reroll buttons still work; *Quick*: Roll Item's cards for attacks, saves, damage, heals and utility too), **Advantage** and **Target Inside Areas** (each player's **Pick Targets** is on **My Settings**). **Range Shape** is on System Automation's Homebrew page, **Clear Instant Areas** on its Combat page, **Card Descriptions** on the Helpers page.

One card per use, built on dnd5e's own chat cards. Rerolls wait for Dice So Nice to finish.

| Activity | Card |
|---|---|
| Attack | Attack and damage rolled together. The crit range follows dnd5e and feats. Advantage and disadvantage follow the **Advantage / Disadvantage** setting. |
| Multiple attack rolls | Scorching Ray, Eldritch Blast and Magic Missile count their rolls from the cast level. Each one gets its own target, damage and APPLY tray. |
| Attack + on-hit save | Giant Spider, Ghoul and similar. Separate base and save damage, a save button, and a tray that halves damage for targets that saved. |
| Save | Damage is rolled up front. Targets roll their own saves. Half damage on a save is applied automatically. |
| Heal | Healing or temporary HP, rolled with its apply tray. |
| Damage only | Damage is rolled up front, with its apply tray. |
| Utility | The activity's roll formula is rolled onto the card. |

Damage shows one box per damage type. The APPLY trays use dnd5e's own resistance, immunity and vulnerability handling.

**Advantage** (GM setting) has three choices:
- *Ask:* an Advantage / Normal / Disadvantage prompt after targets are picked, once per card and once per reroll.
- *Hotkey* (the default): hold dnd5e's keys while rolling (default Alt / Ctrl).
- *Rules Only:* only what the rules give.

Either way the choice is combined with long range, being threatened, conditions and masteries, and advantage and disadvantage cancel out.

**Damage after the attack dice** (automatic, with Dice So Nice installed and active): attack and damage are both still rolled automatically, but the card shows the attack first. The damage dice roll once the attack dice have landed, so crit damage dice don't give away a natural 20 early. Without Dice So Nice the card shows everything at once.

**Pick Targets** (a setting for each player, default *Always*): attacks let you click your targets on the map first, with either Roll Type (on *Normal*, dnd5e's own card is then made for your picks). Each creature is coloured by how the attack would roll against it: green advantage, yellow normal (or both cancelling), red disadvantage. The squares show the range: blue normal, red long range. Your own space stays plain when you can't pick yourself. It works like `pickAndAttack`: the range is shown, targets beyond reach are thrown at, and long range or a ranged attack while threatened gives disadvantage. It also checks you have enough ammunition or weapons to throw. The pick happens after dnd5e's use, so Scorching Ray knows its ray count from the cast level, and rays or attacks can pick a target again. If you pick fewer targets than rays, the rays are spread over your picks. Esc after casting still spends the slot.

**Effects on yourself:** an activity that only affects its user (Armor of Shadows' Mage Armor) puts its effects on you when you use it: dnd5e only lets players apply them from the card with its *Allow Player Effects Tray* setting. Tied to the item's Concentration when it has one; an item whose effect is already on you is skipped.

**Not on the scene:** a creature with no token on the scene you're viewing can't see anything there, so it rolls without targets: yours are let go (with a notice) and nothing is picked. Its card has no rows; apply its damage from the card's tray to the selected tokens.
- *Off* uses your targets as they are.
- *When you have no targets in range* picks only then.
- *Always* clears your targets and picks every time.

It needs your token on the scene you're viewing; without one, the attack rolls against your targets as usual.

**Masteries** (System Automation → Rules, on by default): attack cards use the 2024 weapon mastery dnd5e gives the attack. It only gives one when the actor has mastered that kind of weapon (Weapon Proficiencies → Mastery on the sheet). Graze and the Sap / Vex advantage are part of the rolls. The buttons that change a target (Topple, Push, Slow, Sap, Vex) are outcomes, so only the GM sees and clicks them; nothing happens on its own. Cleave is another attack, so it's the roller's button. Each can be used once per attack, and only on targets the card shows were hit.

| Mastery | On the card |
|---|---|
| Graze | On a miss: damage equal to the attack's ability modifier, with the weapon's damage type and its own APPLY tray. Multiple-attack cards apply it to misses with the "apply hits" button. |
| Topple | On a hit: a button. The target makes a CON save (DC 8 + ability modifier + proficiency) and falls Prone on a failure. |
| Push | On a hit: a button that pushes the target 10 ft straight away, stopping at walls and other creatures. It doesn't work on Huge or larger creatures. |
| Sap | On a hit: a button. The target has disadvantage on its next attack roll before the start of the attacker's next turn. |
| Slow | On a hit: a button. The target's speed drops 10 ft until the start of the attacker's next turn. It doesn't stack. |
| Vex | On a hit: a button. The attacker has advantage on their next attack roll against that target before the end of their next turn. |
| Cleave | On a hit: a button, once per turn. Pick a second creature within 5 ft of the first and in reach, and attack it. Its damage leaves out a positive ability modifier. |
| Nick | Nothing to roll. It only changes when the Light extra attack happens. |

Sap and Vex are used up by the next attack roll they affect, from any sheet or card.

**Homebrew** (GM sub-menu, everything off by default): table rules that aren't in the books.
- **Flanking:** *Off* (rules as written), *Advantage*, or *+2 to the attack roll*. It uses the DMG optional rule: a melee attack against a creature with one of the attacker's allies on its opposite side, both next to it. A line between the two must pass through opposite sides or corners of its space, and allies who are down or incapacitated don't count. It applies to every attack roll, not only Roll Item's.
- **Initiative Each Round:** at the start of every new round, everyone rolls initiative again and the round starts from the top of the new order. Going back a round doesn't reroll. Effects lasting "until the start of your next turn" (Dodging, Help, Vex) end for whoever starts the new order, not whoever was first before the reroll.
- **Recovering Ammunition:** *As written* (half, rounded down), *Half, an odd one decided by 1d2*, or *Hit Recovery*. Needs Ammunition Recovery on (see below).
  - *Hit Recovery:* only ammunition that hits can be found, in the creature it hit. A hit counts when the attack's damage is applied to a creature, so rerolls, Lucky, cover and the GM's calls are already settled; it's done by whoever applies it (the GM, for monsters). Ammunition rolls 1d4: on 1-2 it breaks, on 3-4 it goes in the creature's inventory, so looting the creature finds it. A thrown weapon that hits always goes in, and comes off what its thrower can pick up after the fight. The GMs get a whisper either way. Anyone's shots count, monsters' too. Each attack counts once per creature (applying its damage again, or another box from the same attack, doesn't). Graze's damage on a miss doesn't count. Ammunition that misses is lost; a thrown weapon that misses can still be picked up after the fight.
- **Shared Search:** after a fight, everything shot and thrown (NPCs' too) is one pool, each kind with a Take button for everyone (see Ammunition Recovery).
- **Push Into Obstacles:** a Push cut short by a wall. If the target travels only part of the way (5 of 10 ft), it falls Prone. If it can't move at all, it falls Prone and takes 1d6 bludgeoning, rolled in chat and applied.

**Cover** (GM only): a small row of chips at the top of attack and save cards, one group per target: – (none), ½ (+2), ¾ (+5), ✕ (total).
- On an attack card, it raises that target's AC on the card and on its attack roll, from the AC it had before cover, so hit or miss, the tray, Apply and masteries all follow. ✕ makes the attack miss, even on a natural 20.
- On a save card, ½ and ¾ add +2 or +5 to that target's DEX save, including one already rolled: its total and success update. ✕ leaves the target out: no save and nothing applied.

**Save and heal cards** have one row per target:
- **Self only:** an activity that targets Self, or has Range Self with no area (Second Wind), is always for the caster. Your targets are cleared.
- **Save button:** shown to the token's owner and the GM. It rolls with the keys you hold, with no prompt. A choice of abilities (STR or DEX) gets a button each. Hovering shows what the roll will add before you click, for example "Bonus: +5 (Advantage: Dodging) = DEX (+3) + Prof (+2)". That includes cover and species traits against the card's condition.
- **Result:** shown once rolled, as the total and ✓ or ✗. Hovering it shows the dice behind it, for example "d20 : 2, 12 (Advantage, kept 12) · 12 + 2 = 14", plus any cover added since.
- **Apply effect (GM):** once a target has rolled, the save's effects (Turned, Grappled, Paralyzed, Frightened...) get an **Apply {effect}** button on its row, the same as Apply damage: all of them on a failure, and on a success only those set to apply on a save. It shows ✓ once applied. These cards don't show dnd5e's effect tray, which would apply to whatever the GM has selected.
- **Apply button:** applies that target's damage, sized by its save (full, half or none), or its healing. Only the token's owner and the GM can use it, so a player can apply healing to their own character but not someone else's.
- **Applied:** once applied, the row shows the amount instead of the button, such as −7 in red or +5 in green. For an NPC behind the DM screen, players see ✓. Attack cards show the amount beside each target.
- **Once per card:** a card's damage or healing applies to each creature once per box: its rows, its hits, and each damage box (the attack's damage, Hunter's Mark, a smite, Graze, Savage Attacker, the on-hit save) each count once, so applying one never blocks another. A second click warns instead. Once a box has been applied to every target on the card, it stays open with its numbers and its Apply button reads **Applied** (select another creature to give it to them too), and the card's target shows the total applied (−7). After rerolling damage that was already applied, change HP by hand.
- **Reroll and Lucky:** on each row with a save. dnd5e hides those save messages under the card, so the buttons are here instead.

On attack cards, damage is always rolled, but the APPLY tray only shows on a hit. A reroll that hits brings it back.

**Saves, ability checks, skills and initiative** (dnd5e's own roll messages) get buttons:
- **No dialog:** checks, skills, tools, saves, death saves and initiative from the sheet roll straight away, using the Roll Item **Advantage** setting: held keys count on *Hotkey*, nothing counts on *Rules Only*, and on *Ask* dnd5e's own dialog opens.
- **Reroll:** for the roller and the GM; replaces the roll. Advantage or disadvantage is chosen the same way (keys held when you click, or the prompt).
- **Lucky (n):** for the owner of a creature with the Lucky feat and a point left. It adds a second d20 and keeps the higher, once per roll.
- **Saves linked to a card:** a save rolled from a card's row, or an on-hit save, updates that card when it changes, including its ✓/✗, its Apply sizes, and the on-hit save's halving. Reroll before applying: damage already applied isn't taken back.
- **Initiative:** a rerolled initiative moves the combatant in the tracker too.

**Attack extras** (with Roll Item on): an item with one attack plus activities that only add to it (Plutonium's monster attacks: the Elk's Ram has its attack plus "Damage: 1d6" for a charge; the Giant Spider's Bite has a poison save) is used as the attack, with no "which activity?" question. After targeting, everything is rolled onto the one card: the attack, its damage, each extra damage activity in a box of its own (doubled on a crit, its APPLY showing once the attack hits, for the GM to apply or not), and one save as the card's on-hit save. Grapple and Shove aren't extras: they're alternatives to the attack, so they're still asked. Hold Shift when using the item to get dnd5e's choice anyway.

**Cancelling:** closing a use part way (the target pick, the advantage prompt, the damage type question) undoes it: what dnd5e spent (a spell slot, a use) is refunded, any template it placed is removed, and no card is made.

**Ammunition Recovery** (System Automation → **Equipment**, *On* by default, or *Off*; how it's found can be changed with Homebrew's **Recovering Ammunition**): during a combat, every attack with an Ammunition weapon and every thrown attack (not Returning) is counted. A player's throw counts only when it took one off their stack. When the combat ends, a card lists what can be found: each owner gets **Recover N (ammunition)**, half of the ammunition they used back onto that item (2024: a minute's search, the rest lost), and **Pick up N (weapon)**, all of their thrown weapons (nothing breaks them). Thrown weapons are tracked as *still out there*: if the weapon's quantity goes up some other way (picked up by hand), that much comes off, so nothing comes back twice. With **Shared Search** (**Homebrew**), there's one pool of everything instead: half of all the ammunition shot and every thrown weapon, NPCs' included (shot, even if you don't track their arrows). When the combat ends, the pool card goes to everyone, a **Take N (item)** button per kind found. Whoever clicks one gets those items (onto their own of that kind, or a new stack), and the button greys out for everyone with their name; if two people click the same one at the same moment, it's split between them (never more than was found). The party shares it out as they like.

**Conditions on tokens:** an effect put on a creature with a condition's name (Shove's "Prone", Thunderous Smite's, Plutonium's "Frightened"...) gets the condition itself if it lacked it, so the condition's rules apply, and the condition's own icon instead of its item's picture (a fist, a spell), so the token shows the standard Prone icon. Turning that condition off (token HUD, sheet) removes it too, rather than adding a second one. Every effect put on a creature also shows on its token, even one without a duration (which Foundry would hide), with its item's picture if it has none. Effects already on creatures keep their old look until removed and reapplied.

**Debug buttons:** with Macro Helper's **Debug** setting on, the GM gets two bug buttons beside a Roll Item attack's reroll buttons (each ray's too), which set its d20 to 20 (a crit) or 1 (a miss); the damage and the extra boxes (Hunter's Mark, a smite) are rolled again when that changes a crit. Saves, checks and initiative messages get **Debug: 20** and **Debug: 1** in their button row.

**Changes to other creatures go through the GM:** when something you do would change a creature you don't own (Hunter's Mark, Help's mark, Stabilize, Shove's push or Prone, Remove Poison), a card asks the GM, and the change happens when the GM clicks its button. Your own side (spending, Concentration) happens at once; the GM's own uses get the card too, so nothing changes on another creature without that click. Changing a roll on a card (Lucky, Interception, Protection's extra d20) isn't a change to the creature, so it happens straight away.

**Clear Instant Areas** (System Automation → **Combat**, on by default; works with Roll Item off too): the areas instantaneous spells and features place (Fireball, Burning Hands, Turn Undead's circle) are removed at the end of their creature's turn, when the combat ends, or a minute after they're placed when there's no combat. Areas that last (a duration, or Concentration) stay.

**No template question:** when a use's only question would be "place the template?" (no spell slot level or scaling to choose, like a monster's innate Fireball), dnd5e's dialog is skipped and the template is placed straight away.

**DM Screen** (GM setting, off by default):
- **NPC cards:** players see the cards but no numbers (no d20, totals or damage), only whether it hit or saved.
- **NPC saves** rolled from a card are private GM rolls.
- **Hidden targets:** GM-hidden or Invisible targets show as *Unknown*.

**Area placement** (with Roll Item on): a template with a range (Fireball, 150 ft) can only be placed with its centre within that range of the caster, along a clear path: it stops at the first wall that blocks movement (a window stops it, an open door doesn't). Somewhere the caster can't see is fine. With **Target Inside Areas** (on by default), when a use places a template (Burning Hands, Fireball, Sleep), everyone inside it becomes the targets, the caster too if they're in it. The exception is the caster's own cone or line, since its point isn't part of its area. A "Range: Self" cone or line (Burning Hands, Lightning Bolt) stays pinned to the caster's token while you place it, and the mouse only aims it. The card, its save buttons and its trays are then for exactly them.

**Pick Targets** also covers damage-only activities (Magic Missile: one pick per dart once the cast level is known; the same target can be picked again), and heal, save and effect activities aimed at creatures (Healing Hands, Grapple, Shove, Mage Armor, Cure Wounds). The pick happens *before* dnd5e uses them, so closing it spends nothing. The count, range and who can be picked come from the activity:
- *willing* or *ally* targets: your allies and yourself, so Mage Armor can't land on an enemy
- saves and *enemy* targets: enemies
- anything else (a heal): anyone, yourself included

Areas (their template does it), self-only activities and activities without a range aren't picked for.

**Grapple** and **Shove** (Default Actions): two actions, each a save from Unarmed Strike. A failed Grapple save gets the row's **Apply Grappled** button (GM), like any save's effect.
- **Grapple:** a failed save applies Grappled straight away.
- **Shove:** a failed save gives the shover **Prone** and **Push 5 ft** buttons for that target, on Roll Item's save card (Roll Type *Quick*). The choice then shows on that target's row as the GM's button (**Apply Push 5 ft** or **Apply Prone**, where a save's effects are applied; nothing there until the shover chooses), and the GM's click carries it out. Homebrew Push Into Obstacles applies to the push.
- **Size limit:** both only work on creatures up to one size larger.

Unarmed Strike keeps dnd5e's Attack / Grapple / Shove choice, made before rolling: in 2024 rules Grapple and Shove have no attack roll, the target only saves. Grapple and Shove are never on-hit riders on the attack's card. An Unarmed Strike with one "Grapple/Shove" activity asks *Grapple or Shove?* when used, and its card is that one: a failed save Grapples, or offers Shove's Prone / Push buttons.

### Stage hooks: how feats plug in

Roll Item does four things: **Target**, **Attack**, **Save** and **Damage**, all on one card. It knows nothing about anyone's feats, and nothing about System Automation either: every rule (masteries, Grapple and Shove, Lucky, Bardic Inspiration, Rule Limits...) plugs into the card through the same hooks. A feat that changes a roll is an item macro on the feat, set to **Run on Hooks** (see Item Macro), using these hooks:

| Hook | Arguments | Use it to |
|---|---|---|
| `macro-helper.targets` | `activity, tokens` | The targets picked or found in an area. Remove some from `tokens` (splice it) to drop them, e.g. Humanoids only. What's left becomes the targets. |
| `macro-helper.preAttack` | `activity, rollConfig` | Change an attack before it's rolled (`rollConfig.advantage` / `.disadvantage`). Return `false` to stop it. `rollConfig["macro-helper"].target` is the target's token uuid. |
| `macro-helper.attack` | `activity, roll` | React to an attack roll. |
| `macro-helper.preDamage` | `activity, config, attack` | Change damage before it's rolled. Return `false` to skip it. |
| `macro-helper.damage` | `activity, rolls, attack` | React to a damage roll. |
| `macro-helper.cardButtons` | `message, buttons, { ray }` | Add a button to an attack on the card: push `{ id, label, icon }`. Runs every time the card is drawn. |
| `macro-helper.cardButton` | `message, id, { ray, event, button }` | Your button was clicked. `button` is the button itself. |
| `macro-helper.cardNotes` | `message, notes, { ray }` | Add a note to the card: push `{ text, icon, tooltip }`. |
| `macro-helper.cardSections` | `message, sections, { ray }` | Add a section under an attack (or to a save card): push `{ partial, context }`, where `partial` is a Handlebars partial you loaded. Its buttons use `data-action="cardButton" data-id="..."`. With `applies : true` its damage counts for **Apply Hits**. Weapon masteries and Shove's buttons use this. |
| `macro-helper.cardFaces` | `message, faces` | Show something else that went into the use under the item's description, laid out like the item (its header, its description folding under it): push `{ uuid, name, img, subtitle, description }`. With a `uuid` and no `description`, that item's description is shown. Metamagic uses this. |
| `macro-helper.selfEffects` | `activity` | Return `false` when your rule puts a self-only activity's effects on the creature itself (Rage, Dodge, Innate Sorcery), so Roll Item doesn't. |
| `macro-helper.damageType` | `activity, { index, types, preset }` | Settle a damage part's type without asking: set `preset.type` (one of `types`). A pact weapon's normal type. |
| `macro-helper.preRollItem` | `activity, usage` | Return `false` to leave an activity to dnd5e (Bardic Inspiration's die isn't rolled on a card). |
| `macro-helper.isRider` | `activity` | Return `false` when a save on the item isn't an on-hit rider (Grapple and Shove are alternatives to the attack). |
| `macro-helper.saveOutcome` | `saveMessage, outcome` | Change how a save turned out: `outcome.success`, and `outcome.auto` for an automatic failure's reason. |
| `macro-helper.autoFail` | `actor, ability, found` | Push a reason when a creature fails a save without rolling (Paralyzed: STR and DEX). |
| `macro-helper.saveHint` | `message, actor, ability, { adv, dis, ignore }` | Name advantage or disadvantage on a save button's hint (push a name), or add an effect to `ignore` when it gives nothing right now. |
| `macro-helper.preApplyRow` | `message, actor, { multiplier }` | A row's damage is about to be applied. Return `false` to stop it. |
| `macro-helper.preApplyEffects` | `message, actor, effects, { uuid, button }` | A row's effects are about to be applied (GM). Return `false` to stop it, or to do it yourself (Grapple on a creature too big; Shove carries out the shover's choice). |
| `macro-helper.rowEffect` | `message, uuid, row, { success, effects }` | The GM's effect button on a row: set `row.show` (false hides it), `row.names` (what it applies) or `row.done`. Shove shows the shover's choice there. |
| `macro-helper.rerollButtons` | `message, buttons, { actor, roll }` | Add a button beside **Reroll** on a save or check (on its message and on card rows): push `{ id, icon, label, run }`. Lucky, Bardic Inspiration and Tactical Mind use this. |
| `macro-helper.rerollable` | `message` | Return `false` when a save or check can't be changed at all (an automatic failure). |
| `macro-helper.preReroll` | `who, what` | Return `false` to stop a reroll. Rule Limits uses this; with System Automation off, rerolls are never blocked. |

**Turn starts:** `Hooks.on("macro-helper.turnStart", (combat, combatant) => ...)` runs on the active GM's client once for each creature's turn, after the order is settled. A round with **Initiative Each Round**, or a combat whose initiative is rolled automatically, waits for the roll first. Use it for anything at the start of a turn: Foundry's `combatTurnChange` names whoever was first *before* everyone rerolled. Repeating effects and Unarmed Fighting use it.

The card's `message.system` gives a macro what it needs:
- `isHitOn(ray)`: did that attack hit?
- `rollDamage(ray)`: roll its damage again, the way the card did, crits included.
- `setDamageType(type, ray)`: change the type of an attack's own damage once it's rolled (a pact weapon's Necrotic).
- `addDamage(rolls, { key, label, ray, alternative })`: add damage in its own labelled box with its own APPLY. With `alternative`, it replaces the attack's damage rather than adding to it, and applying one hides the other.
- `extraRolls(ray, key)`: damage a macro already added.
- `addedRollsOf(ray, part)`: rolls a rule added to every attack (Graze's damage).
- `targetHits(ray)`: that attack's `{ targets, hits }`.

`ray` is the attack's number on a card with several attacks, or `null` for a single attack.

The hooks only run until the macro's first `await`, so change rolls before awaiting anything. The built-in Savage Attacker in [scripts/automation/feats.js](scripts/automation/feats.js) is the model: it uses the same two card-button hooks a macro would.

Choose which activity types use Roll Item cards in the **Roll Item** settings. Any item can also be rolled from a macro:

```js
MacroHelper.rollItem(item);                 // first attack, save, damage, heal or utility activity
MacroHelper.rollItem(item, { count : 3 });  // force the number of attack rolls
```

## Examples

Ready-made macros are in the [examples](examples) folder: Split, Pseudopod, Greataxe cleave, 0 HP handling and a turn announcer. Each file says how to set it up.

## License

MIT, see [LICENSE](LICENSE).
