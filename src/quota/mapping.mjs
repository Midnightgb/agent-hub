export function getProvider(agent, model) {
  if (agent === 'agy') {
    if (model.startsWith('gemini-') || model.startsWith('claude-') || model.startsWith('gpt-')) {
      return 'antigravity'
    }
  } else if (agent === 'copilot') {
    return 'copilot'
  } else if (agent === 'codex') {
    return 'codex'
  } else if ((agent === 'opencode' || agent === 'gentle-shell') && model.startsWith('opencode-go/')) {
    return 'opencodego'
  } else if (agent === 'claude' && ['haiku', 'sonnet', 'opus'].includes(model)) {
    return 'claude'
  }
  return null
}

export function quotaFor({ agent, model }, usageByProvider) {
  let provider = null
  let neededWindows = [] // Array of { key: 'primary' | 'secondary' | 'tertiary', label: string } or extra window check function

  if (agent === 'agy') {
    if (model.startsWith('gemini-')) {
      provider = 'antigravity'
      neededWindows = [
        { key: 'primary', label: 'Primary' },
        (extra) => extra.id.includes('-gemini-')
      ]
    } else if (model.startsWith('claude-') || model.startsWith('gpt-')) {
      provider = 'antigravity'
      neededWindows = [
        { key: 'secondary', label: 'Secondary' },
        (extra) => extra.id.includes('-3p-')
      ]
    }
  } else if (agent === 'copilot') {
    provider = 'copilot'
    neededWindows = [{ key: 'primary', label: 'Primary' }]
  } else if (agent === 'codex') {
    provider = 'codex'
    neededWindows = [
      { key: 'primary', label: 'Primary' },
      { key: 'secondary', label: 'Secondary', optional: true },
      { key: 'tertiary', label: 'Tertiary', optional: true }
    ]
  } else if (agent === 'opencode') {
    if (model.startsWith('opencode-go/')) {
      provider = 'opencodego'
      neededWindows = [
        { key: 'primary', label: 'Primary' },
        { key: 'secondary', label: 'Secondary' },
        { key: 'tertiary', label: 'Tertiary' }
      ]
    } else {
      return { note: 'not metered by CodexBar' }
    }
  } else if (agent === 'claude') {
    if (['haiku', 'sonnet', 'opus'].includes(model)) {
      provider = 'claude'
      neededWindows = [
        { key: 'primary', label: 'Primary' },
        { key: 'secondary', label: 'Secondary' },
        (extra) => true // include all extra windows
      ]
    }
  }

  if (!provider) return null

  const usageData = usageByProvider[provider]
  if (!usageData) {
     return { quotaUnavailableReason: 'no_data' }
  }
  if (usageData.pending) {
     // cached mode, nothing cached yet: a background refresh has started.
     return { quotaUnavailableReason: 'quota_pending' }
  }
  if (usageData.error) {
     return { quotaUnavailableReason: usageData.error }
  }

  // CodexBar responses are arrays (for the requested provider)
  const entry = Array.isArray(usageData) ? usageData[0] : usageData
  if (!entry || !entry.usage) return { quotaUnavailableReason: 'invalid_data' }

  const usage = entry.usage
  const extraWindows = usage.extraRateWindows || []
  const windows = []

  for (const w of neededWindows) {
    if (typeof w === 'function') {
      for (const extra of extraWindows) {
        if (w(extra)) {
          const isUnknown = extra.usageKnown === false
          windows.push({
            id: extra.id,
            label: extra.title || extra.id,
            usedPercent: isUnknown ? null : extra.window.usedPercent,
            usageKnown: !isUnknown,
            resetsAt: extra.window.resetsAt || null,
            windowMinutes: extra.window.windowMinutes || null
          })
        }
      }
    } else {
      const windowData = usage[w.key]
      if (windowData) {
        windows.push({
          id: `${provider}-${w.key}`,
          label: w.label,
          usedPercent: windowData.usedPercent,
          usageKnown: true,
          resetsAt: windowData.resetsAt || null,
          windowMinutes: windowData.windowMinutes || null
        })
      } else if (!w.optional) {
        // Missing required window - might be missing from API
      }
    }
  }

  let exhausted = false
  let exhaustedResetsAt = []

  for (const w of windows) {
    if (w.usageKnown && w.usedPercent >= 100) {
      exhausted = true
      if (w.resetsAt) {
        exhaustedResetsAt.push(new Date(w.resetsAt).getTime())
      }
    }
  }

  let nextResetAt = null
  if (exhausted && exhaustedResetsAt.length > 0) {
    nextResetAt = new Date(Math.min(...exhaustedResetsAt)).toISOString()
  }

  const result = {
    provider,
    windows,
    exhausted,
    nextResetAt,
    dataConfidence: entry.usage.dataConfidence || 'exact',
    fetchedAt: entry.usage.updatedAt || new Date().toISOString()
  }

  // Cached-mode fetchUsage() stamps these onto the CodexBar response itself;
  // carry them through so a caller can tell a fresh cache hit from a stale
  // one still being refreshed in the background.
  if (usageData.stale !== undefined) result.stale = usageData.stale
  if (usageData.cachedAt !== undefined) result.cachedAt = usageData.cachedAt

  return result
}