// ChatGPT Custom GPT Action integration. The /exec endpoint is now reached
// only through the Cloudflare Worker (integrations/chatgpt-proxy). The
// Worker injects an INTERNAL_PROXY_SECRET header and actor metadata after
// validating the user's OAuth session. Apps Script trusts the upstream proxy
// and the actor headers; it never reads email fields from the request body.
//
// Legacy direct API key auth has been removed — the previous
// `apiKey`-in-body mode is no longer accepted and a request without
// INTERNAL_PROXY_SECRET returns 403.

const CHATGPT_ACTIONS = ["gptSearchSongs", "gptCheckDuplicate", "gptAddSong"];
const CHATGPT_PERFORMER_IDS = ["marie", "yeowool", "seongwook"];

function gptReadHeader(e, name) {
  if (!e || !e.headers) return "";
  const wanted = String(name || "").toLowerCase();
  for (const key in e.headers) {
    if (String(key).toLowerCase() === wanted) return String(e.headers[key] || "");
  }
  return "";
}

function gptAuthenticateInternal(e, body) {
  const proxy = (body && body.__proxy) || {};
  const provided = gptReadHeader(e, "X-Internal-Proxy-Secret") || String(proxy.secret || "");
  const expected = String(scriptProps().getProperty("INTERNAL_PROXY_SECRET") || "");
  if (!expected) throw publicError("FORBIDDEN", "INTERNAL_PROXY_SECRET이 설정되지 않았어.");
  if (!provided || provided !== expected) {
    throw publicError("FORBIDDEN", "허용되지 않은 출처야.");
  }
  const actorId = gptReadHeader(e, "X-ChatGpt-Actor-Id") || String(proxy.actorId || "");
  const actorEmail = (gptReadHeader(e, "X-ChatGpt-Actor-Email") || String(proxy.actorEmail || "")).toLowerCase();
  const actorName = gptReadHeader(e, "X-ChatGpt-Actor-Name") || String(proxy.actorName || "");
  const actorRole = gptReadHeader(e, "X-ChatGpt-Actor-Role") || String(proxy.actorRole || "");
  const source = gptReadHeader(e, "X-ChatGpt-Source") || String(proxy.source || "");
  if (!actorId || !actorEmail) throw publicError("FORBIDDEN", "actor 정보가 누락됐어.");
  if (actorRole !== "member") throw publicError("FORBIDDEN", "actor role이 올바르지 않아.");
  if (["chatgpt-action", "browser-session"].indexOf(source) === -1) throw publicError("FORBIDDEN", "actor source가 올바르지 않아.");
  const allow = JSON.parse(scriptProps().getProperty(source === "browser-session" ? "ALLOWED_USERS_JSON" : "CHATGPT_ALLOWED_USERS_JSON") || "{}");
  const expectedEntry = allow[actorEmail];
  if (!expectedEntry) throw publicError("FORBIDDEN", "이 Songbook에 등록할 권한이 없어.");
  return {
    actor: {
      id: actorId,
      email: actorEmail,
      displayName: expectedEntry.displayName || actorName || actorEmail,
      role: source === "browser-session" ? (expectedEntry.role || "editor") : "integration"
    }
  };
}

// Browser write actions use the Better Auth session attested by the Worker.
// They share the existing Apps Script validators and permission matrix, while
// the legacy GIS idToken path remains available for rollback.
function requireRequestUser(body, e) {
  if (body && body.__proxy && String(body.__proxy.source || "") === "browser-session") {
    return gptAuthenticateInternal(e, body).actor;
  }
  return requireUser(body && body.idToken);
}

function gptSearchSongs(body, e) {
  const auth = gptAuthenticateInternal(e, body);
  const query = String((body && body.query) || "").trim().toLowerCase();
  if (!query) return { query: "", total: 0, songs: [] };
  const songs = readTable("Songs");
  const matches = songs.rows
    .filter((entry) => PUBLIC_STATUSES.indexOf(String(entry.values.status)) !== -1)
    .map((entry) => serializeSong(entry.values, performanceStats()))
    .filter((song) => songMatchesQuery(song, query));
  return { query, total: matches.length, songs: matches.slice(0, 25), actor: auth.actor.email };
}

