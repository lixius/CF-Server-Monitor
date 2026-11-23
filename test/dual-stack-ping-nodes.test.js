import assert from 'node:assert/strict';
import test from 'node:test';

import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { getHistoryMetrics } from '../src/handlers/update.js';
import { generateToken } from '../src/middleware/auth.js';
import { AGENT_CONFIG_SCHEMA_VERSION, buildAgentConfig, describeAgentConfig } from '../src/utils/agentConfig.js';
import { clearAllCaches } from '../src/utils/cache.js';
import { clearSiteSettingsCache, loadSiteSettings } from '../src/utils/settings.js';
import { buildCompactPingList, selectThreeNetNodeDefs } from '../src/frontend/utils/latencyNodes.js';

globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
};

function createEmptySettingsDb() {
  let persistedSiteOptions = null;
  return {
    prepare(sql) {
      return {
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          if (sql.includes("WHERE key = 'site_options'")) {
            return persistedSiteOptions ? { value: persistedSiteOptions } : null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.includes('INSERT INTO settings') && Array.isArray(this.args)) {
            if (this.args[0] === 'site_options' && typeof this.args[1] === 'string') {
              persistedSiteOptions = this.args[1];
            } else if (sql.includes('json_object')) {
              persistedSiteOptions = JSON.stringify({ jwt_secret: this.args[0] });
            }
          }
          return { success: true };
        }
      };
    }
  };
}

test('default site settings cover both IPv4 and IPv6 three-net probe targets', async () => {
  clearSiteSettingsCache();
  const settings = await loadSiteSettings(createEmptySettingsDb(), { forceRefresh: true });

  assert.equal(settings.custom_ct, 'gd-ct-v4.ip.zstaticcdn.com');
  assert.equal(settings.custom_cu, 'gd-cu-v4.ip.zstaticcdn.com');
  assert.equal(settings.custom_cm, 'gd-cm-v4.ip.zstaticcdn.com');
  assert.equal(settings.node_1, 'gd-ct-v6.ip.zstaticcdn.com');
  assert.equal(settings.node_2, 'gd-cu-v6.ip.zstaticcdn.com');
  assert.equal(settings.node_3, 'gd-cm-v6.ip.zstaticcdn.com');
  assert.equal(settings.custom_ct_name, '电信 v4');
  assert.equal(settings.custom_cu_name, '联通 v4');
  assert.equal(settings.custom_cm_name, '移动 v4');
  assert.equal(settings.node_1_name, '电信 v6');
  assert.equal(settings.node_2_name, '联通 v6');
  assert.equal(settings.node_3_name, '移动 v6');

  const dualStackConfig = buildAgentConfig({}, settings, AGENT_CONFIG_SCHEMA_VERSION);
  assert.equal(dualStackConfig.custom_ct, 'gd-ct-v4.ip.zstaticcdn.com');
  assert.equal(dualStackConfig.custom_cu, 'gd-cu-v4.ip.zstaticcdn.com');
  assert.equal(dualStackConfig.custom_cm, 'gd-cm-v4.ip.zstaticcdn.com');
  assert.equal(dualStackConfig.node_1, 'gd-ct-v6.ip.zstaticcdn.com');
  assert.equal(dualStackConfig.node_2, 'gd-cu-v6.ip.zstaticcdn.com');
  assert.equal(dualStackConfig.node_3, 'gd-cm-v6.ip.zstaticcdn.com');

  // IPv4-only server can explicitly disable v6 slots via '0'
  const ipv4OnlyConfig = buildAgentConfig({ node_1: '0', node_2: '0', node_3: '0' }, settings, AGENT_CONFIG_SCHEMA_VERSION);
  assert.equal(ipv4OnlyConfig.custom_ct, 'gd-ct-v4.ip.zstaticcdn.com');
  assert.equal(ipv4OnlyConfig.node_1, '');
  assert.equal(ipv4OnlyConfig.node_2, '');
  assert.equal(ipv4OnlyConfig.node_3, '');
});

