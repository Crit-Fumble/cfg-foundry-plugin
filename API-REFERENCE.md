# Crit-Fumble Core - API Client Reference

**Version:** 1.0.0
**Updated:** 2026-02-15 (predates 2026-05 platform refactor — see banner below)

> ⚠️ **Out of date.** This reference still describes the pre-refactor Realm /
> Locations / RotFS APIs. The platform completed a `Realm → GameWorld` migration
> in May 2026: `CoreRealm` + Realm Manager + 26 components were deleted, and
> `CoreGameWorld` now owns the concept. The `realms-of-the-5th-system` module
> and the `getPlanetRealms` / `generateRotFSRealm` endpoints below are retired.
> The current GameWorld surface is documented in cfg-core-server's
> `src/routes/v1/account/game-worlds.ts`; this file will be rewritten when the
> plugin is realigned. Treat everything below as historical until then.

The Core API Client provides comprehensive access to Crit-Fumble Gaming platform features from FoundryVTT.

## Accessing the API Client

```javascript
// From crit-fumble-core module
const apiClient = window.CritFumbleCore.apiClient

// From realms-of-the-5th-system module
const apiClient = window.ROTFS.apiClient
```

## Authentication

The API client is automatically initialized with your configured API token from module settings.

```javascript
// Check if API is initialized
if (!window.CritFumbleCore.apiClient) {
  ui.notifications.warn('API client not configured. Set your API token in module settings.')
}
```

---

## API Methods

### Campaigns

```javascript
// Get all campaigns
const { campaigns } = await apiClient.getCampaigns()

// Get specific campaign
const campaign = await apiClient.getCampaign(campaignId)

// Create campaign
const newCampaign = await apiClient.createCampaign({
  name: 'My Campaign',
  systemId: 'dnd5e',
  guildId: 'my-guild-id',
})

// Update campaign
await apiClient.updateCampaign(campaignId, { description: 'Updated' })

// Sync campaign config
await apiClient.syncCampaignConfig(campaignId, { vtt: 'foundry' })
```

### Campaign Players & Parties

```javascript
// Get campaign players
const { players } = await apiClient.getCampaignPlayers(campaignId)

// Get parties
const { parties } = await apiClient.getCampaignParties(campaignId)

// Get party members
const { members } = await apiClient.getPartyMembers(campaignId, partyId)

// Create party
const party = await apiClient.createParty(campaignId, {
  name: 'The Fellowship',
  type: 'adventure',
})
```

### Scales

```javascript
// Get all scales
const { scales } = await apiClient.getScales()

// Get specific scale
const scale = await apiClient.getScale('building-5ft')

// Get game data scales (includes RotFS scales)
const scales = await apiClient.getGameDataScales()
```

### Universes

```javascript
// Get all universes
const { universes } = await apiClient.getUniverses()

// Get specific universe
const universe = await apiClient.getUniverse('cfg-xviii')

// Get locations in universe
const { locations } = await apiClient.getUniverseLocations('cfg-xviii', {
  scaleId: 'planet-10mm',
  type: 'planet',
})

// Get planets
const { planets } = await apiClient.getUniversePlanets('cfg-xviii')

// Get planet realms
const { realms } = await apiClient.getPlanetRealms('cfg-xviii', 'earth')
```

### Locations

```javascript
// Get locations
const { locations } = await apiClient.getLocations({
  universeId: 'cfg-xviii',
  scaleId: 'settlement-50ft',
})

// Get specific location
const location = await apiClient.getLocation(locationId)

// Drill down (get child scale content)
const childLocation = await apiClient.drillDownLocation(locationId, {
  x: 5,
  y: 3,
})

// Extend (get adjacent content at same scale)
const extended = await apiClient.extendLocation(locationId, {
  direction: 'north',
  distance: 10,
})

// Get parent location
const parent = await apiClient.getParentLocation(locationId)

// Get location images
const { images } = await apiClient.getLocationImages(locationId)

// Upload location image
const formData = new FormData()
formData.append('image', imageFile)
await apiClient.uploadLocationImage(locationId, formData)

// Get location calendars
const { calendars } = await apiClient.getLocationCalendars(locationId)

// Get location scenes
const { scenes } = await apiClient.getLocationScenes(locationId)

// Sync scene to Foundry
await apiClient.syncLocationScene(locationId, sceneId)
```

