Vytvoření moderního stacku pro webovou aplikaci.

Ze začátku OSM mapa s polohou z bowser api.
Vlevo pole pro přidávání zastávek s autocomplete

Po přidání zastavék tlačítko vytvořit trasu které zavolá na backend výpočet trasy a ta se pak zobrazí na mapě
Při výpočtu se bude pomocí nějakého koeficientu brát stoupání/klesání

Frontend složka - src/fe
Backend - src/be
Použij pnpm workspaces shared dependencies (hlavně kvůli type safety s eden)

Obojí instalace pnpm

Neranspiluj do starého js, používej nejmodernější js moduly.

Pokud jde nějaká konfigurace mít v package.json, nevytvářej nové soubory. 
Chci mít v repo co nejméně různých config souborů ať se tu vyznám.

Požadované technologie 
- elysiajs
- bun
- drizzle
- bun sqlite
- elysiajs eden
- vite 8
- SolidJS
- kobalte UI 
- https://valhalla.github.io/valhalla/README_nodejs/ pro pathfinding