test('history metric aggregation averages node_1..node_4 ping and loss alongside ct/cu/cm/bd', () => {
  const samples = [
    {
      ts: 1,
      metrics: {
        ping_ct: 100,
        loss_ct: 0,
        ping_node_1: 200,
        loss_node_1: 0,
        ping_node_2: false,
        loss_node_2: false,
        ping_node_3: null,
        loss_node_3: 100
      }
    },
    {
      ts: 2,
      metrics: {
        ping_ct: 200,
        loss_ct: 20,
        ping_node_1: 300,
        loss_node_1: 50,
        ping_node_2: false,
        loss_node_2: false,
        ping_node_3: 60,
        loss_node_3: 0
      }
    }
  ];

  const aggregated = getHistoryMetrics({}, samples, samples[samples.length - 1]);
  assert.equal(aggregated.ping_ct, 150);
  assert.equal(aggregated.loss_ct, 10);
  assert.equal(aggregated.ping_node_1, 250);
  assert.equal(aggregated.loss_node_1, 25);
  assert.equal(aggregated.ping_node_2, false);
  assert.equal(aggregated.loss_node_2, false);
  assert.equal(aggregated.ping_node_3, 60);
  assert.equal(aggregated.loss_node_3, 50);
});

test('selectThreeNetNodeDefs expands all 6 enabled dual-stack nodes and avoids legacy ghost rows', () => {
  const dualStackServer = {
    ping_ct: 1200, loss_ct: 16,
    ping_cu: 256, loss_cu: 0,
    ping_cm: 58, loss_cm: 0,
    ping_bd: false, loss_bd: false,
    ping_node_1: 246, loss_node_1: 0,
    ping_node_2: 92, loss_node_2: 0,
    ping_node_3: 231, loss_node_3: 0,
    ping_node_4: false, loss_node_4: false
  };
  assert.deepEqual(
    selectThreeNetNodeDefs(dualStackServer).map(def => def.key),
    ['ct', 'cu', 'cm', 'node_1', 'node_2', 'node_3']
  );

  // 100% packet loss timeout must remain visible
  const timeoutServer = {
    ...dualStackServer,
    ping_ct: null,
    loss_ct: 100
  };
  assert.deepEqual(
    selectThreeNetNodeDefs(timeoutServer).map(def => def.key),
    ['ct', 'cu', 'cm', 'node_1', 'node_2', 'node_3']
  );

  // Legacy agent rows have ping_node_1..4 = 0 and loss_node_1..4 = null -> no ghost rows
  const legacyServer = {
    ping_ct: 40, loss_ct: 0,
    ping_cu: 50, loss_cu: 0,
    ping_cm: 60, loss_cm: 0,
    ping_bd: false, loss_bd: false,
    ping_node_1: 0, loss_node_1: null,
    ping_node_2: 0, loss_node_2: null,
    ping_node_3: 0, loss_node_3: null,
    ping_node_4: 0, loss_node_4: null
  };
  assert.deepEqual(
    selectThreeNetNodeDefs(legacyServer).map(def => def.key),
    ['ct', 'cu', 'cm']
  );

  // Brand-new server with no reports yet falls back to 3 placeholder rows
  assert.deepEqual(
    selectThreeNetNodeDefs({}).map(def => def.key),
    ['ct', 'cu', 'cm']
  );

  // All 8 slots explicitly disabled hides the latency panel
  const allDisabledServer = {
    ping_ct: false, loss_ct: false,
    ping_cu: false, loss_cu: false,
    ping_cm: false, loss_cm: false,
    ping_bd: false, loss_bd: false,
    ping_node_1: false, loss_node_1: false,
    ping_node_2: false, loss_node_2: false,
    ping_node_3: false, loss_node_3: false,
    ping_node_4: false, loss_node_4: false
  };
  assert.deepEqual(selectThreeNetNodeDefs(allDisabledServer), []);

  // Newly disabled node is immediately hidden even if historical series still has numbers
  const newlyDisabledServer = {
    ...dualStackServer,
    ping_node_1: false,
    loss_node_1: false
  };
  const seriesStub = (type, key) => key === 'node_1' ? [{ ts: 1, value: 240 }] : [];
  assert.deepEqual(
    selectThreeNetNodeDefs(newlyDisabledServer, seriesStub).map(def => def.key),
    ['ct', 'cu', 'cm', 'node_2', 'node_3']
  );
});

