# CFG Foundry Plugin — Architecture

Phase 1 plugin that connects a self-hosted or Core-hosted FoundryVTT world to the Crit-Fumble Core platform.

---

## Directory Layout

```
packages/foundry-plugin/
├── module.json                   ← Foundry module manifest
├── scripts/
│   ├── module.js                 ← Entry point — settings, keybindings, init/ready hooks
│   │
│   ├── clients/
│   │   └── api-client.js         ← CoreAPIClient: fetch wrapper, auth modes, named methods
│   │
│   ├── services/                 ← Business logic; no direct DOM manipulation
│   │   ├── chat-sync.js          ← ChatSyncManager: Foundry ↔ Core chat unification
│   │   ├── character-sync.js     ← CharacterSyncManager: actor ↔ Core character sync
│   │   ├── quest-sync.js         ← QuestSyncManager: Core quests → journal entries
│   │   ├── sync-service.js       ← SyncService: orchestrates auto-sync polling
│   │   ├── party-context.js      ← Party state management
│   │   └── vtt-config-manager.js ← VTT configuration helpers
│   │
│   ├── views/                    ← ApplicationV2 panels (GM UI)
│   │   ├── campaign-manager.js   ← CampaignManager: main GM panel (link, sync, roster)
│   │   ├── campaign-filter.js    ← CampaignFilter: sidebar content filter
│   │   ├── party-roster.js       ← PartyRoster: party member list panel
│   │   ├── session-tracker.js    ← SessionTracker: active session HUD badge
│   │   └── voice-panel.js        ← VoiceChatPanel: LiveKit WebRTC or Discord voice
│   │
│   ├── components/               ← Reusable UI primitives (no Foundry-specific logic)
│   │   ├── atoms/                ← Button, Badge, Avatar, Select, EmptyState
│   │   ├── molecules/            ← Card, FormGroup, PanelHeader, ListContainer
│   │   └── ui-components.js      ← Re-exports all atoms + molecules
│   │
│   ├── hooks/                    ← Data-fetching hooks (async state holders)
│   │   ├── useCampaigns.js       ← Campaign list + linking state
│   │   └── useParties.js         ← Party list for a campaign
│   │
│   ├── utils/                    ← Pure utility functions, no Foundry hooks
│   │   ├── campaign-flags.js     ← CampaignFlags: Foundry document flag helpers
│   │   ├── dom-helpers.js        ← setElementContent, createButton, formatTimeAgo
│   │   ├── field-mapper.js       ← Character field mapping utilities
│   │   └── file-picker-compat.js ← FilePicker v13 compatibility shim
│   │
│   ├── auth/
│   │   └── core-auth.js          ← Core OAuth bypass (core-hosted only)
│   │
│   └── embed/
│       ├── vtt-bridge.js         ← VTTBridge: postMessage bridge for iframe embedding
│       └── embedded-app.js       ← Embedded app host (core-hosted iframe)
│
├── styles/
│   ├── module.css                ← Global module styles
│   └── ...
│
├── tests/
│   ├── jest.config.js            ← Unit test config (Jest + Foundry mocks)
│   ├── mocks/
│   │   └── api-client.js         ← createMockApiClient, createUnauthorizedApiClient
│   ├── unit/                     ← Jest unit tests (no Foundry runtime)
│   └── integration/              ← Playwright tests against live Foundry container
│       ├── playwright.config.js
│       ├── shared/               ← globalSetup, wait-for-foundry, auth.setup
│       ├── core-hosted/          ← Tests for session-cookie auth mode
│       └── self-hosted/          ← Tests for API key auth mode
│
└── docs/                         ← Developer reference (this folder)
```

---

## Auth Modes

The plugin supports two auth modes, selected automatically based on whether an API key is configured:

| Mode        | Setting          | HTTP auth                         | When                                      |
| ----------- | ---------------- | --------------------------------- | ----------------------------------------- |
| Core-hosted | `apiKey` empty   | `credentials: 'include'` (cookie) | Foundry runs inside Core's iframe         |
| Self-hosted | `apiKey = cfk_…` | `Authorization: Bearer cfk_…`     | Standalone Foundry with API key from Core |

