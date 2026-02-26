// ==============================
// RetroCatz POS • Data Helpers
// ==============================

// -------- Formatters ----------
export const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});
export const dollarsToCents = (v) => Math.round(parseFloat(v || 0) * 100);
export const centsToDollars = (v) => (parseInt(v || 0, 10) / 100);

// -------- Curated title lists (for autocomplete) ----------
export const TOP_TITLES = {
  NES: [
    'Super Mario Bros.', 'Super Mario Bros. 2', 'Super Mario Bros. 3',
    'The Legend of Zelda', 'Zelda II: The Adventure of Link', 'Metroid',
    'Kid Icarus', 'Kirby\'s Adventure', 'Mega Man', 'Mega Man 2', 'Mega Man 3',
    'Contra', 'Super C', 'Castlevania', 'Castlevania II: Simon\'s Quest',
    'Castlevania III: Dracula\'s Curse', 'Punch-Out!!', 'Mike Tyson\'s Punch-Out!!',
    'River City Ransom', 'Ninja Gaiden', 'Ninja Gaiden II', 'Battletoads',
    'Blaster Master', 'DuckTales', 'Double Dragon', 'Double Dragon II',
    'Bubble Bobble', 'Crystalis', 'Dragon Warrior', 'StarTropics',
    'Excitebike', 'Tecmo Bowl', 'Rad Racer', 'Adventure Island', 'Ghosts \'n Goblins',
    'RC Pro-Am', 'Marble Madness', 'Baseball Stars', 'Spy Hunter', 'Tetris',
    'Dr. Mario', 'Gunsmoke', 'Metal Gear', 'Legendary Wings', 'Lifeforce',
    'Q*Bert', 'Gauntlet', 'Paperboy', 'Jaws', 'Rampage'
  ],
  SNES: [
    'Super Mario World', 'Super Mario World 2: Yoshi\'s Island',
    'The Legend of Zelda: A Link to the Past', 'Super Metroid',
    'Chrono Trigger', 'Final Fantasy II', 'Final Fantasy III',
    'Donkey Kong Country', 'Donkey Kong Country 2', 'Donkey Kong Country 3',
    'Super Mario RPG', 'EarthBound', 'Mega Man X', 'Mega Man X2', 'Mega Man X3',
    'Street Fighter II', 'Super Street Fighter II', 'F-Zero', 'Kirby Super Star',
    'Secret of Mana', 'Illusion of Gaia', 'ActRaiser', 'Super Castlevania IV',
    'Star Fox', 'Super Ghouls \'n Ghosts', 'Pilotwings', 'Turtles in Time',
    'Harvest Moon', 'Lufia II', 'Breath of Fire II', 'Super Bomberman',
    'Super Mario Kart', 'SimCity', 'Mystic Quest', 'Dragon Quest VI',
    'Uniracers', 'Demon\'s Crest', 'Sunset Riders', 'Contra III',
    'Terranigma', 'Shadowrun', 'Pocky & Rocky', 'Secret of Evermore',
    'Super Tennis', 'NBA Jam', 'ClayFighter', 'Wild Guns', 'Mario Paint',
    'Super Punch-Out!!'
  ],
  N64: [
    'Super Mario 64', 'The Legend of Zelda: Ocarina of Time',
    'The Legend of Zelda: Majora\'s Mask', 'GoldenEye 007', 'Perfect Dark',
    'Mario Kart 64', 'Star Fox 64', 'Paper Mario', 'Banjo-Kazooie',
    'Banjo-Tooie', 'Donkey Kong 64', 'Super Smash Bros.', 'Wave Race 64',
    '1080° Snowboarding', 'Diddy Kong Racing', 'F-Zero X',
    'Conker\'s Bad Fur Day', 'Pokemon Stadium', 'Ogre Battle 64',
    'Mario Party', 'Mario Party 2', 'Mario Party 3', 'Blast Corps',
    'Jet Force Gemini', 'Turok: Dinosaur Hunter', 'Turok 2', 'Body Harvest',
    'Shadow Man', 'Resident Evil 2', 'Harvest Moon 64', 'Snowboard Kids',
    'Cruis\'n USA', 'Cruis\'n World', 'Beetle Adventure Racing', 'WWF No Mercy',
    'WCW/NWO Revenge', 'Mario Golf', 'Mario Tennis', 'Pilotwings 64',
    'Excitebike 64', 'Gauntlet Legends', 'Quake II', 'Star Wars: Rogue Squadron',
    'Star Wars: Shadows of the Empire', 'Tony Hawk\'s Pro Skater',
    'Tony Hawk\'s Pro Skater 2', 'Rush 2049', 'Forsaken 64'
  ],
  'PlayStation': [
    'Final Fantasy VII', 'Final Fantasy VIII', 'Final Fantasy IX',
    'Metal Gear Solid', 'Resident Evil', 'Resident Evil 2', 'Resident Evil 3',
    'Castlevania: Symphony of the Night', 'Crash Bandicoot', 'Crash Bandicoot 2',
    'Crash Bandicoot: Warped', 'CTR: Crash Team Racing', 'Spyro the Dragon',
    'Spyro 2: Ripto\'s Rage', 'Spyro: Year of the Dragon', 'Gran Turismo',
    'Gran Turismo 2', 'Tony Hawk\'s Pro Skater 2', 'Vagrant Story', 'Parasite Eve',
    'Parasite Eve II', 'Xenogears', 'Suikoden II', 'Tomb Raider', 'Tomb Raider II',
    'Tomb Raider III', 'Driver', 'Driver 2', 'Twisted Metal 2', 'Twisted Metal 4',
    'Legacy of Kain: Soul Reaver', 'Oddworld: Abe\'s Oddysee', 'Oddworld: Abe\'s Exoddus',
    'Wild Arms', 'Lunar: Silver Star Story Complete', 'Alundra', 'Chrono Cross',
    'Silent Hill', 'Resident Evil Survivor', 'Dino Crisis', 'Front Mission 3',
    'Einhander', 'Fear Effect', 'Bushido Blade', 'Tenchu: Stealth Assassins',
    'Grandia', 'Breath of Fire IV', 'Star Ocean: The Second Story', 'Mega Man Legends'
  ],
  'PlayStation 2': [
    'Grand Theft Auto: San Andreas', 'Grand Theft Auto: Vice City',
    'Grand Theft Auto III', 'Metal Gear Solid 2', 'Metal Gear Solid 3',
    'Shadow of the Colossus', 'ICO', 'Final Fantasy X', 'Final Fantasy XII',
    'Kingdom Hearts', 'Kingdom Hearts II', 'Devil May Cry', 'Devil May Cry 3',
    'Gran Turismo 3', 'Gran Turismo 4', 'Jak and Daxter', 'Jak II', 'Jak 3',
    'Ratchet & Clank', 'God of War', 'God of War II', 'Okami', 'Persona 3',
    'Persona 4', 'Midnight Club 3', 'Need for Speed Underground 2',
    'Silent Hill 2', 'Silent Hill 3', 'Max Payne', 'Bully', 'Manhunt',
    'Guitar Hero II', 'Burnout 3: Takedown', 'Tony Hawk\'s Underground',
    'The Sims 2', 'TimeSplitters 2', 'Resident Evil 4', 'Resident Evil Outbreak',
    'Final Fantasy XI', 'Prince of Persia: Sands of Time', 'Sly Cooper',
    'Sly 2: Band of Thieves', 'Dragon Quest VIII', 'Dark Cloud', 'Dark Cloud 2',
    'Disgaea', 'Xenosaga Episode I', 'Xenosaga Episode II', 'Fatal Frame 2'
  ],
  GameCube: [
    'Super Smash Bros. Melee', 'Metroid Prime', 'Metroid Prime 2',
    'The Legend of Zelda: The Wind Waker', 'Twilight Princess',
    'Resident Evil 4', 'Resident Evil Remake', 'Luigi\'s Mansion',
    'Pikmin', 'Pikmin 2', 'Mario Kart: Double Dash!!',
    'Paper Mario: The Thousand-Year Door', 'F-Zero GX', 'Star Fox Adventures',
    'Fire Emblem: Path of Radiance', 'Skies of Arcadia Legends', 'Viewtiful Joe',
    'Soul Calibur II', 'Animal Crossing', 'Super Monkey Ball', 'Super Monkey Ball 2',
    'Sonic Adventure 2 Battle', 'Billy Hatcher and the Giant Egg', 'Baten Kaitos',
    'Eternal Darkness', 'Chibi-Robo!', 'Tales of Symphonia', 'Mario Party 6',
    'Mario Party 7', 'Wave Race: Blue Storm', 'NBA Street Vol. 2', 'Resident Evil Zero',
    'Custom Robo', '1080° Avalanche', 'Beach Spikers', 'Lost Kingdoms II'
  ],
  Xbox: [
    'Halo: Combat Evolved', 'Halo 2', 'Fable', 'Ninja Gaiden Black',
    'Star Wars: Knights of the Old Republic', 'KOTOR II', 'Jade Empire',
    'Forza Motorsport', 'Project Gotham Racing 2', 'Psychonauts',
    'Crimson Skies: High Road to Revenge', 'Burnout 3', 'Morrowind',
    'Splinter Cell', 'Splinter Cell: Chaos Theory', 'Dead or Alive 3',
    'DOA Ultimate', 'Panzer Dragoon Orta', 'Doom 3', 'Serious Sam',
    'TimeSplitters Future Perfect', 'Otogi', 'Mercenaries: Playground of Destruction',
    'The Warriors', 'Max Payne 2', 'Midtown Madness 3', 'RalliSport Challenge 2'
  ],
  'Xbox 360': [
    'Halo 3', 'Halo: Reach', 'Gears of War', 'Gears of War 2', 'Gears of War 3',
    'Forza Motorsport 3', 'Forza Motorsport 4', 'Red Dead Redemption', 'Skyrim',
    'Fallout 3', 'Fallout: New Vegas', 'Mass Effect', 'Mass Effect 2',
    'Call of Duty 4: Modern Warfare', 'Modern Warfare 2', 'Black Ops',
    'Portal 2', 'Bioshock', 'Bioshock Infinite', 'Alan Wake',
    'Left 4 Dead', 'Left 4 Dead 2', 'Borderlands', 'Borderlands 2',
    'Oblivion', 'Assassin\'s Creed II', 'Far Cry 3', 'Battlefield 3',
    'GTA IV', 'GTA V', 'FIFA 12', 'Madden NFL 10', 'Just Cause 2',
    'Dead Rising', 'Saints Row 2', 'Saints Row 3', 'Mirror\'s Edge',
    'Dark Souls', 'Bayonetta'
  ],
  Switch: [
    'The Legend of Zelda: Breath of the Wild', 'Tears of the Kingdom',
    'Super Mario Odyssey', 'Mario Kart 8 Deluxe', 'Smash Bros. Ultimate',
    'Animal Crossing: New Horizons', 'Metroid Dread', 'Fire Emblem: Three Houses',
    'Splatoon 3', 'Pikmin 4', 'Kirby and the Forgotten Land',
    'Super Mario RPG (Remake)', 'Bayonetta 3', 'Octopath Traveler',
    'Octopath Traveler II', 'Triangle Strategy', 'Pokemon Sword', 'Pokemon Shield',
    'Pokemon Scarlet', 'Pokemon Violet', 'Luigi\'s Mansion 3',
    'Mario Party Superstars', 'Paper Mario: The Origami King',
    'Donkey Kong Country: Tropical Freeze', 'Astral Chain', 'Mario Golf: Super Rush'
  ]
};

