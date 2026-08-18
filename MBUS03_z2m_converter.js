/**
 * Zigbee2MQTT External Converter for LYNXPOWER MBUS03
 *
 * ESP32-C6 Zigbee Router with M-Bus Interface and OTA Firmware Updates.
 *
 * NEW FIRMWARE STRUCTURE (v5.x):
 *  - All M-Bus data is consolidated into ONE manufacturer-specific custom
 *    cluster (ID 0xFC00) living on ENDPOINT 2. The old per-value
 *    genAnalogInput endpoints (EP13-28) are GONE.
 *  - EP10: genOnOff (LED on/off) + genOta (OTA client) + genBasic.
 *  - EP11: genOnOff - writing ON triggers a full M-Bus scan; the firmware
 *    auto-resets it to OFF when the scan completes.
 *  - EP2 : custom cluster 0xFC00 holding all M-Bus values, descriptions and
 *    scan metadata.
 *
 * Custom cluster 0xFC00 attributes (all PLAIN, no manufacturerCode tag):
 *  - 0x0000..0x000F : value1..value16  (SINGLE / float, reportable)
 *  - 0x0010..0x001F : desc1..desc16    (CHAR_STRING, polled - string
 *                     reporting is unreliable on this stack)
 *  - 0x0100 : mbusAddress   U8 (reportable)
 *  - 0x0101 : mbusMedium    U8 (reportable, M-Bus medium code -> label)
 *  - 0x0102 : deviceCount   U8 (reportable)
 *  - 0x0103 : scanProgress  U8 (reportable, 0..100)
 *  - 0x0104 : scanInterval  U8 (read/write, auto-scan seconds 0..60, 0=off)
 *
 * Installation:
 *  1. Copy this file to your Zigbee2MQTT data/external_converters/ directory.
 *  2. Restart Zigbee2MQTT.
 *
 * OTA Update:
 *  1. Place firmware file (MBUS03_*.ota) in zigbee2mqtt/data/images/.
 *  2. Use the Z2M frontend or MQTT to trigger the update.
 *
 * Version: 5.0.0
 * Last Updated: 2026-08-13
 */

const {Zcl} = require('zigbee-herdsman');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const reporting = require('zigbee-herdsman-converters/lib/reporting');
const m = require('zigbee-herdsman-converters/lib/modernExtend');
const ea = exposes.access;

// Converter version - exposed to the Z2M interface
const CONVERTER_VERSION = '5.0.0';

// OTA Configuration (must match firmware defines)
const OTA_MANUFACTURER_CODE = 0x1001; // LYNXPOWER manufacturer code
const OTA_IMAGE_TYPE = 0x1001;        // image type (shared with MBUS02 family)

// Custom cluster
const MBUS_CLUSTER = 'mbusData';
const MBUS_CLUSTER_ID = 0xfc00; // 64512
const MBUS_ENDPOINT = 2;
const LED_ENDPOINT = 10;
const SCAN_ENDPOINT = 11;

// Number of M-Bus value/description slots
const VALUE_COUNT = 16;

// Fallback poll interval for values + metadata (reporting is unreliable on weak
// links / older z2m). Reports still give real-time updates where they work; this
// just guarantees z2m stays fresh even when they don't.
const POLL_INTERVAL_MS = 45 * 1000;

// Auto-scan interval written to the firmware so it keeps rediscovering the meter.
const SCAN_INTERVAL_S = 30;

// Attribute name helpers
// NUMERIC attribute IDs. z2m does not resolve this custom cluster's names at
// runtime (the fromZigbee never fires when matched by name, and the frontend
// bind list crashes on the null label), so we address the cluster and every
// attribute purely by numeric ID and never depend on name resolution.
const valueAttrs = Array.from({length: VALUE_COUNT}, (_, i) => 0x0000 + i);   // 0..15
const descAttrs = Array.from({length: VALUE_COUNT}, (_, i) => 0x0010 + i);    // 16..31
const metaAttrs = [0x0100, 0x0101, 0x0102, 0x0103, 0x0104];                    // addr/medium/count/pct/interval

