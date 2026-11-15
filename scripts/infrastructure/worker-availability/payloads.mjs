import { validateBasicCredentials } from './credentials.mjs';

export const EXPECTED_PROJECT = 'hsr-currency-war-worker';
export const HOST = 'worker.35-223-56-40.sslip.io';
const invalid = () => { throw new Error('Invalid monitoring payload input'); };
const checkProject = value => { if (value !== EXPECTED_PROJECT) invalid(); };
const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === expected.split(',').sort().join();

// These pure builders neither access the network nor print/write their results.
// uptimeCheckConfig contains a password: keep its entire result private.
export function buildUptimeCheckConfig(input = {}) {
  if (!exactKeys(input, 'projectId,username,password')) invalid();
  const { projectId, username, password } = input;
  checkProject(projectId);
  try { validateBasicCredentials(username, password); } catch { invalid(); }
  return {
    displayName: 'HSR worker independent availability', period: '60s', timeout: '10s',
    checkerType: 'STATIC_IP_CHECKERS', disabled: false,
    monitoredResource: { type: 'uptime_url', labels: { project_id: EXPECTED_PROJECT, host: HOST } },
    selectedRegions: ['USA_IOWA', 'EUROPE', 'ASIA_PACIFIC'],
    httpCheck: { requestMethod: 'GET', useSsl: true, validateSsl: true, path: '/_hsr/availability', port: 443,
      maskHeaders: true, authInfo: { username, password }, acceptedResponseStatusCodes: [{ statusValue: 200 }] },
    // Absolute RE2 anchors enforce the complete, canonical JSON body. JSONPath
    // EXACT_MATCH at $.status would also accept extra fields in the response.
    contentMatchers: [{ matcher: 'MATCHES_REGEX', content: '\\A\\{"status":"ok"\\}\\z' }],
    logCheckFailures: false,
  };
}

export function buildAlertPolicy(input = {}) {
  if (!exactKeys(input, 'projectId,checkId,notificationChannel')) invalid();
  const { projectId, checkId, notificationChannel } = input;
  checkProject(projectId);
  if (typeof checkId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(checkId)
      || typeof notificationChannel !== 'string') invalid();
  const channelPrefix = `projects/${EXPECTED_PROJECT}/notificationChannels/`;
  const channel = /^[1-9]\d{0,24}$/.test(notificationChannel) ? channelPrefix + notificationChannel : notificationChannel;
  if (!channel.startsWith(channelPrefix) || !/^[1-9]\d{0,24}$/.test(channel.slice(channelPrefix.length))) invalid();
  return {
    displayName: 'HSR worker sustained unavailability', enabled: true, combiner: 'OR',
    conditions: [{ displayName: 'At least two checker locations fail for three minutes', conditionThreshold: {
      filter: `metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND metric.label.check_id="${checkId}" AND resource.label.project_id="${EXPECTED_PROJECT}" AND resource.label.host="${HOST}"`,
      comparison: 'COMPARISON_GT', thresholdValue: 1, duration: '180s', trigger: { count: 1 },
      evaluationMissingData: 'EVALUATION_MISSING_DATA_NO_OP',
      aggregations: [{ alignmentPeriod: '60s', perSeriesAligner: 'ALIGN_NEXT_OLDER', crossSeriesReducer: 'REDUCE_COUNT_FALSE',
        groupByFields: ['resource.label.project_id', 'resource.label.host', 'metric.label.check_id'] }],
    } }],
    notificationChannels: [channel],
    alertStrategy: { notificationPrompts: ['OPENED', 'CLOSED'], autoClose: '604800s' },
    documentation: { mimeType: 'text/markdown', content: 'Independent HTTPS availability for the existing HSR worker. At least two checker locations have failed continuously for three minutes. Inspect Caddy, hsr-worker-availability.service and hsr-worker-production.service using read-only status. Backup success cannot establish worker availability. A prolonged backup drain/stop can legitimately alert. Do not replay publishing jobs or restart a second worker. A CLOSED notification can also result from missing-data autoClose; verify successful check samples before claiming recovery.' },
  };
}

export function buildMonitoringPayloads(input = {}) {
  if (!exactKeys(input, 'projectId,checkId,notificationChannel,username,password')) invalid();
  const { projectId, checkId, notificationChannel, username, password } = input;
  return { projectId: EXPECTED_PROJECT,
    uptimeCheckConfig: buildUptimeCheckConfig({ projectId, username, password }),
    alertPolicy: buildAlertPolicy({ projectId, checkId, notificationChannel }) };
}