function songMatchesQuery(song, query) {
  const haystack = [
    song.title,
    song.titleReadingKo,
    song.titleRomanized,
    (song.titleAliases || []).join(" "),
    song.artist,
    song.artistReadingKo,
    (song.artistAliases || []).join(" "),
    song.tjNumber,
    (song.performerIds || []).join(" ")
  ].join(" ").toLowerCase();
  return haystack.indexOf(query) !== -1;
}

function gptCheckDuplicate(body, e) {
  gptAuthenticateInternal(e, body);
  const tjNumber = normalizeTjNumber(body && body.tjNumber);
  const title = String((body && body.title) || "").trim();
  const artist = String((body && body.artist) || "").trim();
  if (!tjNumber && (!title || !artist)) {
    throw publicError("BAD_REQUEST", "tjNumber 또는 title+artist가 필요해.");
  }
  const songs = readTable("Songs").rows;
  if (tjNumber) {
    const hit = songs.find((entry) => String(entry.values.tjNumber || "") === tjNumber && String(entry.values.status) !== "deleted");
    if (hit) return { duplicate: true, matchedBy: "tjNumber", song: serializeSong(hit.values, performanceStats()) };
  }
  if (title && artist) {
    const targetKey = title.toLowerCase() + "|" + artist.toLowerCase();
    const hit = songs.find((entry) => {
      const t = String(entry.values.title || "").toLowerCase();
      const a = String(entry.values.artist || "").toLowerCase();
      return t + "|" + a === targetKey && String(entry.values.status) !== "deleted";
    });
    if (hit) return { duplicate: true, matchedBy: "titleArtist", song: serializeSong(hit.values, performanceStats()) };
  }
  return { duplicate: false, matchedBy: null, song: null };
}

