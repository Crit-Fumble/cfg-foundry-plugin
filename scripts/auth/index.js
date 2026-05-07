/**
 * Auth Module Index
 * Exports all authentication-related functionality
 */

export {
  CoreAuthBypass,
  CORE_AUTH_CONFIG,
  registerCoreAuthSettings,
  getCoreAuthUrl,
  getCoreWorldId,
  isCoreAuthEnabled,
  validateCoreAuthConfig,
  getOAuthRedirectUrl,
  redirectToOAuth,
  handleOAuthCallback,
  syncFoundryUser,
  initializeCoreAuthBypass,
  registerCoreAuthHooks,
} from './core-auth.js'