test('buildCompactPingList uses custom sysConfig labels and includes all 6 dual-stack nodes', () => {
  const server = {
    ping_ct: 120, loss_ct: 0,
    ping_cu: 95, loss_cu: 0,
    ping_cm: 58, loss_cm: 0,
    ping_bd: false, loss_bd: false,
    ping_node_1: null, loss_node_1: 100,
    ping_node_2: 88, loss_node_2: 0,
    ping_node_3: 230, loss_node_3: 0,
    ping_node_4: 0, loss_node_4: null
  };
  const sysConfig = {
    custom_ct_name: '电信 v4',
    custom_cu_name: '联通 v4',
    custom_cm_name: '移动 v4',
    node_1_name: '电信 v6',
    node_2_name: '联通 v6',
    node_3_name: '移动 v6'
  };

  assert.deepEqual(buildCompactPingList(server, sysConfig), [
    { key: 'ct', label: '电信 v4', value: 120 },
    { key: 'cu', label: '联通 v4', value: 95 },
    { key: 'cm', label: '移动 v4', value: 58 },
    { key: 'node_1', label: '电信 v6', value: null },
    { key: 'node_2', label: '联通 v6', value: 88 },
    { key: 'node_3', label: '移动 v6', value: 230 }
  ]);
});

test('MetricsBroadcaster pushes updated global ping nodes to connected WSS agents', async () => {
  clearAllCaches();
  clearSiteSettingsCache();

  const serverRow = {
    id: 'server-dualstack-1',
    name: 'DualStack',
    history_partition_id: 1,
    collect_interval: 0,
    report_interval: 60,
    wss_report_interval: 2,
    reset_day: 1,
    connection_mode: 'auto',
    ping_mode: 'tcp',
    custom_ct: '',
    custom_cu: '',
    custom_cm: '',
    custom_bd: '',
    node_1: '',
    node_2: '',
    node_3: '',
    node_4: ''
  };
  const updatedSettings = {
    wss_report_enabled: 'true',
    custom_ct: 'gd-ct-v4.ip.zstaticcdn.com',
    custom_cu: 'gd-cu-v4.ip.zstaticcdn.com',
    custom_cm: 'gd-cm-v4.ip.zstaticcdn.com',
    custom_bd: '',
    node_1: 'gd-ct-v6.ip.zstaticcdn.com',
    node_2: 'gd-cu-v6.ip.zstaticcdn.com',
    node_3: 'gd-cm-v6.ip.zstaticcdn.com',
    node_4: ''
  };

  const sentFrames = [];
  let attachment = {
    kind: 'agent-report',
    authenticated: true,
    serverId: serverRow.id,
    configSchema: AGENT_CONFIG_SCHEMA_VERSION,
    configMd5: '0'.repeat(32)
  };
  const ws = {
    deserializeAttachment: () => attachment,
    serializeAttachment: (next) => { attachment = next; },
    send: (msg) => sentFrames.push(JSON.parse(msg))
  };

  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          if (sql.includes("WHERE key = 'site_options'")) {
            return { value: JSON.stringify(updatedSettings) };
          }
          if (sql.includes('FROM servers')) {
            return serverRow;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true };
        }
      };
    }
  };

  const state = {
    setWebSocketAutoResponse() {},
    getWebSockets: () => [ws]
  };
  const broadcaster = new MetricsBroadcaster(state, { DB: db });

  const response = await broadcaster._handleAgentConfigChanged(new Request('http://internal/agent-config-changed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ globalConfigChanged: true })
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.servers, 1);
  assert.equal(body.delivered, 1);
  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0].type, 'config');
  assert.equal(sentFrames[0].payload.custom_ct, 'gd-ct-v4.ip.zstaticcdn.com');
  assert.equal(sentFrames[0].payload.node_1, 'gd-ct-v6.ip.zstaticcdn.com');
  assert.equal(sentFrames[0].payload.node_2, 'gd-cu-v6.ip.zstaticcdn.com');
  assert.equal(sentFrames[0].payload.node_3, 'gd-cm-v6.ip.zstaticcdn.com');

  const expected = await describeAgentConfig(serverRow, updatedSettings, AGENT_CONFIG_SCHEMA_VERSION);
  assert.equal(sentFrames[0].config_md5, expected.md5);
});

