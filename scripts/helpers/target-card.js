import { module } from '../module.js';
import { gm } from '../gm.js';
import { esc } from './utils.js';

/**
 * A spell's card for something it does to creatures with no roll (Hunter's Mark, Hex) : the spell (icon, name, its
 * tags, its description folded), then a row per creature, laid out like every other card's rows : the creature on the
 * left, its button on the right. The button (the GM, or the creature's owner) runs a GM action; the row then shows
 * it done.
 *
 *   rows : [{ token : TokenDocument uuid, label : "Mark Orc", action : gm handler name, data : {...}, done : "Marked" }]
 */
export async function postTargetCard({ actor, item, text = "", rows = [] } = {}){
  /* Action Tracker : a Bonus Action spell (Hunter's Mark, Hex) bypasses the use pipeline : spent here */
  const activation = [...(item?.system?.activities ?? [])][0]?.activation?.type || item?.system?.activation?.type;
  if(activation === "bonus"){
    const { actionTracker } = await import('../automation/action-tracker.js');
    await actionTracker.spend(actor, { kind : "bonus", what : item.name }).catch(() => null);
  }
  const labels = item?.labels ?? {};
  const pills = [labels.level, labels.school, ...(labels.components?.tags ?? []), labels.components?.vsm, labels.activation, labels.duration,
    typeof labels.range === "string" ? labels.range : null].filter(Boolean);
  const description = item?.system?.description?.value
    ? await foundry.applications.ux.TextEditor.implementation.enrichHTML(item.system.description.value, { relativeTo : item, rollData : item.getRollData?.() }).catch(() => "")
    : "";
  const content = `<div class="dnd5e2"><div class="chat-card ${module.id}-target-card">
      <section class="card-header${description ? "" : " no-description"}">
        <div class="item-icon"><img class="gold-icon" src="${esc(item?.img ?? "icons/svg/aura.svg")}" alt=""></div>
        <div class="name-stacked"><span class="title">${esc(item?.name ?? "")}</span>${text ? `<span class="subtitle">${esc(text)}</span>` : ""}</div>
        ${description ? `<div class="chevron"><i class="fa-solid fa-chevron-down" inert></i></div>` : ""}
      </section>
      ${description ? `<section class="card-description collapsible collapsed"><div class="collapsible-content"><div class="wrapper">${description}</div></div></section>` : ""}
      ${pills.length ? `<section class="icon-row"><i class="fa-fw fa-solid fa-tag" inert></i><ul class="pills unlist">${pills.map(p => `<li class="pill transparent"><span class="label">${esc(p)}</span></li>`).join("")}</ul></section>` : ""}
      <ul class="unlist macro-helper-rows ${module.id}-target-rows"></ul>
    </div></div>`;
  return ChatMessage.implementation.create({
    speaker : ChatMessage.implementation.getSpeaker({ actor }),
    content,
    flags : { [module.id] : { targetCard : { rows : rows.map(r => ({ token : r.token, label : r.label, action : r.action, data : r.data ?? {}, done : r.done ?? "" })) } } },
  });
}

/* Its rows, drawn each time (who may press, what's done) */
function renderRows(message, html){
  const card = message.getFlag?.(module.id, "targetCard");
  const list = html.querySelector(`.${module.id}-target-rows`);
  if(!card || !list) return;
  list.innerHTML = "";
  card.rows.forEach((row, index) => {
    const token = fromUuidSync(row.token ?? "", { strict : false });
    const li = document.createElement("li");
    li.className = "macro-helper-row";
    const done = message.getFlag(module.id, `targetCardDone.${index}`);
    const may = game.user.isGM || !!token?.actor?.isOwner;
    li.innerHTML = `<img class="token" src="${esc(token?.texture?.src ?? token?.actor?.img ?? "icons/svg/mystery-man.svg")}" alt="">
      <span class="name">${esc(token?.name ?? "?")}</span>
      <span class="macro-helper-row-apply">${done
        ? `<span class="applied healing"><i class="fa-solid fa-check" inert></i> ${esc(row.done || row.label)}</span>`
        : (may ? `<button type="button" class="apply" data-index="${index}"><i class="fa-solid fa-reply-all fa-flip-horizontal" inert></i> ${esc(row.label)}</button>` : "")}</span>`;
    li.querySelector("button")?.addEventListener("click", async event => {
      event.preventDefault();
      event.currentTarget.disabled = true;
      const ok = await gm.run(row.action, row.data);
      if(ok === false) return;
      await gm.run("targetCardDone", { message : message.id, index });
    });
    list.append(li);
  });
}

/* GM : a row done (whoever pressed it) */
async function doneAsGM({ message : id, index } = {}){
  const message = game.messages.get(id);
  if(!message?.getFlag(module.id, "targetCard")) return false;
  await message.setFlag(module.id, `targetCardDone.${index}`, true);
  return true;
}

let registered = false;
export function registerTargetCards(){
  if(registered) return;
  registered = true;
  Hooks.on("renderChatMessageHTML", (message, html) => {
    renderRows(message, html);
    /* The description folds open from the header */
    const card = html.querySelector(`.${module.id}-target-card`);
    card?.querySelector(".card-header")?.addEventListener("click", () => card.querySelector(".card-description")?.classList.toggle("collapsed"));
  });
  gm.handle("targetCardDone", data => doneAsGM(data));
}
