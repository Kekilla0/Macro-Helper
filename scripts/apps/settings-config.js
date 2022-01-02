import { module, logger} from './module.js';

export class MacroHelperConfig extends SettingsConfig{
  static get defaultOptions(){
    return foundry.utils.mergeObject(super.defaultOptions, {
      title : module.data.title,
      id : `${module.data.name}-settings`,
      template : `${module.data.path}/templates/MacroHelpersConfig.html`,
      width : 600,
      height : "auto",
      tabs : [
        {navSelector: ".tabs", contentSelector: ".content", initial: "general"}
      ],
    });
  }

  getData(options){
    const canConfigure = game.user.can("SETTING_MODIFY");
    const settings = Array.from(game.settings.settings);

    const data = {
      tabs : [
        {name: "actor", i18nName:"Actor Helpers", class: "fas fa-theater-masks", menus : [], settings : []},
        {name: "token", i18nName:"Token Helpers", class: "fas fa-compass", menus: [], settings: []},
        {name: "item", i18nName:"Item Helpers", class: "fas fa-drumstick-bite", menus : [], settings : []},
      ],
    };

    for(let [k, setting] of settings.filter(([k, setting]) => k.includes(module.data.name))){
      if(!canConfigure && setting.scope !== "client") continue;

      let groupTab = data.tabs.find(tab => tab.name === setting.group) ?? false;
      if(groupTab) groupTab.settings.push({
        ...setting,
        type : setting.type instanceof Function ? setting.type.name : "String",
        isCheckbox : setting.type === Boolean,
        isSelect : setting.choices !== undefined,
        isRange : setting.type === Number && setting.range,
        value : module.setting(setting.key),
        onchange : async () => { await module.wait(200); window.location.reload() },
      });
    }

    logger.debug("GET DATA | DATA | ", data);

    return {
      user : game.user, canConfigure, systemTitle : game.system.data.title, data
    }
  }
}