test('save_settings notifies global agent config change only when ping nodes change', async () => {
  clearSiteSettingsCache();
  const notifications = [];
  let persistedSiteOptions = JSON.stringify({
    jwt_secret: 'a'.repeat(64),
    username: 'admin',
    password: 'hashed-password',
    wss_report_enabled: 'true',
    custom_ct: 'gd-ct-dualstack.ip.zstaticcdn.com',
    custom_cu: 'gd-cu-dualstack.ip.zstaticcdn.com',
    custom_cm: 'gd-cm-dualstack.ip.zstaticcdn.com',
    node_1: '',
    node_2: '',
    node_3: '',
    node_4: ''
  });

  const env = {
    API_USER_NAME: 'admin',
    API_SECRET: 'secret',
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            this.args = args;
            return this;
          },
          async first() {
            if (sql.includes("WHERE key = 'site_options'")) {
              return { value: persistedSiteOptions };
            }
            return null;
          },
          async all() {
            if (sql.includes('PRAGMA table_info')) {
              return {
                results: [
                  { name: 'traffic_alert_percent' },
                  { name: 'traffic_alert_state' }
                ]
              };
            }
            return { results: [] };
          },
          async run() {
            if (sql.includes('INSERT INTO settings') && this.args?.[0] === 'site_options') {
              persistedSiteOptions = this.args[1];
            }
            return { success: true };
          }
        };
      }
    },
    METRICS_BROADCASTER: {
      idFromName: () => 'global',
      get: () => ({
        fetch: async (url, init) => {
          notifications.push({ url, body: JSON.parse(init.body) });
          return new Response(JSON.stringify({ ok: true }));
        }
      })
    }
  };

  const sys = {
    jwt_secret: 'a'.repeat(64),
    username: 'admin',
    password: 'hashed-password',
    wss_report_enabled: 'true',
    custom_ct: 'gd-ct-dualstack.ip.zstaticcdn.com',
    custom_cu: 'gd-cu-dualstack.ip.zstaticcdn.com',
    custom_cm: 'gd-cm-dualstack.ip.zstaticcdn.com',
    node_1: '',
    node_2: '',
    node_3: '',
    node_4: ''
  };
  const token = await generateToken(env, sys);
  const waitPromises = [];
  const ctx = { waitUntil: (promise) => waitPromises.push(promise) };

  // Unrelated setting change should not wake Durable Object
  const res1 = await handleAdminAPI(new Request('https://example.com/api/admin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      action: 'save_settings',
      settings: { site_title: 'My Monitor' }
    })
  }), env, sys, null, ctx);
  assert.equal(res1.status, 200);
  await Promise.all(waitPromises);
  assert.equal(notifications.length, 0);

  // Ping node update should trigger globalConfigChanged push
  const res2 = await handleAdminAPI(new Request('https://example.com/api/admin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      action: 'save_settings',
      settings: {
        custom_ct: 'gd-ct-v4.ip.zstaticcdn.com',
        node_1: 'gd-ct-v6.ip.zstaticcdn.com'
      }
    })
  }), env, sys, null, ctx);
  assert.equal(res2.status, 200);
  await Promise.all(waitPromises);
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0].body, { globalConfigChanged: true });
});
