#!/usr/bin/env node
/**
 * 24 小时免费云端京东物流巡检与微信 ClawBot 双向联动脚本（零第三方依赖，Node 20+ 原生运行）
 * 环境变量：
 *   GIST_ID    - 存储加密状态的私有 GitHub Gist ID
 *   GIST_TOKEN - 访问该 Gist 的 GitHub Token
 *   STATE_KEY  - 32 字节 AES-256-GCM 密钥（Base64 编码）
 */
import crypto from "node:crypto";

const GIST_FILE_NAME = "jd_tracker_state.enc.json";
const ILINK_DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
const ILINK_CLIENT_VERSION = "132106";
const ILINK_CHANNEL_VERSION = "2.4.10";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

// ---------------------------------------------------------------------------
// AES-256-GCM（与 iOS 端 CryptoKit AES.GCM.SealedBox 100% 互通）
// ---------------------------------------------------------------------------

function decryptState(envelopeStr, keyBase64) {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("STATE_KEY 长度必须为 32 字节");
  const env = JSON.parse(envelopeStr);
  const iv = Buffer.from(env.iv, "base64");
  const ct = Buffer.from(env.ct, "base64");
  const tag = Buffer.from(env.tag, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function encryptState(stateObj, keyBase64) {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("STATE_KEY 长度必须为 32 字节");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify(stateObj), "utf8");
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
    updatedAtMs: stateObj.updatedAtMs || Date.now(),
  });
}

// ---------------------------------------------------------------------------
// GitHub Gist 状态读写
// ---------------------------------------------------------------------------

async function loadCloudState(gistId, token, keyBase64) {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`读取 Gist 失败: HTTP ${res.status}`);
  }
  const gist = await res.json();
  const content = gist.files?.[GIST_FILE_NAME]?.content;
  if (!content || !content.includes('"ct"')) {
    return {
      version: 1,
      updatedAtMs: Date.now(),
      shipments: [],
      deletedShipmentIds: [],
      clawBot: {
        botId: "",
        botToken: "",
        baseUrl: ILINK_DEFAULT_BASE,
        ilinkUserId: "",
        contextToken: "",
        getUpdatesBuf: "",
      },
      settings: {
        quietHoursEnabled: true,
        pushOnInitialAdd: true,
        autoImportFromWeChat: true,
        uapisApiKey: "",
      },
    };
  }
  return decryptState(content, keyBase64);
}

