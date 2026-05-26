import { performanceData } from "../apiService.js";
import { log } from "./logger.js";

export function sumNetDeposits(transfers, upToDate = null, fromDate = null) {
  return transfers
    .filter(t => t.status === "COMPLETE")
    .filter(t => {
      const created = new Date(t.created_at);
      if (upToDate && created > upToDate) return false;
      if (fromDate && created < fromDate) return false;
      return true;
    })
    .reduce((sum, t) => {
      const amt = t.direction === "INCOMING" ? Math.abs(t.amount) : -Math.abs(t.amount);
      return sum + amt;
    }, 0);
}

export function findStatsPanel() {
  const panel = document.querySelector('[data-testid="portfolio-stats-panel"]');
  if (panel) {
    for (const section of panel.querySelectorAll('section')) {
      if (section.textContent.includes('Cumulative Return')) {
        log('Found portfolio stats panel');
        return section;
      }
    }
  }

  const allDivs = document.querySelectorAll('div');
  for (const div of allDivs) {
    if (div.textContent.includes('Portfolio Value') && div.querySelector('.grid')) {
      log('Found legacy metric banner by content search');
      return div.classList.contains('grid') ? div : div.querySelector('.grid');
    }
  }

  return null;
}

export function findMetricBanner() {
  return findStatsPanel();
}

export function createPanelStat(label, extraClass = '') {
  const wrapper = document.createElement('div');
  wrapper.className = `flex flex-col pb-2 border-b border-white/20 w-[155px] composer-returns-stat ${extraClass}`.trim();

  const labelSpan = document.createElement('span');
  labelSpan.className = 'text-xs leading-4 text-light-soft';
  labelSpan.textContent = label;

  const valueOuter = document.createElement('span');
  valueOuter.className = 'text-sm font-medium leading-5 text-light tabular-nums';
  const valueElement = document.createElement('span');
  valueOuter.appendChild(valueElement);

  wrapper.appendChild(labelSpan);
  wrapper.appendChild(valueOuter);

  return { wrapper, valueElement, valueOuter };
}

function attachHoverTooltip(wrapper, openTooltipFn) {
  let isOver = false;
  let tooltip = null;
  let closeTimeout = null;

  function closeTooltip() {
    if (!tooltip) return;
    tooltip.style.opacity = '0';
    setTimeout(() => {
      if (tooltip) {
        tooltip.remove();
        tooltip = null;
      }
    }, 150);
  }

  wrapper.addEventListener('mouseenter', () => {
    isOver = true;
    if (tooltip) tooltip.remove();
    tooltip = openTooltipFn(wrapper.getBoundingClientRect());
    if (tooltip) {
      tooltip.addEventListener('mouseenter', () => {
        isOver = true;
        clearTimeout(closeTimeout);
      });
      tooltip.addEventListener('mouseleave', closeTooltip);
    }
  });

  wrapper.addEventListener('mouseleave', () => {
    isOver = false;
    closeTimeout = setTimeout(() => {
      if (!isOver) closeTooltip();
    }, 150);
  });
}

function waitForStatsPanel(timeoutMs = 10000, pollMs = 100) {
  const start = Date.now();
  return new Promise((resolve) => {
    function check() {
      const panel = findStatsPanel();
      const hasCumulativeReturn = panel && panel.textContent.includes('Cumulative Return');
      if (panel && hasCumulativeReturn) return resolve(panel);

      if (Date.now() - start < timeoutMs) {
        setTimeout(check, pollMs);
      } else {
        resolve(null);
      }
    }
    check();
  });
}

let minRunningDaysForCagr = 0;

try {
  chrome.storage.local.get(['minActiveCagrDays'], (result) => {
    if (result.minActiveCagrDays !== undefined) {
      minRunningDaysForCagr = result.minActiveCagrDays;
    }
  });
} catch (e) { /* ignore if storage unavailable */ }

export function getMinCagrDays() {
  return minRunningDaysForCagr;
}

export function setMinCagrDays(days) {
  minRunningDaysForCagr = days;
  try {
    chrome.storage.local.set({ minActiveCagrDays: days });
  } catch (e) { /* ignore */ }
}