// -------- Platforms / Categories / Conditions ----------
export const ALL_PLATFORMS = [
  // Nintendo home consoles
  'NES','SNES','N64','GameCube','Wii','Wii U','Switch',

  // Nintendo handhelds
  'Game Boy',
  'Game Boy Color',
  'Game Boy Advance',
  'Nintendo DS',
  'Nintendo 3DS',

  // PlayStation (home + handheld)
  'PlayStation',
  'PlayStation 2',
  'PlayStation 3',
  'PlayStation 4',
  'PlayStation 5',
  'PSP',
  'PS Vita',

  // Xbox
  'Xbox',
  'Xbox 360',
  'Xbox One',
  'Xbox Series X/S',

  // Sega / Legacy systems
  'Sega Genesis',
  'Sega Dreamcast',
  'Atari 2600',
  'Game Gear',
  'Neo Geo Pocket',
  'Atari Lynx',

  // Movie formats
  'VHS',
  'DVD',
  'Blu-ray',
  '4K UHD',
  'LaserDisc',
  'HD-DVD',

  // Music formats
  'CD',
  'Vinyl',
  'Cassette',
  '8-Track',
  'MiniDisc',
  'Reel-to-Reel',

  // Catch-all
  'Other'
];

export const CATEGORIES = ['Games','Console','Accessory','Apparel','Music','Movie','Other'];
export const CONDITIONS = ['New','Like New','Very Good','Good','Acceptable','Poor'];