async function saveCloudState(stateObj, gistId, token, keyBase64) {
  stateObj.updatedAtMs = Date.now();
  const encrypted = encryptState(stateObj, keyBase64);
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      files: {
        [GIST_FILE_NAME]: { content: encrypted },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`保存 Gist 失败: HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// 京东官方分享链接直查（无额度限制） + 单号备用接口
// ---------------------------------------------------------------------------

function extractJDShareURL(text) {
  const m1 = text.match(/https?:\/\/3\.cn\/[A-Za-z0-9_-]+/i);
  if (m1) return m1[0];
  const m2 = text.match(/https?:\/\/v\.m\.jd\.com\/landpage\/orderShare\.action\?[^\s"<>'，。！）)]+/i);
  return m2 ? m2[0] : "";
}

function extractShareDataFromURL(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.searchParams.get("shareData") || "";
  } catch {
    return "";
  }
}

function extractWaybillCandidate(text) {
  let cleaned = text.replace(/https?:\/\/\S+/gi, " ").toUpperCase();
  const patterns = [
    /JD[A-Z]{0,3}\d{9,18}/,
    /SF\d{11,15}/,
    /YT\d{11,15}/,
    /JT\d{11,15}/,
    /(?<!\d)\d{12,18}(?!\d)/,
  ];
  for (const p of patterns) {
    const m = cleaned.match(p);
    if (m) return m[0];
  }
  return "";
}

async function resolveJDShareData(shareUrl) {
  const direct = extractShareDataFromURL(shareUrl);
  if (direct) return direct;
  const res = await fetch(shareUrl, {
    redirect: "follow",
    headers: { "User-Agent": MOBILE_UA },
  });
  const shareData = extractShareDataFromURL(res.url);
  if (!shareData) throw new Error("未能从 3.cn 链接解析出京东官方 shareData");
  return shareData;
}

async function queryJDOfficial(shipment) {
  const shareData = shipment.jdShareData || (await resolveJDShareData(shipment.jdShareUrl));
  const bodyParam = JSON.stringify({ shareData });
  const url = `https://nmyorderH5.m.jd.com/orderTrackBusinessShare?body=${encodeURIComponent(bodyParam)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://v.m.jd.com",
      Referer: "https://v.m.jd.com/",
      "User-Agent": MOBILE_UA,
    },
    body: "",
  });
  if (!res.ok) throw new Error(`京东官方接口 HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== "0") {
    throw new Error(`京东官方接口返回 code=${data.code}`);
  }

  let waybill = "";
  let carrier = "京东快递";
  let eta = "";
  for (const tag of data.orderInfoMap?.extTagList || []) {
    const name = tag.name || "";
    const val = (tag.value || "").trim();
    if (!val) continue;
    if (name.includes("运单号")) waybill = val.toUpperCase();
    else if (name.includes("承运")) carrier = val;
    else if (name.includes("送达")) eta = val;
  }

  const rawList = data.orderMessageList || [];
  const tracks = rawList
    .map((it) => ({
      time: (it.crateTime || it.createTime || "").trim(),
      context: (it.message || "").trim(),
    }))
    .filter((it) => it.time || it.context);

  if (tracks.length === 0) throw new Error("暂无物流轨迹");

  const firstNodeState =
    rawList.map((it) => (it.trackNodeState || "").trim()).find((s) => s.length > 0) || "";
  const latestMsg = rawList[0]?.message || "";
  const isDelivered =
    rawList[0]?.stateIcon === "order_132" ||
    firstNodeState.includes("签收") ||
    firstNodeState === "已完成" ||
    latestMsg.includes("已签收") ||
    latestMsg.includes("妥投") ||
    latestMsg.includes("本人签收") ||
    latestMsg.includes("已取件");

  const statusText = isDelivered
    ? "已签收"
    : firstNodeState || (latestMsg.includes("派送") ? "派送中" : "运输中");

  return {
    resolvedTrackingNumber: waybill || null,
    resolvedShareData: shareData,
    estimatedDelivery: eta || null,
    carrierName: carrier,
    statusText,
    statusCode: isDelivered ? "delivered" : "in_transit",
    isCompleted: isDelivered,
    tracks,
  };
}

async function queryPlainNumber(shipment, apiKey) {
  const params = new URLSearchParams({ tracking_number: shipment.trackingNumber });
  if (shipment.phoneLast4 && shipment.phoneLast4.length === 4) {
    params.set("phone", shipment.phoneLast4);
  }
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`https://uapis.cn/api/v1/misc/tracking/query?${params}`, { headers });
  if (!res.ok) throw new Error(`单号查询接口 HTTP ${res.status}`);
  const raw = await res.json();
  const tracks = (raw.tracks || [])
    .map((t) => ({ time: (t.time || "").trim(), context: (t.context || "").trim() }))
    .filter((t) => t.time || t.context);
  if (tracks.length === 0) throw new Error(raw.message || "暂未查询到物流轨迹");

  const statusText = raw.status || "运输中";
  const isCompleted =
    Boolean(raw.is_completed) ||
    String(raw.status_code || "").toLowerCase() === "delivered" ||
    statusText.includes("签收");

  return {
    resolvedTrackingNumber: shipment.trackingNumber,
    resolvedShareData: null,
    estimatedDelivery: null,
    carrierName: raw.carrier_name || "京东物流",
    statusText,
    statusCode: raw.status_code || "in_transit",
    isCompleted,
    tracks,
  };
}

async function queryShipment(shipment, apiKey) {
  if (shipment.jdShareData || shipment.jdShareUrl) {
    return queryJDOfficial(shipment);
  }
  return queryPlainNumber(shipment, apiKey);
}

