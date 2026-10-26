# Vrstevnice — uživatelská dokumentace

Cyklistický plánovač tras s 3D terénem, vrstevnicemi, profilovým grafem a animací jízdy. Všechna data jsou lokální — žádné cloud API, žádné externí závislosti.
---- --
Tohle repo vzniklo spoluprací s Codex kde jsem já nastavil jakou architekturu bude mít a iterativně jsem dělal vylepšení a refaktoring.
Všechno ale zdaleka není čisté jak bych si přál, do budu spíše než nové funkce znovu procházet existující kod a hledat vylepšení tak aby se v tom vyznal každý.

Pokud narazíte na chybu, budu vděčný za repport do `Issues`. 
Hlašte klidně i návrhy na zlepšení trasování, takový report by měl obsahovat počáteční a konečný bod, vybrané parametry a navrženou vs požadovanou trasu.

<p>
  <a href="media/main_planning.png"><img src="media/main_planning.png" width="200" alt="Hlavní plánování trasy"></a>
  <a href="media/height_profile_graph.png"><img src="media/height_profile_graph.png" width="200" alt="Profilový graf"></a>
  <a href="media/pubs_along_way.png"><img src="media/pubs_along_way.png" width="200" alt="Limonádová cesta"></a>
  <a href="media/road_rating_overview.png"><img src="media/road_rating_overview.png" width="200" alt="Hodnocení cest"></a>
  <a href="media/road_rating_modal.png"><img src="media/road_rating_modal.png" width="200" alt="Modal hodnocení cest"></a>
  <video src="media/terain_shading_by_time.mp4" controls width="200" alt="Stínování terénu podle času"><a href="media/terain_shading_by_time.mp4">Video: stínování terénu podle času</a></video>
  <video src="media/follow_road.mp4" controls width="200" alt="Animace jízdy po trase"><a href="media/follow_road.mp4">Video: animace jízdy po trase</a></video>
</p>

## Nejzajímavější funkce

### Plánování tras

- **4 parametry trasy** — posuvníky nastavíte, co preferujete:
  - *Vyhnout se kopcům* — GraphHopper penalizuje strmé svahy
  - *Vyhýbání silnicím* — dálnice a hlavní silnice jsou penalizovány
  - *Cyklostezky* — upřednostňuje cesty s taggingem `cycleway`
  - *Limonádová cesta* — najde hospody, bary a restaurace podél trasy a přepočítá trasu přes ně

- **Drag & drop zastávek** — tažením markerů na mapě upravíte souřadnice zastávky, pořadí zastávek v seznamu lze také změnit tažením (trasa se automaticky přepočítá)
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

### Hodnocení cest

- **Hodnocení cest** — v tomto režimu můžete kliknout na cestu na mapě a ohodnotit ji palcem nahoru nebo dolů s volitelným komentářem
- **Komentáře ostatních** — u hodnocené cesty zobrazíte komentáře komunity a jejich počet
- **Komunitní hodnocení** — po zapnutí volby se hodnocení zohlední při plánování trasy

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
pnpm generate-route-tiles               # cyklotrasy, turistické trasy a rozcestníky z OSM PBF
```

Příkaz potřebuje `uv`, Python 3, Docker a `data/czech-republic-latest.osm.pbf`.
Výsledkem je `data/routes-overlay.mbtiles`; extrahované prvky se předávají Tippecanoe proudem, bez ukládání GeoJSON mezisouborů.

### Testování

```bash
pnpm typecheck    # TypeScript
pnpm test         # Vitest (včetně GH smoke testů)
```

---

## Technické detaily

Pro technickou dokumentaci (architektura, API, gotchas, debug hooks, klíčová architektonická rozhodnutí) viz [AGENTS.md](./AGENTS.md).