export function calculateActiveCagr(minDaysOverride) {
  const minDays = minDaysOverride !== undefined ? minDaysOverride : minRunningDaysForCagr;

  const symphonies = performanceData?.symphonyStats?.symphonies;
  if (!symphonies || symphonies.length === 0) {
    log('No symphony data available for Active CAGR calculation');
    return null;
  }

  const allValidSymphonies = symphonies.filter(s =>
    s.value > 0 &&
    s.addedStats &&
    s.addedStats["Running Days"] > 0
  );

  if (allValidSymphonies.length === 0) {
    log('No valid symphonies for Active CAGR calculation');
    return null;
  }

  const validSymphonies = minDays > 0
    ? allValidSymphonies.filter(s => s.addedStats["Running Days"] > minDays)
    : allValidSymphonies;

  const excludedCount = allValidSymphonies.length - validSymphonies.length;

  if (validSymphonies.length === 0) {
    log(`No symphonies meet minimum ${minDays} running days threshold`);
    return {
      activeCagr: null,
      simpleCagr: null,
      totalValue: allValidSymphonies.reduce((sum, s) => sum + s.value, 0),
      symphonyCount: 0,
      excludedCount,
      minDays,
      symphonyDetails: []
    };
  }

  const totalValue = validSymphonies.reduce((sum, s) => sum + s.value, 0);

  const symphonyDetails = validSymphonies.map(symphony => {
    const runningDays = symphony.addedStats["Running Days"];
    const yearsRunning = runningDays / 365.25;

    let symphonyCagr = 0;
    const cagrString = symphony.addedStats["CAGR% (Annual Return)"];
    if (cagrString) {
      const parsed = parseFloat(cagrString.replace('%', ''));
      if (!isNaN(parsed)) {
        symphonyCagr = parsed / 100;
      }
    }

    const weight = symphony.value / totalValue;

    return {
      id: symphony.id,
      name: symphony.name,
      currentValue: symphony.value,
      weight,
      runningDays,
      yearsRunning,
      cagr: symphonyCagr,
      weightedCagr: symphonyCagr * weight
    };
  });

  const activeCagr = symphonyDetails.reduce((sum, s) => sum + s.weightedCagr, 0);

  const validCagrs = symphonyDetails.filter(s => isFinite(s.cagr) && !isNaN(s.cagr));
  const simpleCagr = validCagrs.length > 0
    ? validCagrs.reduce((sum, s) => sum + s.cagr, 0) / validCagrs.length
    : 0;

  log('');
  log('[Active CAGR Calculation]');
  log(`  Total Portfolio Value: $${totalValue.toFixed(2)}`);
  log(`  Symphonies: ${validSymphonies.length}`);
  symphonyDetails.forEach(s => {
    log(`    ${s.name}: CAGR=${(s.cagr * 100).toFixed(2)}%, Weight=${(s.weight * 100).toFixed(1)}%, Contribution=${(s.weightedCagr * 100).toFixed(2)}%`);
  });
  log(`  Weighted Active CAGR: ${(activeCagr * 100).toFixed(2)}%`);
  log(`  Simple Average CAGR: ${(simpleCagr * 100).toFixed(2)}%`);

  return {
    activeCagr,
    simpleCagr,
    totalValue,
    symphonyCount: validSymphonies.length,
    excludedCount,
    minDays,
    symphonyDetails
  };
}