// ---------------------------------------------------------------------------
// 微信 ClawBot (iLink Bot 协议) 收发消息
// ---------------------------------------------------------------------------

function ilinkHeaders(botToken) {
  const uin = crypto.randomBytes(4).readUInt32BE(0);
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(uin), "utf8").toString("base64"),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_CLIENT_VERSION,
  };
  if (botToken) headers.Authorization = `Bearer ${botToken}`;
  return headers;
}

function parseLosslessWeixinJson(rawText) {
  const safe = rawText.replace(/"(message_id|msg_id|svr_id)"\s*:\s*(-?\d+)/g, '"$1":"$2"');
  return JSON.parse(safe);
}

async function syncClawBotUpdates(clawBot) {
  if (!clawBot.botId || !clawBot.botToken) return { inboundTexts: [], newlyActivated: false };
  const base = (clawBot.baseUrl || ILINK_DEFAULT_BASE).replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  const wasReady = Boolean(clawBot.ilinkUserId && clawBot.contextToken);
  try {
    const res = await fetch(`${base}/ilink/bot/getupdates`, {
      method: "POST",
      headers: ilinkHeaders(clawBot.botToken),
      body: JSON.stringify({
        get_updates_buf: clawBot.getUpdatesBuf || "",
        base_info: { channel_version: ILINK_CHANNEL_VERSION, bot_agent: "OpenClaw" },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { inboundTexts: [], newlyActivated: false };

    const rawText = await res.text();
    const data = parseLosslessWeixinJson(rawText);
    if ((data.ret && data.ret !== 0) || (data.errcode && data.errcode !== 0)) {
      console.warn("getupdates returned non-zero:", data.ret, data.errcode, data.errmsg);
      return { inboundTexts: [], newlyActivated: false };
    }

    if (data.get_updates_buf) {
      clawBot.getUpdatesBuf = data.get_updates_buf;
    }

    const inboundTexts = [];
    for (const msg of data.msgs || []) {
      if (msg.from_user_id) clawBot.ilinkUserId = msg.from_user_id;
      if (msg.context_token) clawBot.contextToken = msg.context_token;
      if (msg.message_type === 2) continue;
      for (const item of msg.item_list || []) {
        if (item.type === 1 && item.text_item?.text?.trim()) {
          inboundTexts.push(item.text_item.text.trim());
        }
      }
    }
    const nowReady = Boolean(clawBot.ilinkUserId && clawBot.contextToken);
    return { inboundTexts, newlyActivated: !wasReady && nowReady };
  } catch (err) {
    clearTimeout(timer);
    if (err.name !== "AbortError") {
      console.warn("syncClawBotUpdates warning:", err.message);
    }
    return { inboundTexts: [], newlyActivated: false };
  }
}

async function sendWeChatMessage(clawBot, text) {
  if (!clawBot.botToken || !clawBot.ilinkUserId || !clawBot.contextToken) {
    console.log("微信 ClawBot 尚未绑定或未激活 contextToken，跳过微信推送");
    return false;
  }
  const base = (clawBot.baseUrl || ILINK_DEFAULT_BASE).replace(/\/+$/, "");
  const clientId = `openclaw-weixin:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const res = await fetch(`${base}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: ilinkHeaders(clawBot.botToken),
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: clawBot.ilinkUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: clawBot.contextToken,
      },
      base_info: { channel_version: ILINK_CHANNEL_VERSION, bot_agent: "OpenClaw" },
    }),
  });
  if (!res.ok) {
    console.error("sendWeChatMessage HTTP error:", res.status);
    return false;
  }
  const data = parseLosslessWeixinJson(await res.text());
  if (data.ret && data.ret !== 0) {
    console.error("sendWeChatMessage ret error:", data.ret, data.errmsg);
    return false;
  }
  return true;
}

