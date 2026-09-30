# Macro Helper

Item macros and one-click roll cards for Foundry VTT.

- **Foundry:** v14 (verified 14.368)
- **System:** Item Macro works in any system; Roll Item needs dnd5e 6.x
- **Recommended:** [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper)

## Install

In Foundry's **Add-on Modules** tab, click **Install Module** and paste this manifest URL:

```
https://github.com/Kekilla0/Macro-Helper/releases/latest/download/module.json
```

## Features

### Item Macro
- Store a macro on any item, or on a dnd5e activity, from the **Item Macro** entry in its sheet's header menu.
- The editor is Foundry's own macro editor.
- Choose what happens when the item is used: **Default only**, **Macro only**, or **Macro, then Default**. In the last mode, the macro can return `false` to skip the default.
- Macros get `item`, `activity`, `actor`, `token`, `speaker`, `event`, `usage`, `dialog` and `message`.

### Roll Item (dnd5e)
One card per use, built on dnd5e's own chat cards, with Dice So Nice aware rerolls.

| Activity | Card |
|---|---|
| Attack | Attack and damage rolled together. The crit range follows dnd5e and feats. Advantage and disadvantage use dnd5e's keys. |
| Multiple attack rolls | Scorching Ray and Eldritch Blast count their rays from the cast level. Each ray gets its own target, damage and APPLY tray. |
| Attack + on-hit save | Giant Spider, Ghoul and similar. Separate base and save damage, a save button, and a tray that halves damage for targets that saved. |
| Save | Damage is rolled up front. Targets roll their own saves. Half damage on a save is applied automatically. |
| Heal | Healing or temporary HP, rolled with its apply tray. |
| Damage only | Damage is rolled up front. Magic Missile darts are rolled one per dart, each with its own target. |
| Utility | The activity's roll formula is rolled onto the card. |

Damage shows one box per damage type. The APPLY trays use dnd5e's own resistance, immunity and vulnerability handling.

Enable each card type in the module settings (**Roll Item for Attacks**, **Saves**, **Heals**, **Damage**, **Utility**). You can also call it from a macro:

```js
MacroHelper.rollItem(item);                 // first attack, save, damage, heal or utility activity
MacroHelper.rollItem(item, { count: 3 });   // force the number of attack rolls
```

## Releasing (maintainers)

1. Merge into `main` and push.
2. On GitHub, **Releases → Draft a new release**, tag it e.g. `v14.0.1`, and publish.
3. The **Release** workflow stamps the version into `module.json`, zips the module and attaches `module.json` and `module.zip` to the release. Foundry picks it up as an update through the manifest URL.

## License

MIT, see [LICENSE](LICENSE).