function createActiveCagrTooltip(stats, anchorRect) {
  const existing = document.getElementById('composer-active-cagr-tooltip');
  if (existing) existing.remove();

  const tooltip = document.createElement('div');
  tooltip.id = 'composer-active-cagr-tooltip';
  tooltip.style.position = 'fixed';
  tooltip.style.maxWidth = '400px';
  tooltip.style.background = 'rgba(30,32,40,0.98)';
  tooltip.style.color = '#fff';
  tooltip.style.padding = '14px 18px';
  tooltip.style.borderRadius = '8px';
  tooltip.style.boxShadow = '0 2px 12px rgba(0,0,0,0.18)';
  tooltip.style.zIndex = 9999;
  tooltip.style.fontSize = '14px';
  tooltip.style.transition = 'opacity 0.15s';
  tooltip.style.opacity = '0';
  tooltip.style.maxHeight = '80vh';
  tooltip.style.overflowY = 'auto';

  const symphonyRows = stats.symphonyDetails
    .sort((a, b) => b.weight - a.weight)
    .map(s => `
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">
        <td style="padding: 4px 8px 4px 0; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${s.name}">${s.name}</td>
        <td style="padding: 4px 8px; text-align: right;">${(s.weight * 100).toFixed(1)}%</td>
        <td style="padding: 4px 8px; text-align: right; color: ${s.cagr >= 0 ? '#4ade80' : '#f87171'};">${(s.cagr * 100).toFixed(1)}%</td>
        <td style="padding: 4px 0 4px 8px; text-align: right; color: ${s.weightedCagr >= 0 ? '#4ade80' : '#f87171'};">${(s.weightedCagr * 100).toFixed(2)}%</td>
      </tr>
    `).join('');

  const activeCagrFormatted = (stats.activeCagr * 100).toFixed(2);
  const simpleCagrFormatted = (stats.simpleCagr * 100).toFixed(2);

  tooltip.innerHTML = `
    <div style="font-weight:bold; font-size: 16px;">Active CAGR</div>
    <div style="padding-bottom:8px; margin-bottom:8px; font-size: 11px; opacity:0.6;">
      Weighted average CAGR of current symphony allocations
    </div>
    <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin-bottom: 12px;">
      <div style="opacity: 0.85;">Active CAGR:</div>
      <div style="font-weight: bold; color: ${stats.activeCagr >= 0 ? '#4ade80' : '#f87171'};">${activeCagrFormatted}%</div>
      <div style="opacity: 0.85;">Simple Avg CAGR:</div>
      <div style="font-weight: bold; opacity: 0.7;">${simpleCagrFormatted}%</div>
      <div style="opacity: 0.85;">Symphonies:</div>
      <div style="font-weight: bold;">${stats.symphonyCount}${stats.excludedCount > 0 ? ` <span style="opacity: 0.6; font-weight: normal;">(${stats.excludedCount} excluded)</span>` : ''}</div>
      <div style="opacity: 0.85;">Total Value:</div>
      <div style="font-weight: bold;">$${stats.totalValue.toFixed(2)}</div>
    </div>
    <div style="font-size: 12px; font-weight: bold; margin-bottom: 8px; border-top: 1px solid rgba(255,255,255,0.2); padding-top: 8px;">Per-Symphony Breakdown</div>
    <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
      <thead>
        <tr style="opacity: 0.7; border-bottom: 1px solid rgba(255,255,255,0.2);">
          <th style="padding: 4px 8px 4px 0; text-align: left;">Symphony</th>
          <th style="padding: 4px 8px; text-align: right;">Weight</th>
          <th style="padding: 4px 8px; text-align: right;">CAGR</th>
          <th style="padding: 4px 0 4px 8px; text-align: right;">Contrib.</th>
        </tr>
      </thead>
      <tbody>
        ${symphonyRows}
      </tbody>
    </table>
    <div style="margin-top:14px; font-size:11px; color:#b0b8c9; line-height:1.5; opacity:0.6;">
      <b>Active CAGR</b> = Σ(Symphony CAGR × Weight)<br>
      Shows the "forward-looking power" of your current allocation based on each symphony's historical performance.
    </div>
    <div style="margin-top:10px; padding: 8px; background: rgba(255,255,255,0.06); border-radius: 4px; font-size: 11px; display: flex; align-items: center; gap: 8px;">
      <label style="color: #b0b8c9; white-space: nowrap;">Min trading days:</label>
      <input id="composer-min-cagr-days-input" type="number" min="0" step="1" value="${stats.minDays}"
        style="width: 60px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: #fff; padding: 3px 6px; font-size: 12px; text-align: center; outline: none;"
      />
      <span style="color: #b0b8c9; opacity: 0.7; font-size: 10px;">(0 = all)</span>
    </div>
    ${stats.excludedCount > 0 ? `
    <div style="margin-top:6px; padding: 6px 8px; background: rgba(251, 191, 36, 0.15); border-left: 3px solid #fbbf24; border-radius: 4px; font-size: 11px; color: #fbbf24;">
      ${stats.excludedCount} symphony${stats.excludedCount > 1 ? 'ies' : ''} excluded (≤${stats.minDays} trading days).
    </div>` : ''}
  `;
  document.body.appendChild(tooltip);

  let isOverTooltip = false;
  tooltip.addEventListener('mouseenter', () => {
    isOverTooltip = true;
    tooltip.style.opacity = '1';
  });
  tooltip.addEventListener('mouseleave', () => {
    isOverTooltip = false;
    tooltip.style.opacity = '0';
    setTimeout(() => {
      if (!isOverTooltip) tooltip.remove();
    }, 150);
  });

  const minDaysInput = tooltip.querySelector('#composer-min-cagr-days-input');
  if (minDaysInput) {
    minDaysInput.addEventListener('focus', () => { isOverTooltip = true; });
    minDaysInput.addEventListener('click', (e) => { e.stopPropagation(); });

    let debounceTimer = null;
    minDaysInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const newMin = Math.max(0, parseInt(minDaysInput.value, 10) || 0);
        setMinCagrDays(newMin);
        const newStats = calculateActiveCagr(newMin);
        if (newStats) {
          injectActiveCagrWithTooltip(newStats);
        }
      }, 600);
    });

    minDaysInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(debounceTimer);
        const newMin = Math.max(0, parseInt(minDaysInput.value, 10) || 0);
        setMinCagrDays(newMin);
        const newStats = calculateActiveCagr(newMin);
        if (newStats) {
          injectActiveCagrWithTooltip(newStats);
        }
      }
    });
  }

  if (anchorRect) {
    tooltip.style.left = `${anchorRect.right + 12}px`;
    tooltip.style.top = `${anchorRect.top - 8}px`;

    setTimeout(() => {
      let tooltipRect = tooltip.getBoundingClientRect();
      if (tooltipRect.right > window.innerWidth - 10) {
        tooltip.style.left = `${anchorRect.left - tooltipRect.width - 12}px`;
        tooltipRect = tooltip.getBoundingClientRect();
      }
      if (tooltipRect.left < 10) {
        tooltip.style.left = `10px`;
      }
      if (tooltipRect.bottom > window.innerHeight - 10) {
        tooltip.style.top = `${Math.max(10, window.innerHeight - tooltipRect.height - 10)}px`;
      }
    }, 0);
  }

  setTimeout(() => { tooltip.style.opacity = '1'; }, 0);

  return tooltip;
}

