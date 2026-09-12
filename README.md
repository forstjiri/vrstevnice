# Vrstevnice — uživatelská dokumentace

Cyklistický plánovač tras s 3D terénem, vrstevnicemi, profilovým grafem a animací jízdy. Všechna data jsou lokální — žádné cloud API, žádné externí závislosti.

## Nejzajímavější funkce

### Plánování tras

- **4 parametry trasy** — posuvníky nastavíte, co preferujete:
  - *Vyhnout se kopcům* — GraphHopper penalizuje strmé svahy
  - *Vyhýbání silnicím* — dálnice a hlavní silnice jsou penalizovány
  - *Cyklostezky* — upřednostňuje cesty s taggingem `cycleway`
  - *Limonádová cesta* — najde hospody, bary a restaurace podél trasy a přepočítá trasu přes ně

- **Drag & drop zastávek** — tažením markerů na mapě upravíte souřadnice zastávky
- **GPX export** — stažení trasy jako GPX 1.1 s nadmořskou výškou

### 3D mapa

- **3D terén** — DEM data z ČÚZK DMR 5G, nastavitelná exacerbacce (posuvník)
- **Vrstevnice** — generované z DEM dat přes maplibre-contour protokol, zobrazené přímo na mapě
- **Hillshade** — sluneční osvětlení podle data/času — posuvníkem nastavíte libovolný den a čas a terén se překreslí se stíny
- **Nocní overlay** — automatické ztmavení mapy při západu/východu slunce podle zvoleného data/času
- **Cyklistické stylování** — dálnice a hlavní silnice jsou zeslabeny, lesní cesty naopak zvýrazněny (viditelné od zoom 12+)
- **KČT cyklostezky** — barevné překrytí 3510 tras z OpenStreetMap

### Profilový graf

- **Barva podle povrchu** — plocha pod křivkou je obarvená podle typu cesty (asfalt = šedá, štěrk = béžová, tráva = zelená, …)
- **Barva čáry podle typu cesty** —钗ra profilu se mění: path = hnědá přerušovaná, cycleway = růžová přerušovaná, track = olivová plná, …
- **Hover sync** — najedete-li myší na graf, zobrazí se kříž na mapě a naopak
- **České popisky os** — vzdálenost v km, nadmořská výška v m n.m.

### Ride Animation

- **Přehrávání trasy** — tlačítko play spustí animaci jízdy po trase
- **Rychlost** — posuvník 2×–100× pro rychlé přehrání
- **Seek** — kliknutím na graf přesunete animaci na danou pozici
- **Synchronizace stínů** — během animace se stíny na mapě přepočítávají podle virtuálního času jízdy
- **Grafický pruh slunce** — pod profilovým grafem se zobrazuje míra slunečního svitu podél trasy

### Hledání míst

- **Autocomplete** — začněte psát a Photon nabízí návrhy s lokální orientací na střed mapy
- **GPS souřadnice** — zadejte přímo do vyhledávacího pole (DD, DDM i DMS formát) — automaticky se rozpoznají a zreverse-geokódují
- **Náhled na mapě** — při najetí na návrh se zobrazí dočasný modrý marker

### Inspect Mode

- Klávesa `I` zapne inspektor — zobrazí layer ID, source-layer, aktuální zoom a GPS pozici
- Context menu (pravé tlačítko): přidat zastávku, otevřít pozici v Mapy.cz

---

## Jak začít

### Lokální vývoj

```bash
pnpm install
docker compose up -d     # GraphHopper :8989, Photon :2322, tileserver :2323
pnpm dev                 # BE na :3002, FE na :5173
```

### Jednorázový setup po prvním klonu

```bash
bash scripts/generate-tiles.sh          # OpenMapTiles CZ + přesné OSM cesty pro hodnocení
python3 scripts/generate-terrain-tiles-dmr5g.py --output data/cz-terrain.mbtiles  # DMR 5G terrain-rgb
pnpm import-pois                        # SQLite POI databáze z OSM PBF (pivnice, bary, restaurace)
pnpm extract-routes                     # KČT cyklostezky z OSM
```

### Testování

```bash
pnpm typecheck    # TypeScript
pnpm test         # Vitest (včetně GH smoke testů)
```

---

## Technické detaily

Pro technickou dokumentaci (architektura, API, gotchas, debug hooks, klíčová architektonická rozhodnutí) viz [AGENTS.md](./AGENTS.md).
