# FoundryVTT ApplicationV2 — Developer Reference

Covers Foundry VTT v13+. ApplicationV2 replaces the legacy `Application` and `FormApplication` classes.

**Official API:** https://foundryvtt.com/api/classes/foundry.applications.api.ApplicationV2.html
**Community wiki:** https://foundryvtt.wiki/en/development/api/applicationv2
**Conversion guide:** https://foundryvtt.wiki/en/development/guides/applicationV2-conversion-guide

---

## Class Hierarchy

```
ApplicationV2                          ← base class, no rendering built in
├── + HandlebarsApplicationMixin()     ← adds Handlebars/PARTS rendering
│     → DocumentSheetV2               ← document sheets (actors, items, etc.)
│     → your ApplicationV2 subclasses
└── DialogV2                          ← modal dialogs (factory static methods)
```

Most plugin panels extend `ApplicationV2` directly and render via `createElement` — no Handlebars templates needed. Use `HandlebarsApplicationMixin` only if you actually want `.hbs` templates.

---

## DEFAULT_OPTIONS

Every ApplicationV2 subclass declares a static `DEFAULT_OPTIONS` object:

```js
class MyPanel extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: 'cfg-my-panel', // unique DOM id; use {id} for multiple instances

    window: {
      title: 'My Panel',
      icon: 'fas fa-users',
      resizable: true,
      minimizable: true,
      controls: [
        // dropdown header buttons (optional)
        { action: 'openHelp', icon: 'fas fa-question-circle', label: 'Help' },
      ],
    },

    classes: ['cfg-panel'], // extra CSS classes on the root element
    tag: 'div', // root element tag; use 'form' for native form submission

    position: {
      width: 800,
      height: 600,
    },

    form: {
      // only when tag: 'form'
      handler: MyPanel.#onSubmit,
      closeOnSubmit: true,
      submitOnChange: false,
    },

    actions: {
      // maps data-action → static method
      save: MyPanel.save,
      delete: MyPanel.delete,
    },
  }
}
```

---

## Render Lifecycle

Methods are called in this order on every `render()` call:

```
_prepareContext(options)        → build the data object passed to template/render
_preRender(context, options)    → last chance to modify context before DOM work
_renderHTML(context, options)   → produce the DOM (string or Element)
_replaceHTML(result, content)   → swap old DOM with new (or do partial update)
_onRender(context, options)     → DOM is live; attach non-click listeners here
```

On the **first** render only:

```
_preFirstRender(context, options)
_onFirstRender(context, options)  → one-time setup (timers, external libs, etc.)
```

On **close**:

```
_preClose(options)   → return false to abort close
_onClose(options)    → cleanup (intervals, external connections)
```

---

## Context Preparation

Equivalent to v1's `getData()`. Always async:

```js
async _prepareContext(options) {
  return {
    campaigns: this._hook.linkedCampaigns,
    selected:  this._selected,
    isGM:      game.user.isGM,
  };
}
```

---

## Rendering Without Handlebars

Implement `_renderHTML` to return an `Element` (preferred) or HTML string, then `_replaceHTML` to swap it in:

```js
async _renderHTML(context, _options) {
  const root = document.createElement('div');
  root.className = 'cfg-panel';

  const heading = document.createElement('h2');
  heading.textContent = context.title;
  root.appendChild(heading);

  for (const item of context.items) {
    const row = document.createElement('div');
    row.className = 'cfg-row';
    row.dataset.id = item.id;

    const btn = document.createElement('button');
    btn.dataset.action = 'delete';   // wired to static action handler
    btn.dataset.itemId = item.id;
    btn.textContent = 'Remove';
    row.appendChild(btn);

    root.appendChild(row);
  }

  return root;
}

async _replaceHTML(result, content, _options) {
  content.replaceChildren(result);  // content is the inner content element
}
```

> **Tip:** `content` in `_replaceHTML` is the inner scrollable content area, not the full window chrome. Use `this.element` for the root including chrome.

---

## Actions System

Actions replace `activateListeners`. Add `data-action="actionName"` to any element; the framework calls the matching static method when clicked.

```js
static DEFAULT_OPTIONS = {
  actions: {
    linkCampaign:   CampaignManager._onLinkCampaign,
    unlinkCampaign: CampaignManager._onUnlinkCampaign,
    syncAll:        CampaignManager._onSyncAll,
  },
};

// Static method — 'this' is the application instance (auto-bound)
static async _onLinkCampaign(event, target) {
  // event:  PointerEvent
  // target: the HTMLElement that carries data-action
  const campaignId = target.dataset.campaignId;
  await this._hook.link(campaignId);
  this.render();
}
```

**HTML:**

```html
<button data-action="linkCampaign" data-campaign-id="abc123">Link</button>
```

Actions are inherited — subclasses can add to them without losing parent actions.

---

## Non-click Listeners

Attach `change`, `input`, `keydown`, etc. in `_onRender` (called after every render):

```js
async _onRender(_context, _options) {
  this.element.querySelector('.cfg-search')
    ?.addEventListener('input', e => this._onSearch(e.target.value));
}
```

For one-time setup that shouldn't re-run on re-render, use `_onFirstRender`.

---

## Rendering with Handlebars (PARTS)