// ========== Local persistence (IndexedDB) ==========
const DB_NAME = 'retrocatz_pos';
const STORE_ITEMS = 'items';
const STORE_GROUPS = 'groups'; // maps groupKey -> sku (for Accessory grouping)

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        db.createObjectStore(STORE_ITEMS, { keyPath: 'sku' });
      }
      if (!db.objectStoreNames.contains(STORE_GROUPS)) {
        db.createObjectStore(STORE_GROUPS); // key is groupKey (string)
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, storeName, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const out = fn(store);
    tx.oncomplete = () => resolve(out?.result ?? out);
    tx.onerror = () => reject(tx.error);
  });
}

// -------- Items CRUD ----------
export async function skuExists(sku) {
  return withStore('readonly', STORE_ITEMS, (store) => {
    return new Promise((resolve, reject) => {
      const req = store.get(String(sku));
      req.onsuccess = () => resolve(!!req.result);
      req.onerror = () => reject(req.error);
    });
  });
}

export async function generateUniqueSku() {
  let tries = 0;
  while (tries++ < 200) {
    const sku = String(Math.floor(10000000 + Math.random() * 90000000)).slice(0, 8);
    if (!(await skuExists(sku))) return sku;
  }
  throw new Error('Could not generate unique SKU');
}

export async function findSkuForNewTitle(title) {
  const list = await getAllItems();
  const t = String(title || '').trim().toLowerCase();
  const match = list.find(i => (i.title || '').trim().toLowerCase() === t && i.condition === 'New');
  return match ? match.sku : null;
}