function formatPushMessage(shipment, events, isInitial) {
  const icon = shipment.isCompleted ? "✅" : "📦";
  const header = isInitial
    ? `${icon} 已开启物流追踪【${shipment.statusText}】`
    : `${icon} 物流最新动态【${shipment.statusText}】`;
  const lines = [header];
  if (shipment.note) lines.push(`备注：${shipment.note}`);
  lines.push(`单号：${shipment.trackingNumber}（${shipment.carrierName}）`);
  if (shipment.estimatedDelivery && !shipment.isCompleted) {
    lines.push(`预计送达：${shipment.estimatedDelivery}`);
  }
  lines.push("──────────");
  for (const ev of [...events].reverse()) {
    lines.push(`🕒 ${ev.time}`);
    lines.push(`📍 ${ev.context}`);
  }
  if (shipment.isCompleted) {
    lines.push("──────────");
    lines.push("包裹已签收，云端自动停止轮询该单。");
  }
  return lines.join("\n");
}

function isInBeijingQuietHours(quietEnabled) {
  if (!quietEnabled) return false;
  // UTC+8 北京时间 00:30 ~ 07:00
  const bjNow = new Date(Date.now() + 8 * 3600 * 1000);
  const mins = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes();
  return mins >= 30 && mins < 420;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const { GIST_ID, GIST_TOKEN, STATE_KEY } = process.env;
  if (!GIST_ID || !GIST_TOKEN || !STATE_KEY) {
    throw new Error("缺少必需环境变量 GIST_ID / GIST_TOKEN / STATE_KEY");
  }

  const state = await loadCloudState(GIST_ID, GIST_TOKEN, STATE_KEY);
  let stateDirty = false;

  // 1. 同步微信发来的消息（即使在夜间也处理用户主动发来的微信消息）
  const prevBuf = state.clawBot.getUpdatesBuf;
  const { inboundTexts, newlyActivated } = await syncClawBotUpdates(state.clawBot);
  if (state.clawBot.getUpdatesBuf !== prevBuf || newlyActivated) {
    stateDirty = true;
  }

  for (const text of inboundTexts) {
    if (["查询", "列表", "状态", "快递", "物流"].includes(text)) {
      if (state.shipments.length === 0) {
        await sendWeChatMessage(
          state.clawBot,
          "📭 当前还没有监控中的包裹，直接把京东订单分享链接（https://3.cn/...）发给我即可。"
        );
      } else {
        const summary = state.shipments
          .slice(0, 8)
          .map((s) => {
            const ic = s.isCompleted ? "✅" : "🚚";
            const title = s.note || s.trackingNumber;
            const latest = s.tracks?.[0]?.context || "暂无轨迹";
            const eta = s.estimatedDelivery ? `\n└ 预计：${s.estimatedDelivery}` : "";
            return `${ic} ${title}（${s.statusText}）${eta}\n└ ${latest}`;
          })
          .join("\n\n");
        await sendWeChatMessage(state.clawBot, `📋 云端追踪列表（共 ${state.shipments.length} 单）：\n\n${summary}`);
      }
      continue;
    }

    if (state.settings.autoImportFromWeChat) {
      const shareUrl = extractJDShareURL(text);
      const plainCode = extractWaybillCandidate(text);
      if (shareUrl || plainCode) {
        let target = state.shipments.find(
          (s) => (shareUrl && s.jdShareUrl === shareUrl) || (plainCode && s.trackingNumber === plainCode)
        );
        if (!target) {
          const slug = shareUrl ? shareUrl.split("/").pop() : "";
          target = {
            id: crypto.randomUUID().toUpperCase(),
            trackingNumber: plainCode || `京东分享-${slug}`,
            jdShareUrl: shareUrl,
            jdShareData: extractShareDataFromURL(shareUrl),
            estimatedDelivery: "",
            note: "",
            phoneLast4: "",
            carrierName: "京东快递",
            statusText: "待查询",
            statusCode: "pending",
            isCompleted: false,
            autoTrackEnabled: true,
            tracks: [],
            notifiedFingerprints: [],
            lastCheckedAtMs: null,
            lastUpdatedAtMs: null,
            createdAtMs: Date.now(),
          };
          state.shipments.unshift(target);
          stateDirty = true;
        }
        try {
          const q = await queryShipment(target, state.settings.uapisApiKey);
          if (q.resolvedTrackingNumber) target.trackingNumber = q.resolvedTrackingNumber;
          if (q.resolvedShareData) target.jdShareData = q.resolvedShareData;
          if (q.estimatedDelivery) target.estimatedDelivery = q.estimatedDelivery;
          target.carrierName = q.carrierName;
          target.statusText = q.statusText;
          target.statusCode = q.statusCode;
          target.isCompleted = q.isCompleted;
          target.tracks = q.tracks;
          target.notifiedFingerprints = q.tracks.map((t) => `${t.time}|${t.context}`);
          target.lastCheckedAtMs = Date.now();
          target.lastUpdatedAtMs = Date.now();
          stateDirty = true;
          await sendWeChatMessage(state.clawBot, formatPushMessage(target, [q.tracks[0]], true));
        } catch (err) {
          await sendWeChatMessage(state.clawBot, `📦 已添加 ${target.trackingNumber}，暂未拉取到轨迹：${err.message}`);
        }
        continue;
      }
    }

    if (newlyActivated) {
      await sendWeChatMessage(
        state.clawBot,
        "✅ 24 小时免费云端物流巡检已激活！\n• 直接把京东订单分享链接（https://3.cn/...）发到这里即可自动监控\n• 发送「查询」可查看所有在途包裹"
      );
    }
  }

  if (inboundTexts.length === 0 && newlyActivated) {
    await sendWeChatMessage(state.clawBot, "✅ 24 小时免费云端物流巡检已激活！");
  }

  // 2. 巡检所有未签收包裹
  if (isInBeijingQuietHours(state.settings.quietHoursEnabled)) {
    console.log("当前处于夜间免打扰时段（00:30~07:00），跳过定时物流查询");
  } else {
    for (const s of state.shipments) {
      if (s.isCompleted || !s.autoTrackEnabled) continue;
      try {
        const q = await queryShipment(s, state.settings.uapisApiKey);
        const wasEmpty = (!s.tracks || s.tracks.length === 0) && (!s.notifiedFingerprints || s.notifiedFingerprints.length === 0);
        const known = new Set(s.notifiedFingerprints || []);
        const newEvents = q.tracks.filter((t) => !known.has(`${t.time}|${t.context}`));

        if (q.resolvedTrackingNumber) s.trackingNumber = q.resolvedTrackingNumber;
        if (q.resolvedShareData) s.jdShareData = q.resolvedShareData;
        if (q.estimatedDelivery) s.estimatedDelivery = q.estimatedDelivery;
        s.carrierName = q.carrierName;
        s.statusText = q.statusText;
        s.statusCode = q.statusCode;
        s.isCompleted = q.isCompleted;
        s.tracks = q.tracks;
        s.lastCheckedAtMs = Date.now();
        stateDirty = true;

        if (wasEmpty) {
          s.notifiedFingerprints = q.tracks.map((t) => `${t.time}|${t.context}`);
          s.lastUpdatedAtMs = Date.now();
          if (state.settings.pushOnInitialAdd && q.tracks[0]) {
            await sendWeChatMessage(state.clawBot, formatPushMessage(s, [q.tracks[0]], true));
          }
        } else if (newEvents.length > 0) {
          for (const t of q.tracks) known.add(`${t.time}|${t.context}`);
          s.notifiedFingerprints = Array.from(known);
          s.lastUpdatedAtMs = Date.now();
          console.log(`发现新物流动态 [${s.trackingNumber}]: ${newEvents[0].context}`);
          await sendWeChatMessage(state.clawBot, formatPushMessage(s, newEvents, false));
        } else {
          console.log(`无新增动态 [${s.trackingNumber}] (${s.statusText})`);
        }
      } catch (err) {
        console.error(`查询包裹失败 [${s.trackingNumber}]:`, err.message);
      }
    }
  }

  if (stateDirty) {
    await saveCloudState(state, GIST_ID, GIST_TOKEN, STATE_KEY);
    console.log("云端加密状态已更新保存");
  }
}

main().catch((err) => {
  console.error("巡检执行失败:", err);
  process.exit(1);
});