Use when you prefer `.hbs` templates. Mix in `HandlebarsApplicationMixin`:

```js
const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api

class MySheet extends HandlebarsApplicationMixin(ApplicationV2) {
  static PARTS = {
    header: { template: 'modules/crit-fumble-core/templates/my-header.hbs' },
    body: { template: 'modules/crit-fumble-core/templates/my-body.hbs' },
  }

  async _prepareContext(options) {
    return { title: this.title }
  }

  // Optionally prepare per-part context
  async _preparePartContext(partId, context, options) {
    if (partId === 'body') context.items = this._items
    return context
  }
}
```

Parts can be re-rendered independently: `await this.renderPart('body')`.

---

## Form Submission

Set `tag: 'form'` and provide a `form.handler` in `DEFAULT_OPTIONS`:

```js
static DEFAULT_OPTIONS = {
  tag:  'form',
  form: {
    handler:       MyForm.#onSubmit,
    closeOnSubmit: true,
  },
};

static async #onSubmit(event, form, formData) {
  // formData.object → plain JS object of all named inputs
  await game.settings.set('crit-fumble-core', 'someKey', formData.object.value);
}
```

Trigger programmatic submit: `await this.submit()`.

---

## DialogV2

Async factory methods for quick modal dialogs. All return a Promise.

```js
const { DialogV2 } = foundry.applications.api

// Yes / No
const confirmed = await DialogV2.confirm({
  window: { title: 'Unlink Campaign' },
  content: '<p>Are you sure?</p>',
})
// → true (Yes) | false (No) | null (dismissed)

// Single acknowledge button
await DialogV2.prompt({
  window: { title: 'Notice' },
  content: '<p>Quest sync complete.</p>',
})

// Free-form buttons
const choice = await DialogV2.wait({
  window: { title: 'Voice Provider' },
  content: '<p>Select a voice provider:</p>',
  buttons: [
    { action: 'livekit', label: 'LiveKit', icon: 'fas fa-broadcast-tower' },
    { action: 'discord', label: 'Discord', icon: 'fab fa-discord' },
  ],
})
// → 'livekit' | 'discord' | null

// Form input
const result = await DialogV2.input({
  window: { title: 'Campaign ID' },
  content: '<input type="text" name="campaignId" placeholder="Enter ID">',
})
// → FormDataExtended; use result.object.campaignId
```

> **Note:** DialogV2 cannot re-render. If you need reactive content, use a full ApplicationV2 subclass.

---

## Positioning

```js
// Set size/position programmatically
this.setPosition({ width: 1000, height: 700 })

// Bring above all other windows
this.bringToFront()

// Minimize / maximize
this.minimize()
this.maximize()
```

`DEFAULT_OPTIONS.position` sets the initial values. `height: 'auto'` sizes to content.

---

## Tabs

```js
static TABS = {
  primary: {
    details:  { id: 'details',  group: 'primary', label: 'Details',  icon: 'fas fa-info-circle' },
    settings: { id: 'settings', group: 'primary', label: 'Settings', icon: 'fas fa-cog' },
  },
};

// In _prepareContext:
async _prepareContext(options) {
  return {
    tabs:      this._prepareTabs('primary'),
    activeTab: this.tabGroups.primary ?? 'details',
  };
}

// Switch tab programmatically:
this.changeTab('settings', 'primary');
```

Tabs + PARTS: render only the active part by checking `options.parts` in `_preparePartContext`.

---

## Hooks

ApplicationV2 fires hooks automatically. Hook names are derived from the class name:

```js
// Before render — return false to prevent
Hooks.on('preRenderCampaignManager', (app, context, options) => {})

// After render — html is the root element
Hooks.on('renderCampaignManager', (app, html, context) => {})

// Before close — return false to prevent
Hooks.on('preCloseCampaignManager', (app, options) => {})

// After close
Hooks.on('closeCampaignManager', (app, options) => {})

// Modify header controls
Hooks.on('getHeaderControlsCampaignManager', (app, controls) => {
  controls.push({ action: 'openHelp', icon: 'fas fa-question', label: 'Help' })
})
```

---

## Key Differences from v1

| v1 (Application)          | v2 (ApplicationV2)                             |
| ------------------------- | ---------------------------------------------- |
| `getData()`               | `_prepareContext(options)` (async)             |
| `activateListeners(html)` | `actions` map + `_onRender`                    |
| `render(true)`            | `render()` (open) or `render({ force: true })` |
| `this.element` (jQuery)   | `this.element` (native HTMLElement)            |
| Template required         | Optional — override `_renderHTML` instead      |
| `FormApplication`         | `tag: 'form'` + `form.handler` on base class   |
| `Dialog`                  | `DialogV2` static factory methods              |
| `data-*` on inner html    | `data-action` wired automatically              |

---

## Minimal Boilerplate (no Handlebars)

```js
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
    return { items: [] }
  }

  async _renderHTML(context, _options) {
    const root = document.createElement('div')
    root.className = 'cfg-my-panel'
    root.innerHTML = `<p>${context.items.length} items</p>
      <button data-action="doThing">Do thing</button>`
    return root
  }

  async _replaceHTML(result, content, _options) {
    content.replaceChildren(result)
  }

  static _onDoThing(_event, _target) {
    ui.notifications.info('Done!')
  }
}
```