### Characters

```javascript
// Get characters
const { characters } = await apiClient.getCharacters({
  universeId: 'cfg-xviii',
  ownerId: game.user.id,
})

// Get specific character
const character = await apiClient.getCharacter(characterId)

// Create character
const newChar = await apiClient.createCharacter({
  universeId: 'cfg-xviii',
  gameSystemId: 'dnd5e',
  name: 'Thorin Ironforge',
  characterRole: 'pc',
})

// Update character
await apiClient.updateCharacter(characterId, {
  level: 2,
  xp: 300,
})
```

### Calendars

```javascript
// Get calendars
const { calendars } = await apiClient.getCalendars()

// Get specific calendar
const calendar = await apiClient.getCalendar(calendarId)

// Advance time
await apiClient.advanceCalendar(calendarId, {
  amount: 8,
  unit: 'hours',
})

// Change mode
await apiClient.updateCalendarMode(calendarId, 'combat')
```

### Knowledge Base

```javascript
// Search KB
const { articles } = await apiClient.searchKnowledgeBase({
  query: 'ships',
  system: 'dnd5e',
  category: 'rules',
  tags: ['naval', 'combat'],
})

// Get article by slug
const article = await apiClient.getKBArticle('dnd5e/rotfs/ships/types')

// Get categories
const { categories } = await apiClient.getKBCategories('dnd5e')

// Get tags
const { tags } = await apiClient.getKBTags('dnd5e')
```

### Creatures, Things, Events, Forces

```javascript
// Creatures
const { creatures } = await apiClient.getCreatures({ scaleId: 'normal' })
const creature = await apiClient.getCreature(creatureId, 'dnd5e')
await apiClient.updateCreature(creatureId, { hp: 50 })

// Things (items, equipment, vehicles)
const { things } = await apiClient.getThings({ category: 'vehicle' })
const thing = await apiClient.getThing(thingId, 'dnd5e')

// Events
const { events } = await apiClient.getEvents({ campaignId })
const event = await apiClient.getEvent(eventId)

// Forces (organizations, factions)
const { forces } = await apiClient.getForces({ campaignId })
const force = await apiClient.getForce(forceId)
```

### FoundryVTT Worlds

```javascript
// Get worlds
const { worlds } = await apiClient.getWorlds()

// Get specific world
const world = await apiClient.getWorld(worldId)

// Create world
const world = await apiClient.createWorld({
  name: 'My World',
  system: 'dnd5e',
  campaignId: campaignId,
})

// Update world
await apiClient.updateWorld(worldId, { description: 'Updated' })

// Get world GMs
const { gms } = await apiClient.getWorldGMs(worldId)

// Get available campaigns for world
const { campaigns } = await apiClient.getAvailableCampaigns(worldId)
```

---

## RotFS Game Data

### Core RotFS Data

```javascript
// Overview
const rotfs = await apiClient.getRotFSData()

// Rooms
const rooms = await apiClient.getRotFSRooms({
  category: 'vehicle',
  quality: 'aristocratic',
  scale: 'room',
})

// Ships
const ships = await apiClient.getRotFSShips({ type: 'warship' })
const shipMgmt = await apiClient.getRotFSShipManagement()
const crew = await apiClient.getRotFSCrew()

// Buildings & Settlements
const buildings = await apiClient.getRotFSBuildings()
const settlements = await apiClient.getRotFSSettlements()
const population = await apiClient.getRotFSSettlementPopulation()

// Combat
const combat = await apiClient.getRotFSCombat()

// Trade & Resources
const tradeGoods = await apiClient.getRotFSTradeGoods()
const materials = await apiClient.getRotFSMaterials()
const liquids = await apiClient.getRotFSLiquids()
const containers = await apiClient.getRotFSContainers()
const resources = await apiClient.getRotFSResources()

// Treasure & Magic
const treasure = await apiClient.getRotFSTreasure()
const magicItems = await apiClient.getRotFSMagicItems()
const equipmentPacks = await apiClient.getRotFSEquipmentPacks()

// Other
const poisons = await apiClient.getRotFSPoisons()
const mounts = await apiClient.getRotFSMounts()
const deities = await apiClient.getRotFSDeities()
```

