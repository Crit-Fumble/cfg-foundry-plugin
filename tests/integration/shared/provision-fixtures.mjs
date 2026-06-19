#!/usr/bin/env node
/**
 * Provision the world-centric Core fixtures the self-hosted integration specs
 * need (a cfk_ API key + standalone/single/multi installation+campaign links),
 * and write them into tests/.env.test.
 *
 * The fixtures live in the e2e Core DB, so this delegates to the core-server's
 * own seed (which has the Prisma client + secrets) inside its container, parses
 * the printed result, and upserts two keys into tests/.env.test:
 *   CORE_TEST_API_KEY        — cfk_ bearer key for self-hosted auth
 *   CORE_TEST_FOUNDRY_FIXTURE — JSON: { worldId, installations{…}, campaigns{…} }
 *
 * Run after the e2e Core stack + Foundry stack are up:
 *   npm run test:foundry:provision
 * Re-run any time the test DB is reseeded. Idempotent.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const CONTAINER = process.env.CORE_TEST_CONTAINER || 'cfg-core-server-test'
const SEED = 'prisma/seed-foundry-test-fixtures.ts'
const ENV_FILE = process.env.FOUNDRY_ENV_FILE || 'tests/.env.test'

function run() {
  let out
  try {
    out = execFileSync('docker', ['exec', '-w', '/app', CONTAINER, 'npx', 'tsx', SEED], { encoding: 'utf8' })
  } catch (err) {
    console.error(`[provision] failed to run the seed in container "${CONTAINER}". Is the e2e Core stack up?`)
    console.error(err.stderr || err.message)
    process.exit(1)
  }
  const line = out.split('\n').find((l) => l.startsWith('CFG_PROVISION_RESULT '))
  if (!line) {
    console.error('[provision] seed did not print CFG_PROVISION_RESULT. Raw output:\n', out)
    process.exit(1)
  }
  return JSON.parse(line.slice('CFG_PROVISION_RESULT '.length))
}

// Upsert KEY=value lines, preserving the rest of the file. Removes the retired
// single-campaign CORE_TEST_CAMPAIGN_ID if present.
function writeEnv(updates, remove = []) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n') : []
  const seen = new Set()
  const next = lines
    .filter((l) => !remove.some((k) => l.startsWith(`${k}=`)))
    .map((l) => {
      const m = l.match(/^([A-Z_][A-Z0-9_]*)=/)
      if (m && updates[m[1]] !== undefined) {
        seen.add(m[1])
        return `${m[1]}=${updates[m[1]]}`
      }
      return l
    })
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) next.push(`${k}=${v}`)
  writeFileSync(ENV_FILE, next.join('\n'))
}

const fixture = run()
const { apiKey, ...rest } = fixture
writeEnv(
  { CORE_TEST_API_KEY: apiKey, CORE_TEST_FOUNDRY_FIXTURE: JSON.stringify(rest) },
  ['CORE_TEST_CAMPAIGN_ID'],
)

console.log(
  `[provision] wrote ${ENV_FILE}:\n` +
    `  CORE_TEST_API_KEY=cfk_****(set)\n` +
    `  CORE_TEST_FOUNDRY_FIXTURE=${JSON.stringify(rest)}`,
)