// Build the custom cluster attribute definition programmatically.
// IMPORTANT: zigbee-herdsman stores a custom cluster as-is (no normalization),
// and when parsing an incoming frame it uses attribute.name as the payload key
// (getClusterAttribute returns the attribute object unchanged). So EVERY
// attribute object MUST carry an explicit `name` field, otherwise every value
// arrives under the key "undefined". Likewise the cluster object itself needs a
// `name` so frame.cluster.name resolves (and z2m dispatches by that name).
const mbusClusterAttributes = {};
for (let i = 0; i < VALUE_COUNT; i++) {
    mbusClusterAttributes[`value${i + 1}`] = {name: `value${i + 1}`, ID: 0x0000 + i, type: Zcl.DataType.SINGLE_PREC};
}
for (let i = 0; i < VALUE_COUNT; i++) {
    mbusClusterAttributes[`desc${i + 1}`] = {name: `desc${i + 1}`, ID: 0x0010 + i, type: Zcl.DataType.CHAR_STR};
}
mbusClusterAttributes.mbusAddress = {name: 'mbusAddress', ID: 0x0100, type: Zcl.DataType.UINT8};
mbusClusterAttributes.mbusMedium = {name: 'mbusMedium', ID: 0x0101, type: Zcl.DataType.UINT8};
mbusClusterAttributes.deviceCount = {name: 'deviceCount', ID: 0x0102, type: Zcl.DataType.UINT8};
mbusClusterAttributes.scanProgress = {name: 'scanProgress', ID: 0x0103, type: Zcl.DataType.UINT8};
mbusClusterAttributes.scanInterval = {name: 'scanInterval', ID: 0x0104, type: Zcl.DataType.UINT8};

// Full cluster definition object. Reused for both the modernExtend registration
// and the explicit device.addCustomCluster() call. Must include `name`.
const mbusClusterDefinition = {
    name: MBUS_CLUSTER,
    ID: MBUS_CLUSTER_ID,
    attributes: mbusClusterAttributes,
    commands: {},
    commandsResponse: {},
};

// Map an M-Bus medium code to a human-readable label.
function mbusMediumLabel(code) {
    const map = {
        0x00: 'Other',
        0x02: 'Electricity',
        0x03: 'Gas',
        0x04: 'Heat',
        0x06: 'Hot Water',
        0x07: 'Water',
    };
    if (Object.prototype.hasOwnProperty.call(map, code)) {
        return map[code];
    }
    const hex = Number(code).toString(16).toUpperCase().padStart(2, '0');
    return `Medium 0x${hex}`;
}

// Poll the CHAR_STRING descriptions (and metadata) from EP2. String
// reporting is unreliable on this stack, so descriptions are read on a
// timer and after (re)join instead of relying on attribute reports.
// Read a list of attributes in SMALL chunks. A Read Attributes response for all
// 16 value/desc attributes at once is ~128+ bytes, which exceeds one APS frame
// and forces ZDO/ZCL fragmentation (R23 window size 1) that this ESP/ZBOSS stack
// times out on. Reading a few attributes per request keeps every response inside
// a single frame, so the reads succeed reliably.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readChunked(ep, cluster, attrs, chunkSize, label) {
    for (let i = 0; i < attrs.length; i += chunkSize) {
        const chunk = attrs.slice(i, i + chunkSize);
        try {
            await ep.read(cluster, chunk);
        } catch (error) {
            console.log(`[MBUS03] Warning: poll ${label} [${chunk.join(',')}] failed: ${error.message}`);
        }
        // Space out the reads. Firing ~20 read requests back-to-back floods the
        // single-radio link, causing a burst of near-identical MQTT publishes and
        // ROUTE_ERRORs. A short gap keeps the airtime calm; the whole poll still
        // finishes in a few seconds and only runs occasionally.
        await sleep(250);
    }
}

