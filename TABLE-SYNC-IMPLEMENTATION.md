# Table Sync Manager - Implementation Summary

## Overview

The TableSyncManager class synchronizes rollable tables from Core API to FoundryVTT RollTable entities, following the same pattern as QuestSyncManager, EncounterSyncManager, and CharacterSyncManager.

## Files Created/Modified

### New Files

1. **`scripts/table-sync.js`** - Main TableSyncManager class (454 lines)
2. **`docs/TABLE-SYNC.md`** - Comprehensive documentation

### Modified Files

1. **`scripts/api-client.js`**
   - Added `getTables(options)` - Get public system tables
   - Added `getTable(tableId)` - Get specific table
   - Added `getCampaignTables(campaignId, options)` - Get campaign tables
   - Added `rollOnTable(tableId)` - Track roll on public table
   - Added `rollOnCampaignTable(campaignId, tableId)` - Track roll on campaign table

2. **`scripts/module.js`**
   - Imported `TableSyncManager`
   - Added `tableSync: null` to CFG_CORE services
   - Registered `tableSyncEnabled` setting (default: true)
   - Initialized TableSyncManager in `initializeCoreAPI()`
   - Added RollTable context menu hook for "Sync from Core" option

## Implementation Details

### Class Structure

```javascript
export class TableSyncManager {
  constructor(apiClient, partyContext = null)

  // Initialization
  async initialize()
  async ensureTablesFolders()

  // Syncing
  async syncTables()
  async syncSystemTables()
  async syncCampaignTables(campaignId)
  async syncTableToFoundry(table, isCampaignTable)

  // Mapping
  async mapTableToFoundryData(table, isCampaignTable)
  findExistingTable(tableId)

  // Rolling
  async rollOnTable(identifier, options)
  async quickRoll(slug, options)

  // Management
  async refresh()
  async clearSyncedTables()
  getTableInfo(identifier)
}
```

### Folder Organization

Creates the following folder structure in RollTable directory:

