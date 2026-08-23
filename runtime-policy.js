import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const env = {};
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

export function readConfigValue(root, key) {
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  const local = parseEnvFile(join(root, '.env.config'));
  return local[key] !== undefined && local[key] !== '' ? local[key] : undefined;
}

export function multiAccountEnabled(value, legacyValue) {
  return (value !== undefined ? value : legacyValue) === '1';
}

export function selectRunnableSources(sources, allowMultiple) {
  const enabled = (Array.isArray(sources) ? sources : []).filter(source => source.enabled !== false);
  return allowMultiple ? enabled : enabled.slice(0, 1);
}

export function createFullAgentGuard(fullAgent) {
  return function fullAgentGuard(req, res, next) {
    if (fullAgent || req.method === 'GET') return next();
    res.set('Allow', 'GET');
    return res.status(405).json({
      error: 'Read-only API: set FULL_AGENT=1 to allow non-GET requests.',
    });
  };
}

function positiveInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function loadRuntimePolicy(root) {
  const multiAccount = readConfigValue(root, 'MULTI_ACCOUNT');
  const legacyMultiAccounts = readConfigValue(root, 'MULTI_ACCOUNTS');
  const retentionModeValue = readConfigValue(root, 'AUTO_RETENTION');
  const retentionMode = retentionModeValue === '1' ? 1 : retentionModeValue === '2' ? 2 : 0;

  return {
    multiAccount: multiAccountEnabled(multiAccount, legacyMultiAccounts),
    fullAgent: readConfigValue(root, 'FULL_AGENT') === '1',
    retentionMode,
    imageRetentionDays: positiveInteger(readConfigValue(root, 'IMAGE_RETENTION_DAYS')),
  };
}