// Register the manufacturer-specific custom cluster on the device object so that
// zigbee-herdsman resolves cluster 0xFC00 -> 'mbusData' when PARSING incoming
// frames (device.customClusters is consulted in Zcl.Frame.fromBuffer). Relying
// only on the m.deviceAddCustomCluster extend is not enough: its onEvent 'start'
// registration is skipped after an external-converter reload (z2m only fires
// 'start' once per device per process), which leaves the cluster unresolved and
// every attribute arrives as key 'undefined'. So we register it explicitly and
// idempotently here, from both configure() and onEvent().
function ensureCustomCluster(device) {
    // z2m passes its wrapper Device to onEvent, but frame parsing in
    // zigbee-herdsman consults the UNDERLYING herdsman device's customClusters
    // (device.zh). Register on the herdsman device so cluster 0xFC00 resolves at
    // parse time. Registering with NO manufacturerCode so getCluster() matches the
    // plain (non-manufacturer-specific) reports the firmware sends.
    const zh = (device && device.zh) ? device.zh : device;
    if (!zh || typeof zh.addCustomCluster !== 'function') {
        console.log(`[MBUS03] ensureCustomCluster: no addCustomCluster on ${zh ? 'zh' : 'device'}`);
        return;
    }
    try {
        const existing = zh.customClusters && zh.customClusters[MBUS_CLUSTER];
        // Re-register if missing OR if a previous (nameless) registration is
        // present, so upgrading the converter heals a broken definition.
        if (!existing || !existing.name || !existing.attributes || !existing.attributes.value1 || !existing.attributes.value1.name) {
            zh.addCustomCluster(MBUS_CLUSTER, mbusClusterDefinition);
            console.log(`[MBUS03] Registered custom cluster ${MBUS_CLUSTER} on zh; keys now=` +
                        JSON.stringify(Object.keys(zh.customClusters || {})));
        }
    } catch (error) {
        console.log(`[MBUS03] Warning: addCustomCluster failed: ${error.message}`);
    }
}

// Read the FULL state once (values + metadata + descriptions). Used only on
// (re)join: attribute reports fire only on change, so a one-time read is needed
// to seed z2m with the current values right after it (re)starts.
async function readAllOnce(device) {
    const ep2 = device.getEndpoint(MBUS_ENDPOINT);
    if (!ep2) {
        return;
    }
    await readChunked(ep2, MBUS_CLUSTER_ID, valueAttrs, 4, 'init-values');
    await readChunked(ep2, MBUS_CLUSTER_ID, metaAttrs, 4, 'init-metadata');
    await readChunked(ep2, MBUS_CLUSTER_ID, descAttrs, 1, 'init-descriptions');
}

// Read ONLY the descriptions, once, debounced. The firmware pushes values and
// metadata as attribute reports (on change), so we never poll those. Only the
// CHAR_STRING descriptions need a read (string reporting is unreliable on this
// stack), and only when the value set changes - which we detect in fromZigbee.
async function refreshDescriptions(device) {
    const ep2 = device.getEndpoint(MBUS_ENDPOINT);
    if (!ep2) {
        return;
    }
    if (device.mbusDescRefreshing) {
        return;   // a refresh is already in flight
    }
    device.mbusDescRefreshing = true;
    try {
        await readChunked(ep2, MBUS_CLUSTER_ID, descAttrs, 1, 'descriptions');
    } finally {
        device.mbusDescRefreshing = false;
    }
}

// Poll values + metadata (NOT descriptions - those are on-demand). This is a
// fallback for environments where attribute reporting is unreliable: weak/marginal
// links and older z2m (e.g. 2.9.x custom-cluster reporting bug). Reads are spaced
// (in readChunked) so the poll never bursts. Descriptions stay on-demand.
async function pollValuesMeta(device) {
    const ep2 = device.getEndpoint(MBUS_ENDPOINT);
    if (!ep2) {
        return;
    }
    await readChunked(ep2, MBUS_CLUSTER_ID, valueAttrs, 4, 'poll-values');
    await readChunked(ep2, MBUS_CLUSTER_ID, metaAttrs, 4, 'poll-metadata');
}

