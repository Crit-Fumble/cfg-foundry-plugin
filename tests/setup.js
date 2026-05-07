/**
 * Jest global setup — Foundry VTT mocks for Phase 1 unit tests.
 *
 * Only mocks what Phase 1 code actually uses. No image editors, scripting
 * engine, speech synthesis, canvas drawing, or other Phase 2/3+ globals.
 */

import { jest } from '@jest/globals'

/* -------------------------------------------- */
/*  foundry.*                                    */
/* -------------------------------------------- */

globalThis.foundry = {
  utils: {
    randomID: () => Math.random().toString(36).substring(2, 10),
    escapeHTML: (s) =>
      String(s).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    mergeObject: (original, updates = {}) => {
      const out = { ...original }
      for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) out[k] = v
      }
      return out
    },
    deepClone: (obj) => JSON.parse(JSON.stringify(obj)),
  },
  applications: {
    api: {
      ApplicationV2: class ApplicationV2 {
        constructor(options = {}) {
          this.options = options
        }
        render() {
          return this
        }
        close() {}
        get element() {
          return globalThis.document.createElement('div')
        }
        async _prepareContext() {
          return {}
        }
      },
      HandlebarsApplicationMixin: (Base) => class extends Base {},
    },
  },
}

/* -------------------------------------------- */
/*  Hooks                                        */
/* -------------------------------------------- */

globalThis.Hooks = {
  on: jest.fn((_event, handler) => handler), // returns hookId (the handler itself)
  once: jest.fn(),
  off: jest.fn(),
  call: jest.fn(),
  callAll: jest.fn(),
}

/* -------------------------------------------- */
/*  game                                         */
/* -------------------------------------------- */

globalThis.game = {
  user: {
    isGM: true,
    id: 'test-gm-id',
    name: 'Test GM',
  },
  users: {
    get: jest.fn(),
  },
  actors: {
    get: jest.fn(),
    find: jest.fn(() => null),
    filter: jest.fn(() => []),
    contents: [],
  },
  items: {
    get: jest.fn(),
    contents: [],
  },
  scenes: {
    contents: [],
  },
  journal: {
    find: jest.fn(() => null),
    contents: [],
  },
  modules: {
    get: jest.fn(() => null),
  },
  settings: {
    get: jest.fn(),
    set: jest.fn(async () => {}),
    register: jest.fn(),
    registerMenu: jest.fn(),
  },
  world: {
    id: 'test-world-id',
  },
  keybindings: {
    register: jest.fn(),
  },
}

/* -------------------------------------------- */
/*  ui                                           */
/* -------------------------------------------- */

globalThis.ui = {
  notifications: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  },
  sidebar: { render: jest.fn() },
}

/* -------------------------------------------- */
/*  ChatMessage                                  */
/* -------------------------------------------- */

globalThis.ChatMessage = {
  create: jest.fn(async (data) => ({ id: 'mock-chat-id', ...data })),
}

/* -------------------------------------------- */
/*  JournalEntry / JournalEntryPage             */
/* -------------------------------------------- */

globalThis.JournalEntry = {
  create: jest.fn(async (data) => ({ id: 'mock-journal-id', ...data, update: jest.fn() })),
}

/* -------------------------------------------- */
/*  Actor                                        */
/* -------------------------------------------- */

globalThis.Actor = {
  create: jest.fn(async (data) => ({ id: 'mock-actor-id', ...data, update: jest.fn() })),
}

/* -------------------------------------------- */
/*  Dialog (legacy v1 — used by campaign-manager)*/
/* -------------------------------------------- */

globalThis.Dialog = class Dialog {
  constructor(data, options = {}) {
    this.data = data
    this.options = options
  }
  render() {
    return this
  }
  static async confirm() {
    return true
  }
}

/* -------------------------------------------- */
/*  CONST                                        */
/* -------------------------------------------- */

globalThis.CONST = {
  CHAT_MESSAGE_STYLES: { OOC: 1, IC: 2 },
  CHAT_MESSAGE_TYPES: { OTHER: 0, OOC: 1, IC: 2, WHISPER: 4 },
}

/* -------------------------------------------- */
/*  fetch                                        */
/* -------------------------------------------- */

globalThis.fetch = jest.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => '',
}))

/* -------------------------------------------- */
/*  document (minimal DOM)                       */
/* -------------------------------------------- */

if (typeof document === 'undefined') {
  globalThis.document = {
    createElement: jest.fn((tag) => ({
      tagName: tag.toUpperCase(),
      style: {},
      dataset: {},
      className: '',
      textContent: '',
      innerHTML: '',
      children: [],
      querySelector: jest.fn(() => null),
      querySelectorAll: jest.fn(() => []),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      appendChild: jest.fn(),
      replaceChildren: jest.fn(),
      insertAdjacentElement: jest.fn(),
      isConnected: true,
    })),
    querySelector: jest.fn(() => null),
    querySelectorAll: jest.fn(() => []),
  }
}

/* -------------------------------------------- */
/*  window                                       */
/* -------------------------------------------- */

globalThis.window = globalThis.window ?? {}
global.window = globalThis.window

// CFGCore global — tests override individual properties per-test
globalThis.window.CFGCore = {
  api: null,
  campaignId: jest.fn(() => 'test-campaign-id'),
  featureMode: jest.fn(() => 'narrative'),
  platformSystemSlug: jest.fn(() => null),
  voiceProvider: jest.fn(() => 'livekit'),
  openCampaignManager: jest.fn(),
}

/* -------------------------------------------- */
/*  console (quiet by default)                   */
/* -------------------------------------------- */

globalThis.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}
