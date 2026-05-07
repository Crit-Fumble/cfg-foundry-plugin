/**
 * Core Auth Bypass
 *
 * Provides optional integration between Crit-Fumble Core authentication
 * and FoundryVTT login. When enabled, bypasses Foundry's native login
 * and uses Core's JWT-based OAuth (Discord/GitHub).
 *
 * This is a setting that can be enabled once the VTT is fully set up
 * with Core API integration.
 */

const MODULE_ID = 'crit-fumble-core'
const LOG_PREFIX = 'CFG Core | Auth |'

/**
 * Core Auth Bypass Configuration
 */
export const CORE_AUTH_CONFIG = {
  // Default Core API URL (can be overridden in settings)
  DEFAULT_API_URL: 'https://core.crit-fumble.com',

  // OAuth providers supported
  PROVIDERS: ['discord', 'github'],

  // JWT token parameter name in URL
  TOKEN_PARAM: 'authToken',

  // World ID parameter name in URL
  WORLD_PARAM: 'worldId',

  // Storage key for pending auth
  PENDING_AUTH_KEY: 'cfg_pending_auth',

  // Pending auth timeout (5 minutes)
  PENDING_AUTH_TIMEOUT: 5 * 60 * 1000,
}

/**
 * Register Core Auth settings
 * Called from main module.js registerSettings()
 */