export function injectActiveCagrLoadingPlaceholder() {
  const panel = findStatsPanel();
  if (panel) {
    if (panel.querySelector('.composer-active-cagr-stat')) return;

    const { wrapper, valueElement } = createPanelStat('Active CAGR', 'composer-active-cagr-stat');
    valueElement.textContent = 'Loading...';
    valueElement.parentElement.style.opacity = '0.5';

    panel.appendChild(wrapper);
    return;
  }

  // If the panel hasn't rendered yet, retry briefly.
  waitForStatsPanel().then((p) => {
    if (!p) return;
    if (p.querySelector('.composer-active-cagr-stat')) return;
    const { wrapper, valueElement } = createPanelStat('Active CAGR', 'composer-active-cagr-stat');
    valueElement.textContent = 'Loading...';
    valueElement.parentElement.style.opacity = '0.5';
    p.appendChild(wrapper);
  });
}

export function injectActiveCagrWithTooltip(stats) {
  if (stats === null) return;

  const hasValidCagr = stats.activeCagr !== null && stats.activeCagr !== undefined;

  const panel = findStatsPanel();

  const doInject = (targetPanel) => {
    if (!targetPanel) return;

    targetPanel.querySelectorAll('.composer-active-cagr-stat').forEach(el => el.remove());

    const { wrapper, valueElement, valueOuter } = createPanelStat('Active CAGR', 'composer-active-cagr-stat');
    wrapper.style.cursor = 'pointer';

    if (hasValidCagr) {
      const cagrValue = stats.activeCagr * 100;
      valueElement.textContent = `${cagrValue.toFixed(2)}%`;
      valueOuter.style.color = cagrValue >= 0 ? '#4ade80' : '#f87171';
    } else {
      valueElement.textContent = 'N/A';
      valueOuter.style.opacity = '0.5';
      wrapper.title = `No symphonies with >${stats.minDays} trading days`;
    }

    attachHoverTooltip(wrapper, (anchorRect) => {
      if (!hasValidCagr) {
        const tooltip = document.createElement('div');
        tooltip.id = 'composer-active-cagr-tooltip';
        tooltip.style.cssText = 'position:fixed;background:rgba(30,32,40,0.98);color:#fff;padding:14px 18px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,0.18);z-index:9999;font-size:14px;';
        tooltip.innerHTML = `
          <div style="font-weight:bold; font-size: 16px;">Active CAGR</div>
          <div style="margin-top:8px;">No symphonies have been running for more than ${stats.minDays} trading days yet.</div>
          <div style="margin-top:8px; opacity:0.7;">${stats.excludedCount} symphonies excluded due to insufficient data.</div>
        `;
        document.body.appendChild(tooltip);
        tooltip.style.left = `${anchorRect.right + 12}px`;
        tooltip.style.top = `${anchorRect.top - 8}px`;

        // Keep the "no data" tooltip within viewport.
        setTimeout(() => {
          let tooltipRect = tooltip.getBoundingClientRect();
          if (tooltipRect.right > window.innerWidth - 10) {
            tooltip.style.left = `${anchorRect.left - tooltipRect.width - 12}px`;
            tooltipRect = tooltip.getBoundingClientRect();
          }
          if (tooltipRect.left < 10) tooltip.style.left = '10px';
          if (tooltipRect.bottom > window.innerHeight - 10) {
            tooltip.style.top = `${Math.max(10, window.innerHeight - tooltipRect.height - 10)}px`;
          }
        }, 0);

        return tooltip;
      }

      return createActiveCagrTooltip(stats, anchorRect);
    });

    targetPanel.appendChild(wrapper);
  };

  if (panel) {
    doInject(panel);
    return;
  }

  // If the panel hasn't rendered yet, retry briefly.
  waitForStatsPanel().then((p) => {
    if (!p) return;
    doInject(p);
  });
}
