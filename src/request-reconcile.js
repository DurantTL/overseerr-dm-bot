'use strict';

const { healthErrorDetail } = require('./health');

const TRANSIENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

function isTransientNetworkError(error) {
  return TRANSIENT_NETWORK_CODES.has(error?.code) || Number(error?.response?.status) >= 500;
}

async function fetchRequestInventoryWithRetry(fetchRequests, {
  attempts = 3,
  delayMs = 2000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchRequests();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientNetworkError(error)) break;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function requestReconcileStage(label, operation) {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${label}: ${healthErrorDetail(error)}`, { cause: error });
  }
}

module.exports = { TRANSIENT_NETWORK_CODES, isTransientNetworkError, fetchRequestInventoryWithRetry, requestReconcileStage };
