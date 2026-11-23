// 首页延迟/丢包面板的候选节点，按展示顺序排列。
// 复用 8 个探针槽位（ct/cu/cm/bd + node_1..4），支持同时展示三网 IPv4 + IPv6 等多组节点。
export const THREE_NET_DEFS = Object.freeze([
  { key: 'ct', pingField: 'ping_ct', lossField: 'loss_ct', nameKey: 'custom_ct_name', labelKey: 'pingCt', fallbackLabel: 'CT' },
  { key: 'cu', pingField: 'ping_cu', lossField: 'loss_cu', nameKey: 'custom_cu_name', labelKey: 'pingCu', fallbackLabel: 'CU' },
  { key: 'cm', pingField: 'ping_cm', lossField: 'loss_cm', nameKey: 'custom_cm_name', labelKey: 'pingCm', fallbackLabel: 'CM' },
  { key: 'bd', pingField: 'ping_bd', lossField: 'loss_bd', nameKey: 'custom_bd_name', labelKey: 'pingBd', fallbackLabel: 'BGP' },
  { key: 'node_1', pingField: 'ping_node_1', lossField: 'loss_node_1', nameKey: 'node_1_name', labelKey: null, fallbackLabel: 'Node 1' },
  { key: 'node_2', pingField: 'ping_node_2', lossField: 'loss_node_2', nameKey: 'node_2_name', labelKey: null, fallbackLabel: 'Node 2' },
  { key: 'node_3', pingField: 'ping_node_3', lossField: 'loss_node_3', nameKey: 'node_3_name', labelKey: null, fallbackLabel: 'Node 3' },
  { key: 'node_4', pingField: 'ping_node_4', lossField: 'loss_node_4', nameKey: 'node_4_name', labelKey: null, fallbackLabel: 'Node 4' }
])

export const normalizeProbeMetricValue = (value) => {
  if (value === false || value === 'false') return false
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export const resolveProbeNodeLabel = (def, sysConfig = null, trans = null) => {
  const customName = sysConfig?.[def.nameKey]
  return String(customName || (def.labelKey && trans?.[def.labelKey]) || def.fallbackLabel)
}

// 判定“后台把该节点设成了 0（或留空禁用）”：优先看实时上报标量，
// 缺失时回退到 2h 窗口的最后一条。只认 false，数值 0 是合法的 0% 丢包。
export const isProbeNodeDisabled = (server, def) => {
  const realtimeLoss = normalizeProbeMetricValue(server?.[def.lossField])
  if (realtimeLoss === false) return true
  if (realtimeLoss !== null) return false

  const realtimePing = normalizeProbeMetricValue(server?.[def.pingField])
  if (realtimePing === false) return true
  if (typeof realtimePing === 'number' && realtimePing > 0) return false

  const loss = Array.isArray(server?.loss) ? server.loss : []
  if (loss.length > 0) {
    const lastLoss = loss[loss.length - 1]
    if (lastLoss && typeof lastLoss === 'object' && normalizeProbeMetricValue(lastLoss[def.key]) === false) {
      return true
    }
  }

  const ping = Array.isArray(server?.ping) ? server.ping : []
  if (ping.length > 0) {
    const lastPing = ping[ping.length - 1]
    if (lastPing && typeof lastPing === 'object' && normalizeProbeMetricValue(lastPing[def.key]) === false) {
      return true
    }
  }

  return false
}

export const hasProbeNodeMeasurement = (server, def, pingSeries = [], lossSeries = []) => {
  const realtimeLoss = normalizeProbeMetricValue(server?.[def.lossField])
  if (typeof realtimeLoss === 'number' && Number.isFinite(realtimeLoss)) return true

  // 历史表 ping_* 列默认值为 0（旧版探针未上报 node_1..4 时也是 0），因此只把正延迟视作有效实测。
  const realtimePing = normalizeProbeMetricValue(server?.[def.pingField])
  if (typeof realtimePing === 'number' && Number.isFinite(realtimePing) && realtimePing > 0) return true

  if (Array.isArray(pingSeries) && pingSeries.some(point => typeof point?.value === 'number' && Number.isFinite(point.value) && point.value > 0)) {
    return true
  }
  if (Array.isArray(lossSeries) && lossSeries.some(point => typeof point?.value === 'number' && Number.isFinite(point.value))) {
    return true
  }
  return false
}

// 展示全部已启用且有实测数据的节点（例如三网 IPv4 + 三网 IPv6 共 6 行）；
// 若服务器尚未产生任何探测数据，则回退展示前 3 个未禁用占位行；若 8 个节点全部显式禁用，返回空列表。
export const selectThreeNetNodeDefs = (server, getLatencySeries = null) => {
  const active = []
  const unreported = []

  for (const def of THREE_NET_DEFS) {
    if (isProbeNodeDisabled(server, def)) continue
    const pingSeries = typeof getLatencySeries === 'function' ? getLatencySeries('ping', def.key) : []
    const lossSeries = typeof getLatencySeries === 'function' ? getLatencySeries('loss', def.key) : []
    if (hasProbeNodeMeasurement(server, def, pingSeries, lossSeries)) {
      active.push(def)
    } else {
      unreported.push(def)
    }
  }

  if (active.length > 0) return active
  return unreported.slice(0, 3)
}

export const buildCompactPingList = (server, sysConfig = null, trans = null) => {
  const items = []
  for (const def of THREE_NET_DEFS) {
    if (isProbeNodeDisabled(server, def)) continue
    const pingVal = normalizeProbeMetricValue(server?.[def.pingField])
    const lossVal = normalizeProbeMetricValue(server?.[def.lossField])
    const hasPing = typeof pingVal === 'number' && Number.isFinite(pingVal) && pingVal > 0
    const hasLoss = typeof lossVal === 'number' && Number.isFinite(lossVal)
    if (!hasPing && !hasLoss) continue
    items.push({
      key: def.key,
      label: resolveProbeNodeLabel(def, sysConfig, trans),
      value: hasPing ? pingVal : null
    })
  }
  return items
}