export function registerCoreAuthSettings() {
  // Enable Core Auth Bypass
  game.settings.register(MODULE_ID, 'enableCoreAuthBypass', {
    name: 'Enable Core Auth Bypass',
    hint: "When enabled, players authenticate via Crit-Fumble Core (Discord/GitHub OAuth) instead of Foundry's native login. Only enable this after the VTT is fully configured with Core API.",
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
    requiresReload: true,
    onChange: (value) => {
      console.log(`${LOG_PREFIX} Core Auth Bypass ${value ? 'enabled' : 'disabled'}`)
      if (value) {
        ui.notifications.info('Core Auth Bypass enabled. Players will now authenticate via Crit-Fumble Core.')
      }
    },
  })

  // Core Auth API URL (uses coreApiUrl if not set)
  game.settings.register(MODULE_ID, 'coreAuthUrl', {
    name: 'Core Auth URL',
    hint: 'URL for Core authentication. Leave blank to use the Core API URL setting.',
    scope: 'world',
    config: true,
    type: String,
    default: '',
  })

  // Core World ID (links this Foundry world to a Core world record)
  game.settings.register(MODULE_ID, 'coreWorldId', {
    name: 'Core World ID',
    hint: 'The Crit-Fumble Core world ID this Foundry world is linked to. Required for Core Auth to work.',
    scope: 'world',
    config: true,
    type: String,
    default: '',
  })

  // Allow guest access (view-only without auth)
  game.settings.register(MODULE_ID, 'allowGuestAccess', {
    name: 'Allow Guest Access',
    hint: 'Allow users to view the world without authenticating (read-only access).',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  })

  // Auto-create Foundry users from Core auth
  game.settings.register(MODULE_ID, 'autoCreateUsers', {
    name: 'Auto-Create Users',
    hint: 'Automatically create Foundry users when they authenticate via Core. If disabled, users must be pre-created.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  })

  // Default role for new users
  game.settings.register(MODULE_ID, 'defaultUserRole', {
    name: 'Default User Role',
    hint: 'Default permission level for users created via Core Auth.',
    scope: 'world',
    config: true,
    type: Number,
    choices: {
      0: 'None (Must be assigned)',
      1: 'Player',
      2: 'Trusted Player',
      3: 'Assistant GM',
    },
    default: 1,
  })

  // Owner Core user ID — set by the server during world provisioning so
  // syncFoundryUser can promote the campaign/installation owner to GM (#588).
  // Not user-editable; written to settings.db by the Core platform when a
  // world is created or linked to a realm.
  game.settings.register(MODULE_ID, 'ownerCoreUserId', {
    scope: 'world',
    config: false,
    type: String,
    default: '',
  })

  console.log(`${LOG_PREFIX} Core Auth settings registered`)
}

/**
 * Get the Core Auth URL
 * @returns {string} Core Auth URL
 */
export function getCoreAuthUrl() {
  const customUrl = game.settings.get(MODULE_ID, 'coreAuthUrl')
  if (customUrl) return customUrl

  const coreApiUrl = game.settings.get(MODULE_ID, 'coreApiUrl')
  return coreApiUrl || CORE_AUTH_CONFIG.DEFAULT_API_URL
}

/**
 * Get the Core World ID
 * @returns {string|null} Core World ID or null if not configured
 */
export function getCoreWorldId() {
  return game.settings.get(MODULE_ID, 'coreWorldId') || null
}

/**
 * Check if Core Auth Bypass is enabled
 * @returns {boolean}
 */
export function isCoreAuthEnabled() {
  try {
    return game.settings.get(MODULE_ID, 'enableCoreAuthBypass') === true
  } catch {
    // Settings not ready yet
    return false
  }
}

/**
 * Check if the current configuration is valid for Core Auth
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateCoreAuthConfig() {
  const errors = []

  if (!getCoreWorldId()) {
    errors.push('Core World ID is not configured')
  }

  const authUrl = getCoreAuthUrl()
  if (!authUrl) {
    errors.push('Core Auth URL is not configured')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Validate that a URL is safe for redirect (prevents open redirect attacks)
 * @param {string} url - URL to validate
 * @returns {boolean} True if URL is safe
 * @private
 */
function isValidReturnUrl(url) {
  try {
    const urlObj = new URL(url)

    // Allow only same origin
    if (urlObj.origin !== window.location.origin) {
      console.warn(`${LOG_PREFIX} Blocked cross-origin return URL:`, urlObj.origin)
      return false
    }

    // Block javascript: and data: URLs
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      console.warn(`${LOG_PREFIX} Blocked non-HTTP protocol:`, urlObj.protocol)
      return false
    }

    return true
  } catch (error) {
    console.error(`${LOG_PREFIX} Invalid return URL:`, error)
    return false
  }
}

/**
 * Generate the OAuth redirect URL for a provider
 * @param {string} provider - 'discord' or 'github'
 * @returns {string} OAuth redirect URL
 */
export function getOAuthRedirectUrl(provider) {
  const baseUrl = getCoreAuthUrl()
  const worldId = getCoreWorldId()

  // SECURITY: Validate return URL before using it
  const currentUrl = window.location.href.split('?')[0]
  if (!isValidReturnUrl(currentUrl)) {
    console.error(`${LOG_PREFIX} Invalid return URL detected, using base origin`)
    const returnUrl = encodeURIComponent(window.location.origin)
    return `${baseUrl}/api/foundry/auth/oauth/${provider}?worldId=${worldId}&returnUrl=${returnUrl}`
  }

  const returnUrl = encodeURIComponent(currentUrl)
  return `${baseUrl}/api/foundry/auth/oauth/${provider}?worldId=${worldId}&returnUrl=${returnUrl}`
}

/**
 * Redirect to Core OAuth login
 * @param {string} provider - 'discord' or 'github' (default: 'discord')
 */
export function redirectToOAuth(provider = 'discord') {
  if (!CORE_AUTH_CONFIG.PROVIDERS.includes(provider)) {
    console.error(`${LOG_PREFIX} Invalid OAuth provider: ${provider}`)
    return
  }

  const config = validateCoreAuthConfig()
  if (!config.valid) {
    console.error(`${LOG_PREFIX} Cannot redirect to OAuth:`, config.errors)
    ui.notifications?.error(`Core Auth not configured: ${config.errors.join(', ')}`)
    return
  }

  const redirectUrl = getOAuthRedirectUrl(provider)
  console.log(`${LOG_PREFIX} Initiating OAuth flow for ${provider}`)

  // SECURITY: Validate return URL before storing
  const currentUrl = window.location.href
  if (!isValidReturnUrl(currentUrl)) {
    console.error(`${LOG_PREFIX} Invalid return URL, using base origin`)
    sessionStorage.setItem(
      CORE_AUTH_CONFIG.PENDING_AUTH_KEY,
      JSON.stringify({
        returnUrl: window.location.origin,
        timestamp: Date.now(),
      }),
    )
  } else {
    // Store current URL for return
    sessionStorage.setItem(
      CORE_AUTH_CONFIG.PENDING_AUTH_KEY,
      JSON.stringify({
        returnUrl: currentUrl,
        timestamp: Date.now(),
      }),
    )
  }

  window.location.href = redirectUrl
}

/**
 * Handle OAuth callback with JWT token
 * @returns {Promise<{success: boolean, user?: object, error?: string}>}
 */
export async function handleOAuthCallback() {
  const urlParams = new URLSearchParams(window.location.search)
  const authToken = urlParams.get(CORE_AUTH_CONFIG.TOKEN_PARAM)

  if (!authToken) {
    return { success: false, error: 'No auth token found' }
  }

  console.log(`${LOG_PREFIX} Processing OAuth callback...`)

  // Validate pending auth timeout
  const pendingAuthData = sessionStorage.getItem(CORE_AUTH_CONFIG.PENDING_AUTH_KEY)
  if (pendingAuthData) {
    try {
      const { timestamp } = JSON.parse(pendingAuthData)
      const age = Date.now() - timestamp

      if (age > CORE_AUTH_CONFIG.PENDING_AUTH_TIMEOUT) {
        console.warn(`${LOG_PREFIX} Pending auth expired (${Math.round(age / 1000)}s old)`)
        sessionStorage.removeItem(CORE_AUTH_CONFIG.PENDING_AUTH_KEY)
        return {
          success: false,
          error: 'Authentication session expired. Please try again.',
        }
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to parse pending auth data:`, error)
      sessionStorage.removeItem(CORE_AUTH_CONFIG.PENDING_AUTH_KEY)
    }
  }

  // Remove token from URL immediately for security
  if (window.history && window.history.replaceState) {
    const url = new URL(window.location)
    url.searchParams.delete(CORE_AUTH_CONFIG.TOKEN_PARAM)
    window.history.replaceState({}, document.title, url.toString())
  }

  // Clear pending auth
  sessionStorage.removeItem(CORE_AUTH_CONFIG.PENDING_AUTH_KEY)

  try {
    // Validate JWT with Core API
    const authUrl = getCoreAuthUrl()
    const response = await fetch(`${authUrl}/api/foundry/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken }),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(error.error || `HTTP ${response.status}`)
    }

    const authData = await response.json()

    if (!authData.success) {
      throw new Error(authData.error || 'Validation failed')
    }

    console.log(`${LOG_PREFIX} Authentication successful`)

    return {
      success: true,
      user: authData.user,
      foundryUser: authData.foundryUser,
      token: authToken,
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} OAuth callback failed:`, error)
    return { success: false, error: error.message }
  }
}

/**
 * Foundry GAMEMASTER role constant. Foundry's `User.USER_ROLES` exposes this
 * at runtime, but we hard-pin the literal so unit tests don't have to mock
 * the entire User class. Foundry has guaranteed this enum since v0.7.
 *   PLAYER = 1, TRUSTED = 2, ASSISTANT = 3, GAMEMASTER = 4.
 */
const FOUNDRY_GAMEMASTER_ROLE = 4

/**
 * Decide the Foundry role for a user being synced from Core (#588).
 * The campaign/installation owner gets promoted to GAMEMASTER for their own
 * world; everyone else lands at the world's `defaultUserRole`.
 *
 * Owner identity comes from the `ownerCoreUserId` world setting, written by
 * the Core platform during world provisioning. The setting is the source of
 * truth — independent of how the user authed (OAuth, API key, native).
 *
 * Exported for tests; safe for general use.
 *
 * @param {string} coreUserId        - The syncing user's Core user ID
 * @param {string} ownerCoreUserId   - The world's owner Core user ID (may be empty)
 * @param {number} defaultRole       - Fallback role when not the owner
 * @returns {number} Foundry role (1-4)
 */
export function resolveFoundryRole(coreUserId, ownerCoreUserId, defaultRole) {
  if (ownerCoreUserId && coreUserId && coreUserId === ownerCoreUserId) {
    return FOUNDRY_GAMEMASTER_ROLE
  }
  return defaultRole
}

/**
 * Create or update Foundry user from Core auth data
 * @param {object} authData - Validated auth data from Core
 * @returns {Promise<User|null>} Foundry User or null
 */
export async function syncFoundryUser(authData) {
  if (!game.user?.isGM) {
    console.log(`${LOG_PREFIX} Cannot sync user - not GM`)
    return null
  }

  const { user, foundryUser } = authData
  if (!user || !foundryUser) {
    console.error(`${LOG_PREFIX} Invalid auth data for user sync`)
    return null
  }

  // Read owner ID + default role once; both branches use them.
  const ownerCoreUserId = game.settings.get(MODULE_ID, 'ownerCoreUserId') || ''
  const defaultRole = game.settings.get(MODULE_ID, 'defaultUserRole')
  const desiredRole = resolveFoundryRole(user.id, ownerCoreUserId, defaultRole)

  // Look for existing user by Core user ID (stored in flags)
  let existingUser = game.users.find((u) => u.getFlag(MODULE_ID, 'coreUserId') === user.id)

  // Also check by Foundry username (for migration)
  if (!existingUser) {
    existingUser = game.users.find((u) => u.name.toLowerCase() === foundryUser.foundryUsername.toLowerCase())
  }

  if (existingUser) {
    // Update existing user flags
    await existingUser.setFlag(MODULE_ID, 'coreUserId', user.id)
    await existingUser.setFlag(MODULE_ID, 'foundryUserId', foundryUser.id)
    await existingUser.setFlag(MODULE_ID, 'lastAuth', Date.now())

    // Idempotent owner re-promote: if this user is the world owner and is
    // currently below GM, raise them. We never demote an existing user —
    // a manually-promoted assistant or trusted player shouldn't lose access
    // because they happened to re-auth through Core (#588).
    if (desiredRole === FOUNDRY_GAMEMASTER_ROLE && existingUser.role < FOUNDRY_GAMEMASTER_ROLE) {
      await existingUser.update({ role: FOUNDRY_GAMEMASTER_ROLE })
      console.log(`${LOG_PREFIX} Promoted existing user to GM (owner):`, existingUser.name)
    }

    console.log(`${LOG_PREFIX} Updated existing user:`, existingUser.name)
    return existingUser
  }

  // Check if auto-create is enabled
  const autoCreate = game.settings.get(MODULE_ID, 'autoCreateUsers')
  if (!autoCreate) {
    console.log(`${LOG_PREFIX} Auto-create disabled, user not found:`, foundryUser.foundryUsername)
    return null
  }

  const newUser = await User.create({
    name: foundryUser.foundryUsername,
    role: desiredRole,
    flags: {
      [MODULE_ID]: {
        coreUserId: user.id,
        foundryUserId: foundryUser.id,
        coreUsername: user.name,
        lastAuth: Date.now(),
      },
    },
  })

  console.log(`${LOG_PREFIX} Created new user:`, newUser.name, `role=${desiredRole}`)
  return newUser
}

/**
 * Initialize Core Auth Bypass
 * Called during module ready hook
 */
export async function initializeCoreAuthBypass() {
  if (!isCoreAuthEnabled()) {
    console.log(`${LOG_PREFIX} Core Auth Bypass is disabled`)
    return
  }

  const config = validateCoreAuthConfig()
  if (!config.valid) {
    console.warn(`${LOG_PREFIX} Core Auth enabled but not configured:`, config.errors)
    return
  }

  console.log(`${LOG_PREFIX} Core Auth Bypass initialized`)

  // Check for OAuth callback
  const result = await handleOAuthCallback()
  if (result.success) {
    console.log(`${LOG_PREFIX} OAuth callback successful`)

    // Store auth data for use
    globalThis.CFGCore = globalThis.CFGCore || {}
    globalThis.CFGCore.authData = result

    // Notify success
    ui.notifications?.info(`Welcome, ${result.user?.name}!`)
  } else if (result.error && result.error !== 'No auth token found') {
    console.error(`${LOG_PREFIX} OAuth callback error:`, result.error)
    ui.notifications?.error(`Authentication failed: ${result.error}`)
  }
}

/**
 * Register Core Auth hooks for login bypass
 * This intercepts Foundry's login flow when Core Auth is enabled
 */
export function registerCoreAuthHooks() {
  // Hook into the login form to add Core Auth buttons
  Hooks.on('renderJoinGameForm', (app, html, data) => {
    if (!isCoreAuthEnabled()) return

    const config = validateCoreAuthConfig()
    if (!config.valid) {
      console.warn(`${LOG_PREFIX} Core Auth enabled but misconfigured:`, config.errors)
      return
    }

    console.log(`${LOG_PREFIX} Injecting Core Auth buttons into login form`)

    // Find the form
    const form = html.find('form')
    if (!form.length) return

    // Create Core Auth section
    const authSection = $(`
      <div class="cfg-core-auth-section" style="margin-bottom: 1rem; padding: 1rem; background: rgba(0,0,0,0.1); border-radius: 4px;">
        <h3 style="margin: 0 0 0.5rem 0; font-size: 1rem;">Login with Crit-Fumble</h3>
        <p style="margin: 0 0 0.5rem 0; font-size: 0.85rem; opacity: 0.8;">
          Authenticate using your Discord or GitHub account.
        </p>
        <div class="cfg-auth-buttons" style="display: flex; gap: 0.5rem;">
          <button type="button" class="cfg-oauth-btn" data-provider="discord" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 0.5rem; padding: 0.5rem; background: #5865F2; color: white; border: none; border-radius: 4px; cursor: pointer;">
            <i class="fab fa-discord"></i> Discord
          </button>
          <button type="button" class="cfg-oauth-btn" data-provider="github" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 0.5rem; padding: 0.5rem; background: #333; color: white; border: none; border-radius: 4px; cursor: pointer;">
            <i class="fab fa-github"></i> GitHub
          </button>
        </div>
      </div>
    `)

    // Insert before the password field or at the top
    const passwordField = form.find('input[name="password"]').closest('.form-group')
    if (passwordField.length) {
      passwordField.before(authSection)
    } else {
      form.prepend(authSection)
    }

    // Add click handlers
    authSection.find('.cfg-oauth-btn').on('click', function (e) {
      e.preventDefault()
      const provider = $(this).data('provider')
      redirectToOAuth(provider)
    })

    // Optionally hide the password field if guest access is disabled
    const allowGuest = game.settings?.get(MODULE_ID, 'allowGuestAccess')
    if (!allowGuest) {
      // Keep password visible for GM access, but add note
      const gmNote = $(`
        <p style="font-size: 0.8rem; opacity: 0.7; margin-top: 0.5rem;">
          <i class="fas fa-info-circle"></i> Password login is for GM access only.
        </p>
      `)
      passwordField.after(gmNote)
    }
  })

  console.log(`${LOG_PREFIX} Core Auth hooks registered`)
}

/**
 * Export the auth bypass module
 */
export const CoreAuthBypass = {
  // Configuration
  CONFIG: CORE_AUTH_CONFIG,

  // Settings
  registerSettings: registerCoreAuthSettings,

  // Status checks
  isEnabled: isCoreAuthEnabled,
  validateConfig: validateCoreAuthConfig,

  // URLs
  getCoreAuthUrl,
  getCoreWorldId,
  getOAuthRedirectUrl,

  // Auth flow
  redirectToOAuth,
  handleOAuthCallback,
  syncFoundryUser,

  // Initialization
  initialize: initializeCoreAuthBypass,
  registerHooks: registerCoreAuthHooks,

  // Cleanup
  cleanupExpiredPendingAuth,
}

/**
 * Clean up expired pending auth states from sessionStorage
 * Called periodically to prevent accumulation of stale entries
 */
export function cleanupExpiredPendingAuth() {
  const pendingAuthData = sessionStorage.getItem(CORE_AUTH_CONFIG.PENDING_AUTH_KEY)

  if (!pendingAuthData) {
    return // Nothing to clean
  }

  try {
    const { timestamp } = JSON.parse(pendingAuthData)
    const age = Date.now() - timestamp

    if (age > CORE_AUTH_CONFIG.PENDING_AUTH_TIMEOUT) {
      console.log(`${LOG_PREFIX} Cleaning up expired pending auth (${Math.round(age / 1000)}s old)`)
      sessionStorage.removeItem(CORE_AUTH_CONFIG.PENDING_AUTH_KEY)
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to parse pending auth during cleanup:`, error)
    // Remove corrupted data
    sessionStorage.removeItem(CORE_AUTH_CONFIG.PENDING_AUTH_KEY)
  }
}

export default CoreAuthBypass
