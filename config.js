// Lista de mazos a sacar de Archidekt.
//   name: nombre para mostrar en la app.
//   archideck_id: ID del mazo en Archidekt (la decklist debe ser pública).
//
// Mantén esta lista sincronizada con la del repo privado (deck_builder/config.js).
const DECKS = [
    { name: "The Ruinous Powers", archideck_id: 12426508 },
    { name: "Faldorn wolf queen", archideck_id: 12368154 },
    { name: "Mardu Surge", archideck_id: 12673678 },
    { name: "Abzan Armor", archideck_id: 12437001 },
    { name: "Jeskai Striker", archideck_id: 12437012 },
    { name: "Sultai Arisen", archideck_id: 13320369 },
    { name: "Temur Roar", archideck_id: 12436995 },
    { name: "Counter Intelligence", archideck_id: 14835968 },
    { name: "World Shaper", archideck_id: 14835982 },
    { name: "bats bats bats", archideck_id: 13077360 },
    { name: "Limit Break", archideck_id: 16002195 },
    { name: "Elves bite", archideck_id: 17830016 },
    { name: "Blight Curse", archideck_id: 19808971 },
    // manaboxFolder: nombre de la carpeta física en ManaBox si difiere del nombre del mazo.
    { name: "Dance of the Elements", archideck_id: 19558777, manaboxFolder: "Ashiling, the limitless" },
    { name: "Space slivers", archideck_id: 18917225 },
    { name: "Space slivers Budget", archideck_id: 21985209, manaboxFolder: "Space slivers" },
];

// Categorías de Archidekt que NO cuentan como parte del mazo jugable.
const EXCLUDED_CATEGORIES = ["Maybeboard", "Sideboard", "Tokens & Extras"];

module.exports = { DECKS, EXCLUDED_CATEGORIES };