`CoreAPIClient` handles both transparently — callers always use the same named methods.

---

## Module Initialization (`scripts/module.js`)

Two Foundry hooks drive the entire lifecycle:

### `Hooks.once('init')`

- Registers all world settings (`coreApiUrl`, `campaignId`, `apiKey`, `voiceProvider`, etc.)
- Registers keybindings (Ctrl+M → toggle voice mute)
- Registers the GM campaign manager scene control button

### `Hooks.once('ready')`

1. Reads settings; resolves campaign ID
2. Creates `CoreAPIClient` (API key mode or session cookie mode)
3. Calls `_reportSystem()` — PATCHes `foundrySystemId` to Core, reads back `featureMode`, `platformSystemSlug`, `voiceProvider`
4. Calls `_checkRecommendedModules()` (GM only)
5. Shows feature mode notification banner
6. Starts `QuestSyncManager` + `SyncService` (if `autoSyncQuests` enabled)
7. Starts `ChatSyncManager` (if `chatSyncEnabled` enabled)
8. Logs voice provider from campaign settings

### Global `window.CFGCore`

Exposes plugin state to other scripts and the browser console:

```js
window.CFGCore.version // '2.0.0'
window.CFGCore.featureMode() // 'full' | 'narrative'
window.CFGCore.platformSystemSlug() // '5e-compatible' | null
window.CFGCore.campaignId() // campaign UUID | null
window.CFGCore.voiceProvider() // 'livekit' | 'discord'
window.CFGCore.api // CoreAPIClient instance
window.CFGCore.openCampaignManager() // open the GM panel
```

---

## Feature Mode

The plugin operates in one of two modes set by Core based on the Foundry game system:

| Mode        | Meaning                                             | When set                                         |
| ----------- | --------------------------------------------------- | ------------------------------------------------ |
| `narrative` | Voice, quests, party roster, chat                   | System has no platform compendium (e.g. swade)   |
| `full`      | All of the above + character sheet sync, compendium | System supported by Core (5e-compatible, cypher) |

`featureMode` is returned by the `PATCH /api/campaigns/{id}/foundry` response on every `ready`.

---

## CoreAPIClient (`scripts/clients/api-client.js`)

Thin `fetch` wrapper. All methods are async and throw on HTTP errors.

```js
const api = new CoreAPIClient(baseUrl, apiKey)

// Generic
api.get('/api/campaigns')
api.post('/api/campaigns/abc/chat', body)
api.patch('/api/campaigns/abc/foundry', body)
api.del('/api/campaigns/abc/link')

// Named campaign methods
api.getCampaign(campaignId)
api.getFoundryConfig(campaignId)
api.updateFoundry(campaignId, data)
api.getParties(campaignId)
api.getActiveSession(campaignId)
api.getSessions(campaignId)
api.getQuests(campaignId)
api.updateQuest(campaignId, questId, data)
api.joinVoice(campaignId) // POST …/stream/webrtc/join → { token, url, roomName }
api.getJournal(campaignId)
api.gmAssist(campaignId, prompt)
```

---

## Voice Integration (`scripts/views/voice-panel.js`)

### Provider selection

Voice provider is **authoritative from Core campaign settings**, read during `_reportSystem()`:

```
PATCH /api/campaigns/{id}/foundry
  → response.voiceProvider  ('livekit' | 'discord')
  → stored in _voiceProvider (module-level state)
  → window.CFGCore.voiceProvider() checks this first
```

Fallback chain:

1. `_voiceProvider` from campaign settings (set on `ready`)
2. `voiceProvider` world setting (user-configurable fallback)
3. `window.DISCORD_ACTIVITY ? 'discord' : 'livekit'` (detection)

### LiveKit path

`registerLiveKitVoiceHooks()` is called from `voice-panel.js` internally. If provider is `discord`, hooks are skipped and `window.CFGVoice` is set to a no-op stub.

For LiveKit:

- Loads `livekit-client` ESM from CDN URL (world setting `livekitClientUrl`)
- `joinVoice()` calls `CoreAPIClient.joinVoice(campaignId)` → receives `{ token, url }`
- Connects `lk.Room` → enables mic → renders `VoiceChatPanel`

Keybinding: **Ctrl+M** toggles mute via `window.CFGVoice.toggleMute()`.

---

## Chat Sync (`scripts/services/chat-sync.js`)

**Foundry → Core:** `Hooks.on('createChatMessage')` → `POST /api/campaigns/{id}/chat`

**Core → Foundry:** GM polls `GET /api/campaigns/{id}/chat?since={iso}` every 5 seconds. Injected messages carry a `coreMessageId` flag to prevent echo loops. Players receive injected messages via Foundry's built-in socket replication.

Whisper messages are not forwarded to avoid noise.

---

## Campaign Manager (`scripts/views/campaign-manager.js`)

Main GM panel, opened via the scene controls button or `CFGCore.openCampaignManager()`.

Uses **ApplicationV2** with pure `createElement` rendering (no Handlebars). Actions map to static handler methods per the ApplicationV2 pattern.

Sections:

- Campaign list (link, unlink, set active filter)
- Campaign details (system info, sync controls)
- Terminology (custom party/member/leader names)
- Officer positions (preset selector — default: Leader + Member)
- Parties grid
- Player roster (shows linked Foundry actors via `CampaignFlags`)
- Content stats (actor/scene/item/journal counts)

Officer positions are inlined directly (two built-in presets: Standard). The `campaignPositions` world setting (hidden, `Object`) persists per-campaign configuration.

---

## Writing a New View

All panels live in `scripts/views/`. Follow this structure:

```js
// scripts/views/my-panel.js

const MODULE_ID = 'crit-fumble-core'

export class MyPanel extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: 'cfg-my-panel',
    window: { title: 'My Panel', icon: 'fas fa-star', resizable: true },
    position: { width: 600, height: 400 },
    actions: {
      doThing: MyPanel._onDoThing,
    },
  }

  async _prepareContext(_options) {
    const api = window.CFGCore.api
    const campaignId = window.CFGCore.campaignId()
    return { items: await api.getSomeData(campaignId) }
  }

  async _renderHTML(context, _options) {
    const root = document.createElement('div')
    root.className = 'cfg-my-panel'
    // ... build DOM from context ...
    return root
  }

  async _replaceHTML(result, content, _options) {
    content.replaceChildren(result)
  }

  static _onDoThing(_event, target) {
    const id = target.dataset.id
    // 'this' is the panel instance
    this.render()
  }
}
```

See [APPLICATION_V2.md](APPLICATION_V2.md) for full API reference.

---

## Writing a New Service

Services live in `scripts/services/`. They hold business logic and call `CoreAPIClient` — no DOM manipulation.

```js
// scripts/services/my-service.js

export class MyService {
  constructor(api, campaignId) {
    this._api = api
    this._campaignId = campaignId
  }

  async doWork() {
    const data = await this._api.get(`/api/campaigns/${this._campaignId}/something`)
    // process data, create Foundry documents, etc.
  }
}
```

Instantiate in the `ready` hook in `module.js` and expose on `CFGCore` if other code needs it.

---

## Writing a New Hook (data fetcher)

Data-fetching hooks live in `scripts/hooks/`. They wrap async API calls and hold state for views to consume.

```js
// scripts/hooks/useMyData.js

export class useMyData {
  constructor(campaignId) {
    this._campaignId = campaignId
    this.data = []
    this.loading = false
  }

  async load() {
    this.loading = true
    try {
      const result = await window.CFGCore.api.get(`/api/campaigns/${this._campaignId}/my-data`)
      this.data = result.items ?? []
    } finally {
      this.loading = false
    }
  }
}
```

---

## Phase Gating

All Phase 2+ code is marked `// TODO(phase-2):` and removed from the plugin. Phase 1 is the clean baseline. When enabling a new phase, grep:

```bash
grep -r "TODO(phase-2):" scripts/
```