export async function getAllItems() {
  return withStore('readonly', STORE_ITEMS, (store) => {
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  });
}

export async function addItem(item) {
  return withStore('readwrite', STORE_ITEMS, (store) => {
    return new Promise((resolve, reject) => {
      const req = store.put(item);
      req.onsuccess = () => resolve(item);
      req.onerror = () => reject(req.error);
    });
  });
}

export async function updateItem(sku, patch) {
  const current = (await withStore('readonly', STORE_ITEMS, (store) => {
    return new Promise((resolve, reject) => {
      const req = store.get(String(sku));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  })) || {};
  const next = { ...current, ...patch, sku: String(sku) };
  return withStore('readwrite', STORE_ITEMS, (store) => {
    return new Promise((resolve, reject) => {
      const req = store.put(next);
      req.onsuccess = () => resolve(next);
      req.onerror = () => reject(req.error);
    });
  });
}

// -------- Grouping helpers (for Accessory Category) ----------
export function makeGroupKey({ category, platform, title }) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  return `v1|${norm(category)}|${norm(platform)}|${norm(title)}`;
}

export async function getOrCreateSkuForGroupKey(groupKey) {
  // Try existing mapping
  const existing = await withStore('readonly', STORE_GROUPS, (store) => {
    return new Promise((resolve, reject) => {
      const req = store.get(groupKey);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  });
  if (existing) return existing; // existing is stored directly as the SKU string

  // Create a new SKU and store the mapping
  const sku = await generateUniqueSku();
  await withStore('readwrite', STORE_GROUPS, (store) => {
    return new Promise((resolve, reject) => {
      const req = store.put(sku, groupKey);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  });
  return sku;
}

// -------- Barcode size preference ----------
const BARCODE_KEY = 'retrocatz_barcode_inches';
export const getPreferredBarcodeInches = () => parseFloat(localStorage.getItem(BARCODE_KEY) || '1');
export const setPreferredBarcodeInches = (val) => localStorage.setItem(BARCODE_KEY, String(val));
