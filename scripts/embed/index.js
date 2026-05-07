/**
 * Embedded Apps Module
 * Provides infrastructure for embedding core.crit-fumble.com apps in Foundry VTT
 */

export { vttBridge, VTTBridge, VTT_BRIDGE_MESSAGES } from './vtt-bridge.js'
export {
  EmbeddedApp,
  openOnboardingWizard,
  openCampaignDashboard,
  openJournalViewer,
  openCharacterSheet,
  openEntityBrowser,
  openEntitySheet,
} from './embedded-app.js'
