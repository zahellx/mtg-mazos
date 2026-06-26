// Saca todos los mazos de Archidekt y genera data/decks-data.json.
// Corre en Node 18+ (fetch global). Pensado para ejecutarse en GitHub Actions,
// donde no hay restricción de CORS contra Archidekt.

const fs = require("fs");
const path = require("path");
const { DECKS, EXCLUDED_CATEGORIES } = require("./config");

const OUT_FILE = path.join(__dirname, "data", "decks-data.json");

/**
 * Descarga un mazo de Archidekt y lo normaliza a { name, commander, cards }.
 * Agrupa por nombre de carta (suma cantidades) y descarta categorías excluidas.
 */
async function fetchDeck(deck) {
    const res = await fetch(`https://www.archidekt.com/api/decks/${deck.archideck_id}/`);
    if (!res.ok) throw new Error(`Archidekt ${deck.archideck_id}: ${res.status} ${res.statusText}`);
    const data = await res.json();

    const byName = {};
    for (const entry of data.cards) {
        const category = entry.categories?.[0];
        if (EXCLUDED_CATEGORIES.includes(category)) continue;

        const name = entry.card.oracleCard.name;
        const isCommander = (entry.categories || []).includes("Commander");
        if (!byName[name]) {
            byName[name] = { name, quantity: 0, isCommander: false };
        }
        byName[name].quantity += entry.quantity;
        byName[name].isCommander = byName[name].isCommander || isCommander;
    }

    const cards = Object.values(byName).sort((a, b) => a.name.localeCompare(b.name));
    const commander = cards.find((c) => c.isCommander)?.name || null;
    return { name: deck.name || data.name, archideckId: deck.archideck_id, commander, cards };
}

/**
 * Enriquece las cartas con type_line y cmc desde Scryfall (lotes de 75).
 * Es opcional: si falla, la app sigue funcionando sin tipos.
 */
async function enrichWithScryfall(allNames) {
    const names = [...allNames];
    const info = {};
    for (let i = 0; i < names.length; i += 75) {
        const batch = names.slice(i, i + 75);
        try {
            const res = await fetch("https://api.scryfall.com/cards/collection", {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "mtg-mazos/1.0" },
                body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) }),
            });
            if (!res.ok) continue;
            const data = await res.json();
            for (const card of data.data || []) {
                info[card.name] = {
                    type: (card.type_line || card.card_faces?.[0]?.type_line || "").split("—")[0].trim(),
                    cmc: card.cmc ?? 0,
                };
            }
        } catch (e) {
            console.warn(`  ⚠️ Scryfall batch error: ${e.message}`);
        }
        if (i + 75 < names.length) await new Promise((r) => setTimeout(r, 150));
    }
    return info;
}

async function main() {
    console.log(`Descargando ${DECKS.length} mazos de Archidekt...`);
    const settled = await Promise.allSettled(DECKS.map(fetchDeck));

    const decks = [];
    const allNames = new Set();
    settled.forEach((r, i) => {
        if (r.status === "fulfilled") {
            decks.push(r.value);
            r.value.cards.forEach((c) => allNames.add(c.name));
            console.log(`  ✅ ${r.value.name} (${r.value.cards.length} cartas)`);
        } else {
            console.error(`  ❌ ${DECKS[i].name}: ${r.reason.message}`);
        }
    });

    console.log(`Enriqueciendo ${allNames.size} cartas con Scryfall...`);
    const info = await enrichWithScryfall(allNames);
    for (const deck of decks) {
        for (const card of deck.cards) {
            const meta = info[card.name];
            if (meta) {
                card.type = meta.type;
                card.cmc = meta.cmc;
            }
        }
    }

    const payload = {
        generatedAt: new Date().toISOString(),
        deckCount: decks.length,
        decks,
    };
    fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
    console.log(`\n✅ Escrito ${OUT_FILE} (${decks.length} mazos)`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