**Core Tables/**

- Loot Tables
- Critical Hits
- Critical Fumbles
- Wild Magic
- Random Events
- NPC Generation
- Weather
- Treasure
- Encounters
- Other Tables

**Campaign Tables/** (if campaign linked)

### Table Types Supported

- `loot` - Loot and treasure
- `critical-hit` - Critical hit effects
- `critical-fumble` - Critical fumble/failure
- `wild-magic` - Wild magic surges
- `random-event` - Random events
- `npc-generation` - NPC generation
- `weather` - Weather/environment
- `treasure` - Treasure hoards
- `encounter` - Random encounters
- `other` - Miscellaneous

### Core API Table Structure

```javascript
{
  id: "table_123",
  slug: "crit-hit-melee-rotfs",
  name: "Critical Hit: Melee Weapons",
  description: "Critical hit effects for melee attacks",
  tableType: "critical-hit",
  systemId: "dnd5e",
  diceFormula: "1d20",
  results: [
    {
      range: [1, 5],
      text: "Double damage",
      details: "Roll weapon damage twice",
      reference: "rotfs/combat/critical-hits"
    }
  ],
  category: "combat",
  tags: ["melee", "critical", "rotfs"],
  source: "RotFS",
  isPublic: true
}
```

### Foundry RollTable Structure

Tables are mapped to Foundry format with metadata in flags:

```javascript
{
  name: "Critical Hit: Melee Weapons",
  description: "...",
  formula: "1d20",
  replacement: true,
  displayRoll: true,
  results: [...],
  folder: folderId,
  flags: {
    'crit-fumble-core': {
      tableId: 'table_123',
      tableSlug: 'crit-hit-melee-rotfs',
      tableType: 'critical-hit',
      systemId: 'dnd5e',
      isSyncedTable: true,
      lastSyncedAt: '2026-02-16T...',
      category: 'combat',
      tags: ['melee', 'critical', 'rotfs'],
      source: 'RotFS',
      isPublic: true
    }
  }
}
```

## Features

### Auto-Sync

- Automatically syncs on world load if `tableSyncEnabled` is true
- Syncs public system tables (for supported systems)
- Syncs campaign tables (if campaign is linked)

### Manual Sync

- **Context Menu**: Right-click synced table → "Sync from Core"
- **Console**: `CFGCore.tableSync.refresh()`
- **Setting**: Toggle `tableSyncEnabled` to trigger re-sync

### Rolling

- **Foundry UI**: Roll normally via RollTable directory
- **Console**: `CFGCore.tableSync.quickRoll('crit-hit-melee')`
- **Chat Integration**: Enhanced formatting with details and references
- **Core Tracking**: Optional roll tracking via `syncToCore: true`

### Chat Message Format

When rolling on a table, results are posted with:

- Table name (header)
- Result text (main result)
- Details (if available, italicized)
- Reference link (if available)
- Dice roll visualization

### Management

- **Refresh All**: `CFGCore.tableSync.refresh()`
- **Clear All**: `CFGCore.tableSync.clearSyncedTables()` (GM only)
- **Get Info**: `CFGCore.tableSync.getTableInfo('table-slug')`

## Console API

### Basic Commands

```javascript
// Refresh all tables from Core
CFGCore.tableSync.refresh()

// Quick roll on a table
CFGCore.tableSync.quickRoll('crit-hit-melee')

// Roll with Core tracking
CFGCore.tableSync.rollOnTable('crit-hit-melee', { syncToCore: true })

// Get table information
CFGCore.tableSync.getTableInfo('crit-hit-melee')

// Clear all synced tables (GM only)
CFGCore.tableSync.clearSyncedTables()
```

### Advanced Commands

```javascript
// Manual sync
CFGCore.tableSync.syncTables()

// Sync only system tables
CFGCore.tableSync.syncSystemTables()

// Sync only campaign tables
const campaignId = game.settings.get('crit-fumble-core', 'linkedCampaignId')
CFGCore.tableSync.syncCampaignTables(campaignId)

// Find table by Core ID
CFGCore.tableSync.findExistingTable('table_123')

// Check synced tables count
CFGCore.tableSync.syncedTables.size
```

## Integration Points

### Module Settings

- `tableSyncEnabled` - Enable/disable auto-sync (default: true)
- `coreApiToken` - Required for API access
- `linkedCampaignId` - Required for campaign tables

### API Client

Five new methods added to CoreAPIClient:

1. `getTables(options)` - GET /api/tables
2. `getTable(tableId)` - GET /api/tables/:id
3. `getCampaignTables(campaignId, options)` - GET /api/campaigns/:id/tables
4. `rollOnTable(tableId)` - POST /api/tables/:id/roll
5. `rollOnCampaignTable(campaignId, tableId)` - POST /api/campaigns/:id/tables/:id/roll

### Context Menu

Added to `getRollTableDirectoryEntryContext` hook:

- **Sync from Core** - Refresh individual table from Core API
- Only visible for synced tables (with `isSyncedTable` flag)
- GM only

## Future Enhancements

Potential improvements:

1. **Compendium Sync**: Sync tables to compendiums instead of world
2. **Selective Sync**: Choose which table categories to sync
3. **Roll History**: Track and display roll statistics
4. **Table Creation**: Create tables in Foundry and push to Core
5. **Weighted Results**: Support weighted results (not just ranges)
6. **Nested Tables**: Tables that reference other tables
7. **Image Results**: Support for image-based results
8. **Sound Effects**: Sound effects for specific table types

## Testing Checklist

### Initialization

- [ ] Tables sync on world load when enabled
- [ ] Folder structure created correctly
- [ ] System tables sync (for dnd5e)
- [ ] Campaign tables sync (when campaign linked)

### Syncing

- [ ] Existing tables update correctly
- [ ] New tables create successfully
- [ ] Table metadata stored in flags
- [ ] Folder organization correct

### Rolling

- [ ] Roll via Foundry UI works
- [ ] Roll via console works
- [ ] Chat messages formatted correctly
- [ ] Details and references display
- [ ] Core tracking works (when enabled)

### Management

- [ ] Context menu "Sync from Core" works
- [ ] Refresh command works
- [ ] Clear command works (GM only)
- [ ] Get info command works

### Settings

- [ ] Toggle tableSyncEnabled triggers refresh
- [ ] Auto-sync respects setting
- [ ] Manual sync works when disabled

## API Endpoints Required

The following Core API endpoints must exist:

### Public Tables

- `GET /api/tables?systemId={systemId}&isPublic=true`
- `GET /api/tables/{tableId}`
- `POST /api/tables/{tableId}/roll`

### Campaign Tables

- `GET /api/campaigns/{campaignId}/tables?includeSystem=false`
- `POST /api/campaigns/{campaignId}/tables/{tableId}/roll`

### Response Format

```json
{
  "tables": [
    {
      "id": "table_123",
      "slug": "crit-hit-melee-rotfs",
      "name": "Critical Hit: Melee Weapons",
      "description": "...",
      "tableType": "critical-hit",
      "systemId": "dnd5e",
      "diceFormula": "1d20",
      "replacement": true,
      "displayRoll": true,
      "results": [
        {
          "range": [1, 5],
          "text": "Double damage",
          "details": "Roll weapon damage twice",
          "reference": "rotfs/combat/critical-hits"
        }
      ],
      "category": "combat",
      "tags": ["melee", "critical", "rotfs"],
      "source": "RotFS",
      "isPublic": true
    }
  ]
}
```

## Error Handling

The implementation includes comprehensive error handling:

- Failed API requests log errors and show notifications
- Missing API token warns user
- Invalid table data skips table with warning
- Failed table creation continues with next table
- Context menu errors show user-friendly messages

## Performance Considerations

- Tables sync asynchronously to avoid blocking world load
- Folder creation is deferred and cached
- Table lookup uses flags (indexed by Foundry)
- Sync results cached in Map for quick lookups

## Compatibility

- Works with any Foundry VTT game system
- System-specific tables only sync for supported systems (dnd5e)
- Campaign tables work for any system
- Offline rolling works after initial sync
