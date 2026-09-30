const ID = "macro-helper";
const TITLE = "Macro Helper";

export class module{
  static get id(){ return ID; }
  static get title(){ return TITLE; }
  static get path(){ return `modules/${ID}`; }
  static get data(){ return game.modules.get(ID); }

  static i18n(key){
    return game.i18n.localize(key);
  }

  static format(key, data = {}){
    return game.i18n.format(key, data);
  }
}