// Ask the firmware to scan the M-Bus so it (re)discovers the meter. Without a
// scan the firmware reports device_count 0 / all values 0. Writing scanInterval
// makes the firmware auto-scan; we also kick an immediate scan via EP11 genOnOff.
async function ensureScanning(device) {
    try {
        const ep2 = device.getEndpoint(MBUS_ENDPOINT);
        if (ep2) {
            // Auto-scan every SCAN_INTERVAL_S seconds so the meter is kept fresh.
            await ep2.write(MBUS_CLUSTER_ID, {0x0104: {value: SCAN_INTERVAL_S, type: Zcl.DataType.UINT8}});
        }
        const ep11 = device.getEndpoint(SCAN_ENDPOINT);
        if (ep11) {
            await ep11.command('genOnOff', 'on', {}, {});   // trigger one scan now
        }
    } catch (error) {
        console.log(`[MBUS03] Warning: ensureScanning failed: ${error.message}`);
    }
}

const definition = {
    zigbeeModel: ['MBUS03', 'MBUS03 LYNXPOWER', 'MBUS03 LYNXPOWER'],
    model: 'MBUS03',
    vendor: 'LYNXPOWER',
    description: 'ESP32-C6 Zigbee Router with M-Bus Interface and OTA Support',

    // OTA support
    ota: true,

    // Register the manufacturer-specific custom cluster so that fromZigbee /
    // configureReporting / read / write can address its attributes by name.
    extend: [
        m.deviceAddCustomCluster(MBUS_CLUSTER, mbusClusterDefinition),
    ],

    exposes: (device, options) => {
        const exposesArray = [
            // LED control (EP10 genOnOff)
            exposes.binary('state', ea.ALL, 'ON', 'OFF')
                .withDescription('Control the status LED (ON/OFF)'),

            // Scan trigger (EP11 genOnOff) - firmware auto-resets to OFF
            exposes.binary('scan', ea.ALL, 'ON', 'OFF')
                .withDescription('Trigger an M-Bus full scan (ON=start, auto-resets to OFF when done)'),

            // Auto-scan interval (EP2 custom cluster scanInterval, R/W)
            exposes.numeric('scan_interval', ea.STATE_SET)
                .withUnit('s')
                .withValueMin(0)
                .withValueMax(60)
                .withValueStep(1)
                .withDescription('Automatic scan interval in seconds (0=disabled, 1-60)'),

            // Scan metadata
            exposes.numeric('scan_progress', ea.STATE)
                .withUnit('%')
                .withValueMin(0)
                .withValueMax(100)
                .withDescription('M-Bus scan progress (0-100%)'),

            exposes.numeric('device_count', ea.STATE)
                .withValueMin(0)
                .withValueMax(250)
                .withDescription('Number of M-Bus devices discovered'),

            exposes.numeric('mbus_address', ea.STATE)
                .withValueMin(0)
                .withValueMax(250)
                .withDescription('M-Bus device address (primary address of the meter)'),

            exposes.text('mbus_medium', ea.STATE)
                .withDescription('M-Bus medium type (mapped from the medium code)'),

            // Converter version
            exposes.text('converter_version', ea.STATE)
                .withDescription('Z2M External Converter Version'),
        ];

        // 16 numeric value + text description pairs
        for (let i = 1; i <= VALUE_COUNT; i++) {
            exposesArray.push(
                exposes.numeric(`id${i}_value`, ea.STATE)
                    .withDescription(`M-Bus value ${i} (numeric)`),
            );
            exposesArray.push(
                exposes.text(`id${i}_description`, ea.STATE)
                    .withDescription(`M-Bus value ${i} description`),
            );
        }

        return exposesArray;
    },

    // From Zigbee -> MQTT
    fromZigbee: [
        // Custom M-Bus data cluster (EP2): values, descriptions and metadata.
        // Match by the cluster NAME: once the custom cluster is registered on the
        // device (device.addCustomCluster), zigbee-herdsman resolves cluster 0xFC00
        // to 'mbusData' and z2m dispatches incoming frames by that name. If it were
        // left unresolved, z2m reports cluster 'undefined' and no converter matches.
        {
            cluster: MBUS_CLUSTER,
            type: ['attributeReport', 'readResponse'],
            convert: (model, msg, publish, options, meta) => {
                const result = {};
                const data = msg.data || {};

                // Look an attribute up by BOTH its converter name and its numeric
                // attribute ID (decimal or hex string), so mapping works even when
                // z2m has not resolved the custom-cluster attribute names.
                const get = (name, id) => {
                    if (Object.prototype.hasOwnProperty.call(data, name)) return data[name];
                    if (Object.prototype.hasOwnProperty.call(data, id)) return data[id];
                    if (Object.prototype.hasOwnProperty.call(data, String(id))) return data[String(id)];
                    return undefined;
                };

                for (let i = 1; i <= VALUE_COUNT; i++) {
                    const v = get(`value${i}`, 0x0000 + (i - 1));
                    if (v !== undefined) {
                        const value = parseFloat(v);
                        if (!Number.isNaN(value)) {
                            result[`id${i}_value`] = Math.round(value * 1000) / 1000;
                        }
                    }
                    const d = get(`desc${i}`, 0x0010 + (i - 1));
                    if (d !== undefined) {
                        let desc = d;
                        if (typeof desc === 'string') {
                            desc = desc.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
                        }
                        result[`id${i}_description`] = desc;
                    }
                }

                const addr = get('mbusAddress', 0x0100);
                if (addr !== undefined) result.mbus_address = addr;
                const med = get('mbusMedium', 0x0101);
                if (med !== undefined) result.mbus_medium = mbusMediumLabel(med);
                const cnt = get('deviceCount', 0x0102);
                if (cnt !== undefined) result.device_count = cnt;
                const pct = get('scanProgress', 0x0103);
                if (pct !== undefined) result.scan_progress = pct;
                const iv = get('scanInterval', 0x0104);
                if (iv !== undefined) result.scan_interval = iv;

                // On-demand description fetch: descriptions aren't reported (they're
                // read), so when a value arrives for a slot whose description we
                // still don't have, read the descriptions once. The in-flight guard
                // in refreshDescriptions() keeps this from repeating.
                try {
                    const st = (meta && meta.state) || {};
                    let needDesc = false;
                    for (let i = 1; i <= VALUE_COUNT; i++) {
                        if (result[`id${i}_value`] !== undefined) {
                            const desc = result[`id${i}_description`] !== undefined
                                ? result[`id${i}_description`] : st[`id${i}_description`];
                            if (!desc || desc === '') { needDesc = true; break; }
                        }
                    }
                    if (needDesc && meta && meta.device) {
                        refreshDescriptions(meta.device).catch(() => {});
                    }
                } catch (e) { /* ignore */ }

                return result;
            },
        },

        // genOnOff: EP10 -> LED state, EP11 -> scan state
        {
            cluster: 'genOnOff',
            type: ['attributeReport', 'readResponse'],
            convert: (model, msg, publish, options, meta) => {
                if (!Object.prototype.hasOwnProperty.call(msg.data, 'onOff')) {
                    return {};
                }
                const value = msg.data.onOff === 1 ? 'ON' : 'OFF';
                const endpoint = msg.endpoint.ID;
                if (endpoint === LED_ENDPOINT) {
                    return {state: value};
                }
                if (endpoint === SCAN_ENDPOINT) {
                    return {scan: value};
                }
                return {};
            },
        },

        // Basic cluster (device info)
        {
            cluster: 'genBasic',
            type: ['attributeReport', 'readResponse'],
            convert: (model, msg, publish, options, meta) => {
                const result = {};
                const cleanString = (str) => {
                    if (!str) return str;
                    return str.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
                };

                if (Object.prototype.hasOwnProperty.call(msg.data, 'manufacturerName')) {
                    result.manufacturer = cleanString(msg.data.manufacturerName);
                }
                if (Object.prototype.hasOwnProperty.call(msg.data, 'modelId')) {
                    result.model_id = cleanString(msg.data.modelId);
                }
                if (Object.prototype.hasOwnProperty.call(msg.data, 'zclVersion')) {
                    result.zcl_version = msg.data.zclVersion;
                }

                result.converter_version = CONVERTER_VERSION;
                return result;
            },
        },
    ],

    // From MQTT -> Zigbee
    toZigbee: [
        // LED state (EP10 genOnOff)
        {
            key: ['state'],
            convertSet: async (entity, key, value, meta) => {
                const endpoint = meta.device.getEndpoint(LED_ENDPOINT);
                const on = String(value).toLowerCase() === 'on';
                await endpoint.command('genOnOff', on ? 'on' : 'off', {}, {});
                return {
                    state: {state: on ? 'ON' : 'OFF'},
                    readAfterWriteTime: 250,
                };
            },
            convertGet: async (entity, key, meta) => {
                const endpoint = meta.device.getEndpoint(LED_ENDPOINT);
                await endpoint.read('genOnOff', ['onOff']);
            },
        },

        // Scan trigger (EP11 genOnOff). Writing ON starts the scan.
        {
            key: ['scan'],
            convertSet: async (entity, key, value, meta) => {
                const endpoint = meta.device.getEndpoint(SCAN_ENDPOINT);
                const on = String(value).toLowerCase() === 'on';
                await endpoint.command('genOnOff', on ? 'on' : 'off', {}, {});
                if (on) {
                    return {
                        state: {scan: 'ON', scan_progress: 0},
                        readAfterWriteTime: 250,
                    };
                }
                return {
                    state: {scan: 'OFF'},
                    readAfterWriteTime: 250,
                };
            },
            convertGet: async (entity, key, meta) => {
                const endpoint = meta.device.getEndpoint(SCAN_ENDPOINT);
                await endpoint.read('genOnOff', ['onOff']);
            },
        },

        // Auto-scan interval (EP2 custom cluster scanInterval attribute)
        {
            key: ['scan_interval'],
            convertSet: async (entity, key, value, meta) => {
                const endpoint = meta.device.getEndpoint(MBUS_ENDPOINT);
                let interval = parseInt(value, 10);
                if (Number.isNaN(interval)) interval = 0;
                if (interval < 0) interval = 0;
                if (interval > 60) interval = 60;
                await endpoint.write(MBUS_CLUSTER_ID, {0x0104: {value: interval, type: Zcl.DataType.UINT8}});
                return {
                    state: {scan_interval: interval},
                    readAfterWriteTime: 250,
                };
            },
            convertGet: async (entity, key, meta) => {
                const endpoint = meta.device.getEndpoint(MBUS_ENDPOINT);
                await endpoint.read(MBUS_CLUSTER_ID, [0x0104]);
            },
        },
    ],

    configure: async (device, coordinatorEndpoint) => {
        console.log(`[MBUS03] Starting configuration for device ${device.ieeeAddr}`);
        console.log(`[MBUS03] Available endpoints:`, device.endpoints.map((ep) => ep.ID));

        // Make sure cluster 0xFC00 resolves to 'mbusData' before any read/report.
        ensureCustomCluster(device);
        console.log(`[MBUS03] customClusters:`, Object.keys(device.customClusters || {}));

        const ep2 = device.getEndpoint(MBUS_ENDPOINT);
        const ep10 = device.getEndpoint(LED_ENDPOINT);
        const ep11 = device.getEndpoint(SCAN_ENDPOINT);

        // EP2: custom M-Bus data cluster
        if (ep2) {
            try {
                await reporting.bind(ep2, coordinatorEndpoint, [MBUS_CLUSTER_ID]);
                console.log(`[MBUS03] Bound EP2 (${MBUS_CLUSTER})`);
            } catch (error) {
                console.log(`[MBUS03] Warning: Failed to bind EP2 ${MBUS_CLUSTER}: ${error.message}`);
            }

            // Report each float value (min 1s, max 300s, on any change)
            for (const attr of valueAttrs) {
                try {
                    await ep2.configureReporting(MBUS_CLUSTER_ID, [
                        {
                            attribute: attr,
                            minimumReportInterval: 1,
                            maximumReportInterval: 300,
                            reportableChange: 0,
                        },
                    ]);
                } catch (error) {
                    console.log(`[MBUS03] Warning: Failed to configure reporting for ${attr}: ${error.message}`);
                }
            }

            // Report metadata (min 0s, max 1h, on any change)
            for (const attr of [0x0100, 0x0101, 0x0102, 0x0103]) {
                try {
                    await ep2.configureReporting(MBUS_CLUSTER_ID, [
                        {
                            attribute: attr,
                            minimumReportInterval: 0,
                            maximumReportInterval: 3600,
                            reportableChange: 0,
                        },
                    ]);
                } catch (error) {
                    console.log(`[MBUS03] Warning: Failed to configure reporting for ${attr}: ${error.message}`);
                }
            }
        } else {
            console.log(`[MBUS03] Warning: EP2 (M-Bus data cluster) not present on this device`);
        }

        // EP10: LED On/Off (+ OTA client)
        if (ep10) {
            try {
                await reporting.bind(ep10, coordinatorEndpoint, ['genOnOff']);
                await reporting.onOff(ep10);
                console.log(`[MBUS03] Configured EP10 (LED + OTA)`);
            } catch (error) {
                console.log(`[MBUS03] Warning: Failed to configure EP10: ${error.message}`);
            }
        }

        // EP11: Scan trigger
        if (ep11) {
            try {
                await reporting.bind(ep11, coordinatorEndpoint, ['genOnOff']);
                console.log(`[MBUS03] Configured EP11 (Scan)`);
            } catch (error) {
                console.log(`[MBUS03] Warning: Failed to configure EP11: ${error.message}`);
            }
        }

        // Initial reads
        try {
            if (ep10) await ep10.read('genOnOff', ['onOff']);
            if (ep11) await ep11.read('genOnOff', ['onOff']);
            if (ep10) await ep10.read('genBasic', ['manufacturerName', 'modelId', 'zclVersion']);
        } catch (error) {
            console.log(`[MBUS03] Warning: Failed to read initial states: ${error.message}`);
        }

        if (ep2) {
            // Make sure the firmware is scanning the M-Bus (otherwise it reports
            // device_count 0 / values 0), then seed z2m with the current state.
            await ensureScanning(device);
            await readAllOnce(device);
        }

        console.log(`[MBUS03] Configuration complete. OTA updates available via EP10.`);
    },

    // Data delivery is BELT-AND-SUSPENDERS: attribute reports give real-time
    // updates where they work (strong link + recent z2m), and a spaced periodic
    // poll of values+metadata guarantees freshness where reporting is unreliable
    // (weak/marginal links, older z2m). Descriptions are read on join + on demand.
    //
    // NOTE: modern zigbee-herdsman-converters calls onEvent with a SINGLE event
    // object ({type, data}), not the legacy (type, data, device) argument list.
    onEvent: async (event) => {
        const type = event?.type;
        const device = event?.data?.device;
        if (!device) {
            return;
        }

        const key = 'mbusPollInterval';

        if (type === 'stop') {
            if (device[key]) {
                clearInterval(device[key]);
                device[key] = undefined;
            }
            return;
        }

        // Re-register the custom cluster on every lifecycle event so cluster
        // 0xFC00 always resolves to 'mbusData', including after converter reloads
        // where the 'start' event does not re-fire for an already-started device.
        ensureCustomCluster(device);

        if (type === 'start' || type === 'deviceAnnounce' || type === 'deviceInterview') {
            // Kick the firmware into scanning + seed current state once.
            ensureScanning(device)
                .then(() => readAllOnce(device))
                .catch((err) => console.log(`[MBUS03] Initial seed failed: ${err.message}`));

            // Start the fallback value+metadata poll (guard against duplicates).
            if (!device[key]) {
                device[key] = setInterval(() => {
                    pollValuesMeta(device).catch((err) => {
                        console.log(`[MBUS03] Value poll failed: ${err.message}`);
                    });
                }, POLL_INTERVAL_MS);
                console.log(`[MBUS03] Started value poll (${POLL_INTERVAL_MS / 1000}s)`);
            }
        }
    },

    meta: {
        multiEndpoint: true,
    },
};

module.exports = definition;