function gptAddSong(body, requestId, e) {
  const reqId = requestId || newRequestId();
  logStep(reqId, "gptAddSong", "body parsed", { hasTitle: Boolean(body && body.title), hasArtist: Boolean(body && body.artist), confirmed: Boolean(body && body.confirmed) });
  const auth = gptAuthenticateInternal(e, body);
  logStep(reqId, "gptAddSong", "auth success", { actorEmail: auth.actor.email, actorRole: auth.actor.role });
  if (body.confirmed !== true) {
    throw publicError("CONFIRMATION_REQUIRED", "사용자 확인 없이 곡을 등록할 수 없어. confirmed: true 가 필요해.");
  }
  const clientRequestId = String((body && body.clientRequestId) || "").trim();
  if (!clientRequestId) throw publicError("BAD_REQUEST", "clientRequestId가 필요해.");
  if (!body.title || !body.artist) throw publicError("VALIDATION_ERROR", "곡명과 아티스트는 필수야.");
  const performerIds = strictPerformerIds(body && body.performerIds);
  logStep(reqId, "gptAddSong", "validation done", { title: String(body.title).slice(0, 40), artist: String(body.artist).slice(0, 40), performerCount: performerIds.length });
  return withScriptLock(() => {
    logStep(reqId, "gptAddSong", "duplicate check start", { clientRequestId });
    const prior = findChangeByClientRequestId(clientRequestId);
    if (prior) {
      logStep(reqId, "gptAddSong", "duplicate hit", { entityId: prior.entityId });
      const songs = readTable("Songs").rows;
      const hit = songs.find((row) => row.values.id === prior.entityId);
      if (hit) {
        return {
          duplicate: true,
          matchedBy: "clientRequestId",
          song: serializeSong(hit.values, performanceStats())
        };
      }
      return { duplicate: true, matchedBy: "clientRequestId", song: prior.afterJson ? JSON.parse(prior.afterJson) : null };
    }
    const incoming = normalizeSongInput({
      title: body.title,
      artist: body.artist,
      tjNumber: body.tjNumber,
      titleReadingKo: body.titleReadingKo,
      titleRomanized: body.titleRomanized,
      titleAliases: body.titleAliases,
      artistReadingKo: body.artistReadingKo,
      artistAliases: body.artistAliases,
      country: body.country,
      originalWork: body.originalWork,
      performerIds: performerIds,
      keyCandidates: body.keyCandidates,
      memo: body.memo,
      youtubeUrl: body.youtubeUrl,
      sourceType: "chatgpt",
      sourceReference: "chatgpt-action"
    });
    const table = readTable("Songs");
    if (incoming.tjNumber) {
      const hit = table.rows.find((entry) => String(entry.values.tjNumber) === incoming.tjNumber && String(entry.values.status) !== "deleted");
      if (hit) {
        logStep(reqId, "gptAddSong", "tj duplicate", { tjNumber: incoming.tjNumber });
        return { duplicate: true, matchedBy: "tjNumber", song: serializeSong(hit.values, performanceStats()) };
      }
    }
    const targetKey = String(incoming.title).toLowerCase() + "|" + String(incoming.artist).toLowerCase();
    const titleHit = table.rows.find((entry) => {
      const t = String(entry.values.title || "").toLowerCase();
      const a = String(entry.values.artist || "").toLowerCase();
      return t + "|" + a === targetKey && String(entry.values.status) !== "deleted";
    });
    if (titleHit) {
      logStep(reqId, "gptAddSong", "title artist duplicate");
      return { duplicate: true, matchedBy: "titleArtist", song: serializeSong(titleHit.values, performanceStats()) };
    }
    const now = new Date().toISOString();
    const row = Object.assign({}, incoming, {
      id: Utilities.getUuid(),
      createdByEmail: auth.actor.email,
      createdByName: auth.actor.displayName,
      createdAt: now,
      updatedByEmail: auth.actor.email,
      updatedByName: auth.actor.displayName,
      updatedAt: now,
      deletedAt: "",
      deletedByEmail: "",
      version: 1
    });
    logStep(reqId, "gptAddSong", "song write", { rowId: row.id });
    appendRows("Songs", [row]);
    logStep(reqId, "gptAddSong", "changelog write", { entityId: row.id, actorEmail: auth.actor.email });
    appendChatGptChange("Song", row.id, "create", null, row, auth.actor, clientRequestId, 0, 1);
    return {
      duplicate: false,
      matchedBy: null,
      song: serializeSong(row, performanceStats())
    };
  });
}

function strictPerformerIds(value) {
  if (value === null || value === undefined) return [];
  const values = Array.isArray(value) ? value : splitPerformerText(String(value));
  if (!values.length) return [];
  const ids = [];
  values.forEach((token) => {
    const normalized = normalizePerformerToken(token);
    if (!normalized) return;
    const mapped = PERFORMER_ALIASES[normalized];
    if (mapped) {
      addPerformerIds(ids, mapped);
      return;
    }
    if (PERFORMER_IDS.indexOf(normalized) === -1) {
      throw publicError("VALIDATION_ERROR", "허용되지 않은 부를 사람 ID야: " + normalized);
    }
    if (ids.indexOf(normalized) === -1) ids.push(normalized);
  });
  return ids;
}

function appendChatGptChange(entityType, entityId, action, before, after, actor, clientRequestId, versionBefore, versionAfter) {
  appendRows("ChangeLog", [
    {
      id: Utilities.getUuid(),
      entityType,
      entityId,
      action,
      beforeJson: before ? JSON.stringify(before) : "",
      afterJson: after ? JSON.stringify(after) : "",
      actorEmail: actor.email,
      actorName: actor.displayName,
      actorRole: actor.role,
      createdAt: new Date().toISOString(),
      clientRequestId,
      entityVersionBefore: versionBefore,
      entityVersionAfter: versionAfter
    }
  ]);
}

function isGptAction(action) {
  return CHATGPT_ACTIONS.indexOf(action) !== -1;
}
