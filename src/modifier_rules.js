// Shared modifier-group classification rules (name-based; first match wins).
// ---- classification rules (first match wins). [regex on lower-cased group name, type, sub-type, rule label]
const RULES = [
  [/make it a meal deal/, "Add-ons", "Meal deal / upsell", "meal deal"],
  [/how would you like your sauce/, "Sauce", "Sauce serving preference", "sauce on bowl/side"],
  [/^size$/, "Size & catering trays", "Size / portion", "size"],
  [/a la carte|half trays$|pita sandwich tray|hummus & pita tray/, "Size & catering trays", "Catering tray / package", "tray product picker"],
  [/red bull|saratoga|jarritos|soda|fountain|^drinks$|canned drink/, "Beverage", "Beverage", "drink"],
  [/^desserts?$/, "Dessert & sides", "Dessert", "dessert"],
  [/^fries$/, "Dessert & sides", "Side", "side"],
  [/hummus sauce/, "Sauce", "Choose sauce", "sauce choice for hummus"],
  [/hummus pita choice|pita bread|^pita( type)?$/, "Hummus & pita", "Pita type", "pita"],
  [/cheese & (hummus|dips)/, "Add-ons", "Cheese & hummus add-ons", "cheese/hummus extras"],
  [/hummus/, "Hummus & pita", "Hummus type", "hummus type"],
  [/protein cup|scoop meat|protein add on/, "Protein", "Protein cup / scoop add-on", "paid protein cup / scoop"],
  [/protein|combo/, "Protein", "Choose protein", "protein selection"],
  [/rice|cater base/, "Rice", "Choose rice / base", "rice or base"],
  [/cup of sauce|sauce add on/, "Sauce", "Sauce cup / add-on", "paid sauce cup"],
  [/sauce/, "Sauce", "Choose sauce", "sauce selection"],
  [/premium topping|additional toppings|topping add on/, "Toppings", "Premium & extra toppings", "premium / extra toppings"],
  [/topping|salad/, "Toppings", "Standard toppings", "standard toppings"],
  [/add ?ons?|add-ons/, "Add-ons", "General add-ons", "add-ons"],
];
const CATERING = /cater|tray|a la carte|deluxe salad|salad toppings|individual|10 pieces/i;
const DQ = [ // data-quality notes
  [/\(copy\)|\(deep copy\)/i, "duplicate copy of another group"],
  [/chooose|catrering/i, "spelling error in the group name"],
  [/\(curated\)/i, "curated variant of the general add-ons group"],
  [/pick same or combo|same or combo/i, "naming variant of 'Choose 2 Proteins'"],
  [/up to (3|6)/i, "naming variant of 'Choose Sauce' (selection limit in name)"],
];
// A group whose name starts with "Extra" (also "Add: Extra ...") is named "Extra " + the type it would otherwise get.
const EXTRA = /^\s*(add\s*:\s*)?extra\b/i;
const extraLabel = (type, sub) => (sub === "Pita type" ? "Extra Pita" : sub === "Hummus type" ? "Extra Hummus" : `Extra ${type}`);
const classify = (name) => {
  const n = name.toLowerCase();
  const isExtra = EXTRA.test(name);
  // classify on the name without the "Extra" prefix so "Extra Sauce Cup" -> Sauce, "Extra Pita Bread" -> Pita
  const hit = RULES.find((r) => r[0].test(isExtra ? n.replace(/^\s*(add\s*:\s*)?extra\b\s*/, "") : n));
  const notes = DQ.filter((d) => d[0].test(name)).map((d) => d[1]);
  const context = CATERING.test(name) ? "Catering" : "Retail";
  if (!hit) return { type: "REVIEW", sub: "REVIEW", rule: "no rule", context, notes: notes.join("; ") };
  if (isExtra) {
    const t = extraLabel(hit[1], hit[2]);
    return { type: t, sub: t, rule: 'name starts with "Extra"', context, notes: notes.join("; ") };
  }
  return { type: hit[1], sub: hit[2], rule: hit[3], context, notes: notes.join("; ") };
};
module.exports = { classify, RULES, CATERING };