### RotFS Generators

```javascript
// Wilderness
const wilderness = await apiClient.generateRotFSWilderness({
  scale: 'settlement-50ft',
  terrain: 'forest',
  climate: 'temperate',
})

// Building
const building = await apiClient.generateRotFSBuilding({
  type: 'tavern',
  quality: 'comfortable',
  size: 'medium',
})

// Settlement
const settlement = await apiClient.generateRotFSSettlement({
  size: 'town',
  terrain: 'plains',
  economy: 'trade',
})

// City
const city = await apiClient.generateRotFSCity({
  size: 'large',
  government: 'republic',
})

// Province
const province = await apiClient.generateRotFSProvince({
  terrain: 'mixed',
  population: 'dense',
})

// Kingdom
const kingdom = await apiClient.generateRotFSKingdom({
  government: 'monarchy',
  strength: 'strong',
})

// Continent
const continent = await apiClient.generateRotFSContinent({
  climate: 'varied',
  landmass: 'large',
})

// Realm (world)
const realm = await apiClient.generateRotFSRealm({
  type: 'terrestrial',
  magic: 'high',
})

// Planet
const planet = await apiClient.generateRotFSPlanet({
  type: 'terrestrial',
  atmosphere: 'breathable',
})

// NPC
const npc = await apiClient.generateRotFSNPC({
  role: 'merchant',
  level: 3,
  race: 'human',
})
```

---

## Core D&D 5E Data

```javascript
// Classes
const classes = await apiClient.getDnD5eClasses()

// Equipment
const equipment = await apiClient.getDnD5eEquipment()

// Magic
const magic = await apiClient.getDnD5eMagic()

// Loot tables
const loot = await apiClient.getDnD5eLoot()

// Progression
const progression = await apiClient.getDnD5eProgression()

// Species
const species = await apiClient.getDnD5eSpecies()

// NPCs
const npcs = await apiClient.getDnD5eNPCs()

// Encounters
const encounters = await apiClient.getDnD5eEncounters()

// Complete bundle (for offline use)
const bundle = await apiClient.getGameSystemBundle('dnd5e')
```

---

## Error Handling

```javascript
try {
  const campaign = await apiClient.getCampaign(campaignId)
} catch (error) {
  console.error('API Error:', error.message)
  ui.notifications.error(`Failed to load campaign: ${error.message}`)
}
```

---

## Best Practices

1. **Check for API Client**

   ```javascript
   if (!window.CritFumbleCore?.apiClient) {
     ui.notifications.warn('Core API not configured')
     return
   }
   ```

2. **Use Async/Await**

   ```javascript
   async function loadData() {
     const data = await apiClient.getRotFSShips()
     return data
   }
   ```

3. **Cache Data**

   ```javascript
   // Cache frequently accessed data
   if (!game.rotfs.ships) {
     game.rotfs.ships = await apiClient.getRotFSShips()
   }
   ```

4. **Error Boundaries**
   ```javascript
   try {
     const data = await apiClient.someMethod()
   } catch (error) {
     ui.notifications.error('Operation failed')
     console.error(error)
   }
   ```

---

## Configuration

Set your API token in module settings:

1. Go to **Game Settings** → **Configure Settings**
2. Find **Crit-Fumble Core** module
3. Enter **Core API URL**: `https://core.crit-fumble.com`
4. Enter **Core API Token**: Your personal API token

---

## Support

- **API Docs**: https://core.crit-fumble.com/api/docs
- **GitHub** (current): https://github.com/Crit-Fumble/cfg-core-server (server) · https://github.com/Crit-Fumble/cfg-core-browser (browser app). The old monorepo at `Crit-Fumble/core.crit-fumble.com` is retired.
- **Discord**: https://discord.gg/D6vVANEJ3w
