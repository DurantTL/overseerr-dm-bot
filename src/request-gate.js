'use strict';

function actorMetadata(actor) {
  return {
    actorKind: actor.kind,
    actorId: actor.id,
    actorLabel: actor.label,
    ...(actor.kind === 'discord' ? { actorDiscordId: actor.id } : {}),
  };
}

function createRequestGate(deps) {
  const {
    takePendingRequest,
    restashPendingRequest,
    quotaBlockReason,
    createSeerrRequestAs,
    verifySeerrRequestCreated,
    markApprovalNoticePosted,
    upsertRequest,
    canEscalate,
    recordEscalationWatch,
    tagPreAuthorizedMedia,
    bumpTrustScore,
    resetTrustScore,
    addRequestSubscriber,
    subscriberKeyFor,
    audit,
    notifyApproved,
    notifyAlreadyRequested,
    notifyDenied,
    closePendingRequestNotice,
    log,
  } = deps;

  async function closeNotice(pending) {
    await closePendingRequestNotice(pending).catch(err => log.warn(`Could not close approval notice for ${pending.label}: ${err.message}`));
  }

  async function approveGatedRequest({ nonce, actor, azPreAuth = false }) {
    const pending = takePendingRequest(nonce);
    if (!pending) return { ok: false, requestId: null, mediaKey: null, quotaWarning: null, verified: false, restashed: false, error: 'already_handled', pending: null };

    const actorMeta = actorMetadata(actor);
    const quotaWarning = await quotaBlockReason(pending.seerrUserId, pending.discordId, pending.mediaType, { tmdbId: pending.tmdbId, is4k: pending.is4k }).catch(() => null);
    try {
      const data = await createSeerrRequestAs(pending.seerrUserId, pending.mediaType, pending.tmdbId, pending.is4k);
      const requestId = data?.id ?? null;
      const mediaKey = pending.mediaType === 'tv' && data?.media?.tvdbId ? `tvdb:${data.media.tvdbId}` : `tmdb:${pending.tmdbId}`;
      if (requestId != null) markApprovalNoticePosted(requestId);
      const verification = requestId != null ? await verifySeerrRequestCreated(requestId, pending.mediaType) : { ok: true };
      if (!verification.ok) {
        restashPendingRequest(nonce, pending);
        const error = `request #${requestId} failed post-create verification: ${verification.reason}`;
        audit('external_api_error', { ...actorMeta, provider: 'overseerr', error, action: 'gate_approve_verify', targetDiscordId: pending.discordId });
        return { ok: false, requestId, mediaKey, quotaWarning, verified: false, restashed: true, error: verification.reason, pending };
      }

      upsertRequest(requestId, mediaKey, pending.mediaType, pending.is4k, pending.label, pending.discordId, 'approved');
      if (mediaKey !== `tmdb:${pending.tmdbId}`) upsertRequest(null, `tmdb:${pending.tmdbId}`, pending.mediaType, pending.is4k, pending.label, pending.discordId, 'approved');
      if (canEscalate(pending)) {
        recordEscalationWatch({ mediaType: pending.mediaType, tmdbId: pending.tmdbId, tvdbId: data?.media?.tvdbId ?? null, title: pending.label, discordId: pending.discordId, preAuthorized: azPreAuth });
        if (azPreAuth) {
          tagPreAuthorizedMedia({ mediaType: pending.mediaType, tmdbId: pending.tmdbId, tvdbId: data?.media?.tvdbId ?? null, title: pending.label })
            .catch(err => log.warn(`Approval-time AvistaZ tagging failed for ${pending.label}: ${err.message}`));
        }
      }
      bumpTrustScore(pending.discordId, 1);
      audit('request_approved_gate', { ...actorMeta, targetDiscordId: pending.discordId, title: pending.label, requestId, azPreAuth, overQuota: !!quotaWarning });
      await notifyApproved(pending);
      await closeNotice(pending);
      return { ok: true, requestId, mediaKey, quotaWarning, verified: true, restashed: false, error: null, pending, collision: false };
    } catch (err) {
      const status = err.response?.status;
      const seerrMessage = err.response?.data?.message;
      const error = seerrMessage || err.message;
      audit('external_api_error', { ...actorMeta, provider: 'overseerr', error, action: 'gate_approve', targetDiscordId: pending.discordId });
      if (status === 202 || status === 409 || /already (exists|available|requested)/i.test(seerrMessage || '')) {
        const mediaKey = `tmdb:${pending.tmdbId}`;
        upsertRequest(null, mediaKey, pending.mediaType, pending.is4k, pending.label, pending.discordId, 'approved');
        const subscribed = addRequestSubscriber(subscriberKeyFor(pending.tmdbId, pending.is4k), pending.discordId);
        audit('request_subscribed', { ...actorMeta, targetDiscordId: pending.discordId, title: pending.label, tmdbId: pending.tmdbId, is4k: pending.is4k, stage: 'gate_approve_collision' });
        await notifyAlreadyRequested(pending, subscribed);
        await closeNotice(pending);
        return { ok: true, requestId: null, mediaKey, quotaWarning, verified: null, restashed: false, error, pending, collision: true, subscribed };
      }
      restashPendingRequest(nonce, pending);
      return { ok: false, requestId: null, mediaKey: null, quotaWarning, verified: false, restashed: true, error, pending };
    }
  }

  async function denyGatedRequest({ nonce, actor }) {
    const pending = takePendingRequest(nonce);
    if (!pending) return { ok: false, error: 'already_handled', pending: null };
    upsertRequest(null, `tmdb:${pending.tmdbId}`, pending.mediaType, pending.is4k, pending.label, pending.discordId, 'declined');
    resetTrustScore(pending.discordId);
    audit('request_denied_gate', { ...actorMetadata(actor), targetDiscordId: pending.discordId, title: pending.label });
    await notifyDenied(pending);
    await closeNotice(pending);
    return { ok: true, error: null, pending };
  }

  return { approveGatedRequest, denyGatedRequest };
}

module.exports = { actorMetadata, createRequestGate };
